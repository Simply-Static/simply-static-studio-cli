import { readFile } from "node:fs/promises";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CliError } from "./errors.js";
import { randomUsername } from "./random.js";
import { findUserByEmail } from "./users.js";
import { invokeFunction } from "./supabase.js";
import {
  assertReadableFileWithinLimit,
  assertSafeId,
  normalizeEmailList,
  parsePositiveInteger,
  requireAllowedValue,
} from "./validation.js";

const MAX_TEAM_EMAILS = 100;
const MAX_EMAIL_FILE_BYTES = 64 * 1024;
const WORDPRESS_ROLES = ["administrator", "editor", "author", "contributor", "subscriber"] as const;

export interface TeamMemberRecord {
  id: string | number;
  account_id?: string;
  member_id: string;
  created_at?: string;
  email?: string;
  [key: string]: unknown;
}

export interface TeamBulkInviteOptions {
  role?: string;
  inviteMissing?: boolean;
  maxEmails?: number;
}

export interface TeamInviteResult {
  email: string;
  status: "added" | "invited" | "skipped" | "error";
  userId?: string;
  sitesProcessed: number;
  message?: string;
}

interface OwnerSite {
  site_id: string | number;
  owner_account_id?: string | null;
}

export async function parseEmailInputFile(filePath: string, maxEmails = MAX_TEAM_EMAILS): Promise<string[]> {
  await assertReadableFileWithinLimit(filePath, MAX_EMAIL_FILE_BYTES);
  const raw = await readFile(filePath, "utf8");
  let values: string[];
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
      throw new CliError("Email JSON file must contain an array of strings.");
    }
    values = parsed;
  } else {
    values = trimmed.split(/[\s,;]+/).filter(Boolean);
  }
  return normalizeEmailList(values, { max: maxEmails });
}

export async function listTeamMembers(
  supabase: SupabaseClient,
  accountId: string,
): Promise<TeamMemberRecord[]> {
  const safeAccountId = assertSafeId(accountId, "accountId");
  const { data, error } = await supabase
    .from("account_member")
    .select("id, account_id, member_id, created_at")
    .eq("account_id", safeAccountId)
    .order("created_at", { ascending: true });
  if (error) throw new CliError(error.message);

  const members = (data || []) as TeamMemberRecord[];
  const memberIds = members.map((member) => member.member_id).filter(Boolean);
  if (memberIds.length === 0) return members;

  const { data: users, error: usersError } = await supabase.from("user").select("id, email").in("id", memberIds);
  if (usersError) throw new CliError(usersError.message);
  const emailById = new Map((users || []).map((user) => [user.id, user.email]));
  return members.map((member) => ({
    ...member,
    ...(emailById.get(member.member_id) ? { email: emailById.get(member.member_id) } : {}),
  }));
}

async function listOwnerSites(supabase: SupabaseClient, accountId: string): Promise<OwnerSite[]> {
  const { data, error } = await supabase
    .from("user_site")
    .select("site_id, owner_account_id")
    .eq("user_id", accountId);
  if (error) throw new CliError(error.message);
  return (data || []) as OwnerSite[];
}

async function addAccountMember(
  supabase: SupabaseClient,
  accountId: string,
  memberId: string,
): Promise<void> {
  const { error } = await supabase
    .from("account_member")
    .insert({ account_id: accountId, member_id: memberId });
  if (error && error.code !== "23505") {
    throw new CliError(error.message);
  }
}

async function grantSites(
  supabase: SupabaseClient,
  accountId: string,
  sites: OwnerSite[],
  email: string,
  role: string,
  options: { action: "add" | "invite"; userId?: string },
): Promise<number> {
  let processed = 0;
  for (const site of sites) {
    await invokeFunction(supabase, "manage-user", {
      site_id: site.site_id,
      email,
      username: randomUsername(),
      role,
      action: options.action,
      ...(options.userId ? { site_user_id: options.userId } : {}),
      owner_account_id: site.owner_account_id || accountId,
    });
    processed += 1;
  }
  return processed;
}

export async function bulkInviteTeamMembers(
  supabase: SupabaseClient,
  accountId: string,
  emails: string[],
  options: TeamBulkInviteOptions = {},
): Promise<TeamInviteResult[]> {
  const safeAccountId = assertSafeId(accountId, "accountId");
  const role = requireAllowedValue(options.role || "editor", WORDPRESS_ROLES, "role");
  const maxEmails = parsePositiveInteger(options.maxEmails ?? MAX_TEAM_EMAILS, "max emails", {
    min: 1,
    max: MAX_TEAM_EMAILS,
  });
  const normalizedEmails = normalizeEmailList(emails, { max: maxEmails });
  const ownerSites = await listOwnerSites(supabase, safeAccountId);
  const existingMembers = await listTeamMembers(supabase, safeAccountId);
  const existingMemberIds = new Set(existingMembers.map((member) => member.member_id));
  const results: TeamInviteResult[] = [];

  for (const email of normalizedEmails) {
    try {
      const user = await findUserByEmail(supabase, email);
      if (!user?.id) {
        if (!options.inviteMissing) {
          results.push({
            email,
            status: "skipped",
            sitesProcessed: 0,
            message: "No Studio user found. Re-run with --invite-missing to send site invites.",
          });
          continue;
        }

        const sitesProcessed = await grantSites(supabase, safeAccountId, ownerSites, email, role, {
          action: "invite",
        });
        const invitedUser = await findUserByEmail(supabase, email).catch(() => null);
        if (invitedUser?.id && invitedUser.id !== safeAccountId && !existingMemberIds.has(invitedUser.id)) {
          await addAccountMember(supabase, safeAccountId, invitedUser.id);
          existingMemberIds.add(invitedUser.id);
        }
        results.push({
          email,
          status: "invited",
          ...(invitedUser?.id ? { userId: invitedUser.id } : {}),
          sitesProcessed,
        });
        continue;
      }

      if (user.id === safeAccountId) {
        results.push({
          email,
          status: "skipped",
          userId: user.id,
          sitesProcessed: 0,
          message: "Cannot add the account owner as a team member.",
        });
        continue;
      }

      if (!existingMemberIds.has(user.id)) {
        await addAccountMember(supabase, safeAccountId, user.id);
        existingMemberIds.add(user.id);
      }

      const sitesProcessed = await grantSites(supabase, safeAccountId, ownerSites, email, role, {
        action: "add",
        userId: user.id,
      });
      results.push({
        email,
        status: "added",
        userId: user.id,
        sitesProcessed,
      });
    } catch (error) {
      results.push({
        email,
        status: "error",
        sitesProcessed: 0,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

export async function removeTeamMember(
  supabase: SupabaseClient,
  accountId: string,
  memberId: string,
  email?: string,
): Promise<{ removed: true; memberId: string; sitesProcessed: number }> {
  const safeAccountId = assertSafeId(accountId, "accountId");
  const safeMemberId = assertSafeId(memberId, "memberId");
  const ownerSites = await listOwnerSites(supabase, safeAccountId);
  let memberEmail = email;
  if (!memberEmail) {
    const { data, error } = await supabase.from("user").select("email").eq("id", safeMemberId).maybeSingle();
    if (error) throw new CliError(error.message);
    memberEmail = data?.email;
  }

  let sitesProcessed = 0;
  for (const site of ownerSites) {
    if (memberEmail) {
      await invokeFunction(supabase, "manage-user", {
        site_id: site.site_id,
        email: memberEmail,
        action: "delete",
        site_user_id: safeMemberId,
      });
    }
    const { error } = await supabase.from("user_site").delete().eq("user_id", safeMemberId).eq("site_id", site.site_id);
    if (error) throw new CliError(error.message);
    sitesProcessed += 1;
  }

  const { error } = await supabase
    .from("account_member")
    .delete()
    .eq("account_id", safeAccountId)
    .eq("member_id", safeMemberId);
  if (error) throw new CliError(error.message);

  return { removed: true, memberId: safeMemberId, sitesProcessed };
}

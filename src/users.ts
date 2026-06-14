import type { SupabaseClient } from "@supabase/supabase-js";
import { CliError } from "./errors.js";
import { invokeFunction } from "./supabase.js";
import { randomUsername } from "./random.js";
import { assertSafeId, normalizeEmail, requireAllowedValue } from "./validation.js";

const WORDPRESS_ROLES = ["administrator", "editor", "author", "contributor", "subscriber"] as const;

function normalizeRole(role: string): (typeof WORDPRESS_ROLES)[number] {
  return requireAllowedValue(role || "administrator", WORDPRESS_ROLES, "role");
}

export async function listUsers(supabase: SupabaseClient, siteId: string): Promise<unknown[]> {
  const safeSiteId = assertSafeId(siteId, "siteId");
  const { data, error } = await supabase
    .from("user_site")
    .select("user_id, email, admin, site_id")
    .eq("site_id", safeSiteId);
  if (error) throw new CliError(error.message);

  const base = data || [];
  const ids = base.map((row) => row.user_id).filter(Boolean);
  let confirmations: Record<string, { email_confirmed?: boolean; has_paid_subscription?: boolean }> = {};
  if (ids.length > 0) {
    try {
      const result = await invokeFunction<{ items?: { id: string; email_confirmed?: boolean; has_paid_subscription?: boolean }[] }>(
        supabase,
        "get-user-confirmations",
        { ids },
      );
      confirmations = Object.fromEntries((result.items || []).map((item) => [item.id, item]));
    } catch {
      confirmations = {};
    }
  }

  return base.map((row) => ({
    ...row,
    email_confirmed: row.user_id ? confirmations[row.user_id]?.email_confirmed !== false : false,
    has_paid_subscription: row.user_id ? Boolean(confirmations[row.user_id]?.has_paid_subscription) : false,
  }));
}

export async function findUserByEmail(
  supabase: SupabaseClient,
  email: string,
): Promise<{ id: string; email: string } | null> {
  const cleanEmail = normalizeEmail(email);
  const { data, error } = await supabase.from("user").select("id, email").eq("email", cleanEmail).maybeSingle();
  if (error) throw new CliError(error.message);
  return data as { id: string; email: string } | null;
}

async function findUserById(
  supabase: SupabaseClient,
  userId: string,
): Promise<{ id: string; email: string } | null> {
  const safeUserId = assertSafeId(userId, "userId");
  const { data, error } = await supabase.from("user").select("id, email").eq("id", safeUserId).maybeSingle();
  if (error) throw new CliError(error.message);
  return data as { id: string; email: string } | null;
}

async function resolveSiteUser(
  supabase: SupabaseClient,
  siteId: string,
  target: string,
  email?: string,
): Promise<{ userId?: string; email: string }> {
  const safeSiteId = assertSafeId(siteId, "siteId");
  const targetValue = String(target || "").trim();
  if (targetValue.includes("@")) {
    const cleanEmail = normalizeEmail(targetValue);
    const { data, error } = await supabase
      .from("user_site")
      .select("user_id, email")
      .eq("site_id", safeSiteId)
      .eq("email", cleanEmail)
      .maybeSingle();
    if (error) throw new CliError(error.message);
    return {
      ...((data as { user_id?: string } | null)?.user_id
        ? { userId: String((data as { user_id: string }).user_id) }
        : {}),
      email: cleanEmail,
    };
  }

  const safeUserId = assertSafeId(targetValue, "userId");
  const { data, error } = await supabase
    .from("user_site")
    .select("user_id, email")
    .eq("site_id", safeSiteId)
    .eq("user_id", safeUserId)
    .maybeSingle();
  if (error) throw new CliError(error.message);

  const row = data as { user_id?: string; email?: string } | null;
  const resolvedEmail = email ? normalizeEmail(email) : row?.email || (await findUserById(supabase, safeUserId))?.email;
  if (!resolvedEmail) {
    throw new CliError("Could not resolve user email. Provide --email or pass the user email as the user argument.");
  }

  return { userId: safeUserId, email: resolvedEmail };
}

export async function inviteUser(
  supabase: SupabaseClient,
  siteId: string,
  email: string,
  role: string,
  ownerAccountId?: string | null,
): Promise<unknown> {
  const safeSiteId = assertSafeId(siteId, "siteId");
  const cleanEmail = normalizeEmail(email);
  const ownerId = ownerAccountId ? assertSafeId(ownerAccountId, "ownerAccountId") : null;
  return invokeFunction(supabase, "manage-user", {
    site_id: safeSiteId,
    email: cleanEmail,
    username: randomUsername(),
    role: normalizeRole(role),
    action: "invite",
    owner_account_id: ownerId,
  });
}

export async function addExistingUser(
  supabase: SupabaseClient,
  siteId: string,
  email: string,
  role: string,
  siteUserId?: string,
  ownerAccountId?: string | null,
): Promise<unknown> {
  const safeSiteId = assertSafeId(siteId, "siteId");
  const cleanEmail = normalizeEmail(email);
  const ownerId = ownerAccountId ? assertSafeId(ownerAccountId, "ownerAccountId") : null;
  const user = siteUserId ? { id: assertSafeId(siteUserId, "userId") } : await findUserByEmail(supabase, cleanEmail);
  if (!user?.id) {
    throw new CliError("User was not found. Use `users invite` to invite by email.");
  }
  return invokeFunction(supabase, "manage-user", {
    site_id: safeSiteId,
    email: cleanEmail,
    username: randomUsername(),
    role: normalizeRole(role),
    action: "add",
    site_user_id: user.id,
    owner_account_id: ownerId,
  });
}

export async function removeUser(
  supabase: SupabaseClient,
  siteId: string,
  user: string,
  email?: string,
): Promise<unknown> {
  const safeSiteId = assertSafeId(siteId, "siteId");
  const resolved = await resolveSiteUser(supabase, safeSiteId, user, email);
  let userSiteQuery = supabase
    .from("user_site")
    .delete()
    .eq("site_id", safeSiteId);
  userSiteQuery = resolved.userId
    ? userSiteQuery.eq("user_id", resolved.userId)
    : userSiteQuery.eq("email", resolved.email);
  const { error: userSiteError } = await userSiteQuery;
  if (userSiteError) throw new CliError(userSiteError.message);

  await invokeFunction(supabase, "manage-user", {
    site_id: safeSiteId,
    email: resolved.email,
    role: "",
    action: "delete",
    ...(resolved.userId ? { site_user_id: resolved.userId } : {}),
  });

  const { error: metaError } = await supabase
    .from("site_meta")
    .delete()
    .eq("site_id", safeSiteId)
    .eq("email", resolved.email);
  if (metaError) throw new CliError(metaError.message);

  return { removed: true, siteId: safeSiteId, ...(resolved.userId ? { userId: resolved.userId } : {}), email: resolved.email };
}

export async function makeAdmin(
  supabase: SupabaseClient,
  siteId: string,
  user: string,
): Promise<unknown> {
  const safeSiteId = assertSafeId(siteId, "siteId");
  const resolved = await resolveSiteUser(supabase, safeSiteId, user);
  if (!resolved.userId) {
    throw new CliError("Could not resolve user ID for admin change.");
  }
  return invokeFunction(supabase, "manage-user", {
    site_id: safeSiteId,
    action: "swap-admin",
    site_user_id: resolved.userId,
  });
}

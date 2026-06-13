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
  userId: string,
  email: string,
): Promise<unknown> {
  const safeSiteId = assertSafeId(siteId, "siteId");
  const safeUserId = assertSafeId(userId, "userId");
  const cleanEmail = normalizeEmail(email);
  const { error: userSiteError } = await supabase
    .from("user_site")
    .delete()
    .eq("site_id", safeSiteId)
    .eq("user_id", safeUserId);
  if (userSiteError) throw new CliError(userSiteError.message);

  await invokeFunction(supabase, "manage-user", {
    site_id: safeSiteId,
    email: cleanEmail,
    role: "",
    action: "delete",
    site_user_id: safeUserId,
  });

  const { error: metaError } = await supabase
    .from("site_meta")
    .delete()
    .eq("site_id", safeSiteId)
    .eq("email", cleanEmail);
  if (metaError) throw new CliError(metaError.message);

  return { removed: true, siteId: safeSiteId, userId: safeUserId, email: cleanEmail };
}

export async function makeAdmin(
  supabase: SupabaseClient,
  siteId: string,
  userId: string,
): Promise<unknown> {
  const safeSiteId = assertSafeId(siteId, "siteId");
  const safeUserId = assertSafeId(userId, "userId");
  return invokeFunction(supabase, "manage-user", {
    site_id: safeSiteId,
    action: "swap-admin",
    site_user_id: safeUserId,
  });
}

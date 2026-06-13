import type { SupabaseClient } from "@supabase/supabase-js";
import { CliError } from "./errors.js";
import { invokeFunction } from "./supabase.js";
import { randomUsername } from "./random.js";

export async function listUsers(supabase: SupabaseClient, siteId: string): Promise<unknown[]> {
  const { data, error } = await supabase
    .from("user_site")
    .select("user_id, email, admin, site_id")
    .eq("site_id", siteId);
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
  const { data, error } = await supabase.from("user").select("id, email").eq("email", email).maybeSingle();
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
  return invokeFunction(supabase, "manage-user", {
    site_id: siteId,
    email,
    username: randomUsername(),
    role,
    action: "invite",
    owner_account_id: ownerAccountId || null,
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
  const user = siteUserId ? { id: siteUserId } : await findUserByEmail(supabase, email);
  if (!user?.id) {
    throw new CliError("User was not found. Use `users invite` to invite by email.");
  }
  return invokeFunction(supabase, "manage-user", {
    site_id: siteId,
    email,
    username: randomUsername(),
    role,
    action: "add",
    site_user_id: user.id,
    owner_account_id: ownerAccountId || null,
  });
}

export async function removeUser(
  supabase: SupabaseClient,
  siteId: string,
  userId: string,
  email: string,
): Promise<unknown> {
  const { error: userSiteError } = await supabase
    .from("user_site")
    .delete()
    .eq("site_id", siteId)
    .eq("user_id", userId);
  if (userSiteError) throw new CliError(userSiteError.message);

  await invokeFunction(supabase, "manage-user", {
    site_id: siteId,
    email,
    role: "",
    action: "delete",
    site_user_id: userId,
  });

  const { error: metaError } = await supabase
    .from("site_meta")
    .delete()
    .eq("site_id", siteId)
    .eq("email", email);
  if (metaError) throw new CliError(metaError.message);

  return { removed: true, siteId, userId, email };
}

export async function makeAdmin(
  supabase: SupabaseClient,
  siteId: string,
  userId: string,
): Promise<unknown> {
  return invokeFunction(supabase, "manage-user", {
    site_id: siteId,
    action: "swap-admin",
    site_user_id: userId,
  });
}

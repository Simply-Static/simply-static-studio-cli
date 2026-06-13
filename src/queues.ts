import type { SupabaseClient } from "@supabase/supabase-js";
import { invokeFunction } from "./supabase.js";
import { assertSafeId, parsePositiveInteger } from "./validation.js";

export async function listBackups(
  supabase: SupabaseClient,
  siteId: string,
  refresh = false,
): Promise<unknown> {
  return invokeFunction(supabase, "list-backups", { siteId: assertSafeId(siteId, "siteId"), refresh });
}

export async function queueBackup(
  supabase: SupabaseClient,
  action: "create" | "delete" | "restore" | "sync",
  siteId: string,
  options: { date?: string; backupId?: string } = {},
): Promise<unknown> {
  const safeSiteId = assertSafeId(siteId, "siteId");
  return invokeFunction(supabase, "queue-backup", {
    action,
    siteId: safeSiteId,
    date: options.date,
    backupId: options.backupId,
  });
}

export async function getSshInfo(supabase: SupabaseClient, userId: string): Promise<unknown> {
  return invokeFunction(supabase, "get-ssh-keys", { userId: assertSafeId(userId, "userId") });
}

export async function queueSshKey(
  supabase: SupabaseClient,
  action: "add-ssh-key" | "add-ssh-key-to-site" | "remove-ssh-key-to-site",
  siteId: string,
  userId: string,
  options: { publicKey?: string; keyId?: string | number } = {},
): Promise<unknown> {
  const safeSiteId = assertSafeId(siteId, "siteId");
  const safeUserId = assertSafeId(userId, "userId");
  const keyId = options.keyId !== undefined ? parsePositiveInteger(options.keyId, "keyId") : undefined;
  return invokeFunction(supabase, "queue-ssh-key", {
    action,
    siteId: safeSiteId,
    userId: safeUserId,
    publicKey: options.publicKey,
    keyId,
  });
}

export async function deleteSshKey(
  supabase: SupabaseClient,
  userId: string,
  keyId: string,
): Promise<unknown> {
  return invokeFunction(supabase, "delete-ssh-key", {
    userId: assertSafeId(userId, "userId"),
    keyId: assertSafeId(keyId, "keyId"),
  });
}

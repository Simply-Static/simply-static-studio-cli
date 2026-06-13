import type { SupabaseClient } from "@supabase/supabase-js";
import { invokeFunction } from "./supabase.js";

export async function listBackups(
  supabase: SupabaseClient,
  siteId: string,
  refresh = false,
): Promise<unknown> {
  return invokeFunction(supabase, "list-backups", { siteId, refresh });
}

export async function queueBackup(
  supabase: SupabaseClient,
  action: "create" | "delete" | "restore" | "sync",
  siteId: string,
  options: { date?: string; backupId?: string } = {},
): Promise<unknown> {
  return invokeFunction(supabase, "queue-backup", {
    action,
    siteId,
    date: options.date,
    backupId: options.backupId,
  });
}

export async function getSshInfo(supabase: SupabaseClient, userId: string): Promise<unknown> {
  return invokeFunction(supabase, "get-ssh-keys", { userId });
}

export async function queueSshKey(
  supabase: SupabaseClient,
  action: "add-ssh-key" | "add-ssh-key-to-site" | "remove-ssh-key-to-site",
  siteId: string,
  userId: string,
  options: { publicKey?: string; keyId?: string | number } = {},
): Promise<unknown> {
  return invokeFunction(supabase, "queue-ssh-key", {
    action,
    siteId,
    userId,
    publicKey: options.publicKey,
    keyId: options.keyId ? Number(options.keyId) : undefined,
  });
}

export async function deleteSshKey(
  supabase: SupabaseClient,
  userId: string,
  keyId: string,
): Promise<unknown> {
  return invokeFunction(supabase, "delete-ssh-key", {
    userId,
    keyId,
  });
}

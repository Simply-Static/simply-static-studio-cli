import type { SupabaseClient } from "@supabase/supabase-js";
import { PLATFORM_HOSTING_PROVIDER } from "./constants.js";
import { CliError } from "./errors.js";
import { getSite } from "./sites.js";
import { invokeFunction, invokeIdempotentFunction } from "./supabase.js";
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
  options: {
    date?: string;
    backupId?: string;
    userId?: string;
    requestId?: string;
  } = {},
): Promise<unknown> {
  const safeSiteId = assertSafeId(siteId, "siteId");
  const site = await getSite(supabase, safeSiteId);
  if (site.hosting_provider === PLATFORM_HOSTING_PROVIDER) {
    if (action === "sync") {
      throw new CliError(
        "Docker backups are read directly and do not use SpinupWP reconciliation.",
      );
    }
    const requestId = options.requestId || crypto.randomUUID();
    return invokeIdempotentFunction(supabase, "platform-backups", {
      action,
      siteId: safeSiteId,
      ...(options.backupId ? { backupId: options.backupId } : {}),
      requestId,
    });
  }
  return invokeFunction(supabase, "queue-backup", {
    action,
    siteId: safeSiteId,
    ...(options.userId ? { userId: options.userId } : {}),
    date: options.date,
    backupId: options.backupId,
  });
}

export async function getPlatformBackup(
  supabase: SupabaseClient,
  siteId: string,
  backupId: string,
): Promise<unknown> {
  return invokeFunction(supabase, "platform-backups", {
    action: "status",
    siteId: assertSafeId(siteId, "siteId"),
    backupId: assertSafeId(backupId, "backupId"),
  });
}

export async function getPlatformBackupDownload(
  supabase: SupabaseClient,
  siteId: string,
  backupId: string,
): Promise<unknown> {
  return invokeFunction(supabase, "platform-backups", {
    action: "download",
    siteId: assertSafeId(siteId, "siteId"),
    backupId: assertSafeId(backupId, "backupId"),
  });
}

export async function copyPlatformBackup(
  supabase: SupabaseClient,
  siteId: string,
  backupId: string,
  targetSiteId: string,
): Promise<unknown> {
  return invokeIdempotentFunction(supabase, "platform-backups", {
    action: "copy-site",
    siteId: assertSafeId(siteId, "siteId"),
    backupId: assertSafeId(backupId, "backupId"),
    targetSiteId: assertSafeId(targetSiteId, "targetSiteId"),
    requestId: crypto.randomUUID(),
  });
}

export async function getPlatformBackupPolicy(
  supabase: SupabaseClient,
  siteId: string,
): Promise<unknown> {
  return invokeFunction(supabase, "platform-backup-policy", {
    action: "get",
    siteId: assertSafeId(siteId, "siteId"),
  });
}

export async function updatePlatformBackupPolicy(
  supabase: SupabaseClient,
  siteId: string,
  cadence: "daily" | "weekly",
): Promise<unknown> {
  return invokeFunction(supabase, "platform-backup-policy", {
    action: "update",
    siteId: assertSafeId(siteId, "siteId"),
    cadence,
  });
}

export async function getSshInfo(
  supabase: SupabaseClient,
  userId: string,
  siteId?: string,
): Promise<unknown> {
  return invokeFunction(supabase, "get-ssh-keys", {
    userId: assertSafeId(userId, "userId"),
    ...(siteId ? { siteId: assertSafeId(siteId, "siteId") } : {}),
  });
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

export async function retrySftpReconciliation(
  supabase: SupabaseClient,
  siteId: string,
  userId: string,
): Promise<unknown> {
  return invokeFunction(supabase, "queue-ssh-key", {
    action: "retry-sftp-reconcile",
    siteId: assertSafeId(siteId, "siteId"),
    userId: assertSafeId(userId, "userId"),
  });
}

import type { SupabaseClient } from "@supabase/supabase-js";
import { CliError } from "./errors.js";
import { invokeFunction, invokeIdempotentFunction } from "./supabase.js";
import { assertSafeId, parsePositiveInteger } from "./validation.js";

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function platformBackupRequestId(value?: string): string {
  const requestId = value === undefined ? crypto.randomUUID() : String(value).trim();
  if (!UUID_V4_RE.test(requestId)) {
    throw new CliError("requestId must be a canonical lowercase UUIDv4.");
  }
  return requestId;
}

export async function listBackups(
  supabase: SupabaseClient,
  siteId: string,
): Promise<unknown> {
  return invokeFunction(supabase, "platform-backups", {
    action: "list",
    siteId: assertSafeId(siteId, "siteId"),
  });
}

export async function queueBackup(
  supabase: SupabaseClient,
  action: "create" | "delete" | "restore",
  siteId: string,
  options: {
    backupId?: string;
    requestId?: string;
  } = {},
): Promise<unknown> {
  const safeSiteId = assertSafeId(siteId, "siteId");
  const backupId = options.backupId
    ? assertSafeId(options.backupId, "backupId")
    : undefined;
  if (action !== "create" && !backupId) {
    throw new CliError(`backupId is required to ${action} a backup.`);
  }

  return invokeIdempotentFunction(supabase, "platform-backups", {
    action,
    siteId: safeSiteId,
    ...(backupId ? { backupId } : {}),
    requestId: platformBackupRequestId(options.requestId),
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
    requestId: platformBackupRequestId(),
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

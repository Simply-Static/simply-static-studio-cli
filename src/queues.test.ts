import { describe, expect, it } from "vitest";
import {
  copyPlatformBackup,
  getPlatformBackup,
  getPlatformBackupDownload,
  getPlatformBackupPolicy,
  getSshInfo,
  listBackups,
  queueBackup,
  retrySftpReconciliation,
  updatePlatformBackupPolicy,
} from "./queues.js";
import { createSupabaseMock } from "./test-utils.js";

describe("platform backups", () => {
  it("reads the current snapshot from the consolidated platform API", async () => {
    const { supabase, functionCalls, calls } = createSupabaseMock({}, { ok: true });

    await listBackups(supabase, "42");

    expect(functionCalls).toEqual([{
      name: "platform-backups",
      body: { action: "list", siteId: "42" },
    }]);
    expect(calls).toEqual([]);
  });

  it("queues creation through the idempotent consolidated API", async () => {
    const { supabase, functionCalls, calls } = createSupabaseMock(
      {},
      { ok: true, provider: "static-studio-docker" },
    );

    await queueBackup(supabase, "create", "42");

    expect(functionCalls).toHaveLength(1);
    expect(functionCalls[0]?.name).toBe("platform-backups");
    expect(functionCalls[0]?.body).toMatchObject({
      action: "create",
      siteId: "42",
    });
    expect((functionCalls[0]?.body as { requestId?: string }).requestId)
      .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(calls).toEqual([]);
  });

  it("preserves a caller request ID for restore", async () => {
    const { supabase, functionCalls } = createSupabaseMock({}, { ok: true });
    const backupId = "11111111-1111-4111-8111-111111111111";
    const requestId = "22222222-2222-4222-8222-222222222222";

    await queueBackup(supabase, "restore", "9", {
      backupId,
      requestId,
    });

    expect(functionCalls).toEqual([{
      name: "platform-backups",
      body: {
        action: "restore",
        siteId: "9",
        backupId,
        requestId,
      },
    }]);
  });

  it("requires an artifact ID for delete and restore", async () => {
    const { supabase, functionCalls } = createSupabaseMock({});

    await expect(queueBackup(supabase, "delete", "42"))
      .rejects.toThrow("backupId is required");
    await expect(queueBackup(supabase, "restore", "42"))
      .rejects.toThrow("backupId is required");
    expect(functionCalls).toEqual([]);
  });

  it("exposes status, download, copy, and automated policy contracts", async () => {
    const { supabase, functionCalls } = createSupabaseMock(
      {},
      { ok: true },
    );
    const backupId = "11111111-1111-4111-8111-111111111111";

    await getPlatformBackup(supabase, "42", backupId);
    await getPlatformBackupDownload(supabase, "42", backupId);
    await copyPlatformBackup(supabase, "42", backupId, "43");
    await getPlatformBackupPolicy(supabase, "42");
    await updatePlatformBackupPolicy(supabase, "42", "daily");

    expect(functionCalls.map((call) => call.name)).toEqual([
      "platform-backups",
      "platform-backups",
      "platform-backups",
      "platform-backup-policy",
      "platform-backup-policy",
    ]);
    expect(functionCalls[0]?.body).toEqual({
      action: "status",
      siteId: "42",
      backupId,
    });
    expect(functionCalls[2]?.body).toMatchObject({
      action: "copy-site",
      siteId: "42",
      backupId,
      targetSiteId: "43",
    });
    expect(functionCalls[4]?.body).toEqual({
      action: "update",
      siteId: "42",
      cadence: "daily",
    });
  });
});

describe("provider-aware SFTP", () => {
  it("requests the provider-bound site connection snapshot", async () => {
    const { supabase, functionCalls } = createSupabaseMock({}, { ok: true });

    await getSshInfo(supabase, "user-1", "42");
    await retrySftpReconciliation(supabase, "42", "user-1");

    expect(functionCalls).toEqual([
      {
        name: "get-ssh-keys",
        body: { userId: "user-1", siteId: "42" },
      },
      {
        name: "queue-ssh-key",
        body: {
          action: "retry-sftp-reconcile",
          siteId: "42",
          userId: "user-1",
        },
      },
    ]);
  });
});

import { describe, expect, it } from "vitest";
import {
  copyPlatformBackup,
  getPlatformBackupDownload,
  getPlatformBackupPolicy,
  getSshInfo,
  queueBackup,
  retrySftpReconciliation,
  updatePlatformBackupPolicy,
} from "./queues.js";
import { createSupabaseMock } from "./test-utils.js";

describe("provider-aware backups", () => {
  it("routes Docker mutations through the idempotent platform API", async () => {
    const { supabase, functionCalls } = createSupabaseMock(
      {
        site: {
          data: { id: "42", hosting_provider: "static-studio-docker" },
          error: null,
        },
      },
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
      .toMatch(/^[0-9a-f-]{36}$/);
  });

  it("keeps legacy backup queue payloads for existing SpinupWP sites", async () => {
    const { supabase, functionCalls } = createSupabaseMock(
      {
        site: {
          data: { id: "9", hosting_provider: "spinupwp" },
          error: null,
        },
      },
      { ok: true },
    );

    await queueBackup(supabase, "restore", "9", {
      backupId: "legacy-backup",
      date: "29 Jul 2026",
      userId: "user-1",
    });

    expect(functionCalls).toEqual([{
      name: "queue-backup",
      body: {
        action: "restore",
        siteId: "9",
        userId: "user-1",
        date: "29 Jul 2026",
        backupId: "legacy-backup",
      },
    }]);
  });

  it("rejects legacy synchronization for Docker backup snapshots", async () => {
    const { supabase, functionCalls } = createSupabaseMock({
      site: {
        data: { id: "42", hosting_provider: "static-studio-docker" },
        error: null,
      },
    });

    await expect(queueBackup(supabase, "sync", "42"))
      .rejects.toThrow("read directly");
    expect(functionCalls).toEqual([]);
  });

  it("exposes Docker download, copy, and automated policy contracts", async () => {
    const { supabase, functionCalls } = createSupabaseMock(
      {},
      { ok: true },
    );
    const backupId = "11111111-1111-4111-8111-111111111111";

    await getPlatformBackupDownload(supabase, "42", backupId);
    await copyPlatformBackup(supabase, "42", backupId, "43");
    await getPlatformBackupPolicy(supabase, "42");
    await updatePlatformBackupPolicy(supabase, "42", "daily");

    expect(functionCalls.map((call) => call.name)).toEqual([
      "platform-backups",
      "platform-backups",
      "platform-backup-policy",
      "platform-backup-policy",
    ]);
    expect(functionCalls[1]?.body).toMatchObject({
      action: "copy-site",
      siteId: "42",
      backupId,
      targetSiteId: "43",
    });
    expect(functionCalls[3]?.body).toEqual({
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

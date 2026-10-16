import { describe, expect, it } from "vitest";
import {
  cancelExport,
  getRollbackStatus,
  listProductionSiteReleases,
  listRollbackSnapshots,
  startRollback,
} from "./deployments.js";
import { createSupabaseMock } from "./test-utils.js";

describe("deployment operations", () => {
  it("invokes the cancel-export contract", async () => {
    const { supabase, functionCalls } = createSupabaseMock({}, { status: "cancelling" });

    await expect(cancelExport(supabase, "42")).resolves.toEqual({ status: "cancelling" });

    expect(functionCalls).toEqual([
      { name: "cancel-export", body: { site_id: "42" } },
    ]);
  });

  it("lists only production releases newest first with a bounded limit", async () => {
    const releases = [
      { id: "release-1", site_id: "42", release_id: "deploy-1", environment: "production", status: "successful" },
    ];
    const { supabase, calls } = createSupabaseMock({
      site_release: { data: releases, error: null },
    });

    await expect(listProductionSiteReleases(supabase, "42", 25)).resolves.toEqual(releases);
    expect(calls).toEqual([
      { table: "site_release", method: "select", args: ["*"] },
      { table: "site_release", method: "eq", args: ["site_id", "42"] },
      { table: "site_release", method: "eq", args: ["environment", "production"] },
      { table: "site_release", method: "order", args: ["created_at", { ascending: false }] },
      { table: "site_release", method: "limit", args: [25] },
    ]);
  });

  it("rejects release limits outside the supported range before querying", async () => {
    const { supabase, calls } = createSupabaseMock({});

    await expect(listProductionSiteReleases(supabase, "42", 101)).rejects.toThrow(
      "limit must be an integer between 1 and 100",
    );
    expect(calls).toEqual([]);
  });

  it("unwraps rollback status and exposes its available snapshot list", async () => {
    const status = {
      available: true,
      snapshots: [{ id: "snapshot-1", snapshot_id: "snapshot-1" }],
      status: null,
      max_snapshots: 3,
      error: null,
    };
    const { supabase, functionCalls } = createSupabaseMock({}, { data: status, error: null });

    await expect(getRollbackStatus(supabase, "42")).resolves.toEqual(status);
    await expect(listRollbackSnapshots(supabase, "42")).resolves.toEqual(status.snapshots);
    expect(functionCalls).toEqual([
      { name: "rollback-static-export", body: { site_id: "42", action: "status" } },
      { name: "rollback-static-export", body: { site_id: "42", action: "status" } },
    ]);
  });

  it("starts a rollback with validated site and snapshot IDs", async () => {
    const { supabase, functionCalls } = createSupabaseMock(
      {},
      { data: { rollback: { status: "running" } }, error: null },
    );

    await expect(startRollback(supabase, "42", "snapshot-abc_123")).resolves.toEqual({
      rollback: { status: "running" },
    });
    expect(functionCalls).toEqual([
      {
        name: "rollback-static-export",
        body: { site_id: "42", snapshot_id: "snapshot-abc_123" },
      },
    ]);
  });

  it("does not invoke rollback for unsafe IDs", async () => {
    const { supabase, functionCalls } = createSupabaseMock({});

    await expect(startRollback(supabase, "42", "../../snapshot")).rejects.toThrow(
      "snapshotId must contain only letters, numbers, underscores, and hyphens",
    );
    expect(functionCalls).toEqual([]);
  });
});

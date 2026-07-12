import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bulkCreateRedirects,
  deleteRedirect,
  refreshRedirectRules,
  setRedirectActive,
  updateRedirect,
} from "./redirects.js";
import { createSupabaseMock } from "./test-utils.js";

const refreshSuccess = {
  results: [{ siteId: "site-1", status: "success" }],
};

describe("bulkCreateRedirects", () => {
  it("validates redirect files before invoking the backend", async () => {
    const filePath = join(tmpdir(), `redirects-${Date.now()}.json`);
    writeFileSync(filePath, JSON.stringify([{ fromPath: "/old" }]));
    const { supabase, functionCalls } = createSupabaseMock({
      site: {
        data: { id: "site-1", url: "https://example.test", pull_zone_id: "pull-1" },
        error: null,
      },
    });

    await expect(bulkCreateRedirects(supabase, "site-1", filePath)).rejects.toThrow(
      "fromPath and toPath",
    );
    expect(functionCalls).toEqual([]);
  });
});

describe("updateRedirect", () => {
  it("updates DB-backed redirects and refreshes edge rules without importing stale CDN rules", async () => {
    const { supabase, functionCalls } = createSupabaseMock({}, refreshSuccess);

    await updateRedirect(supabase, "site-1", "10", {
      fromPath: " /old ",
      toPath: "/new",
    });

    expect(functionCalls).toEqual([
      {
        name: "update-redirect",
        body: {
          siteId: "site-1",
          redirectId: "10",
          fromPath: "/old",
          toPath: "/new",
        },
      },
      {
        name: "refresh-edge-rules",
        body: {
          siteId: "site-1",
          importExistingRedirects: false,
        },
      },
    ]);
  });

  it("requires at least one field to update", async () => {
    const { supabase, functionCalls } = createSupabaseMock({}, refreshSuccess);

    await expect(updateRedirect(supabase, "site-1", "10", {})).rejects.toThrow(
      "at least one redirect field",
    );
    expect(functionCalls).toEqual([]);
  });
});

describe("setRedirectActive", () => {
  it("updates the persisted redirect status", async () => {
    const { supabase, functionCalls } = createSupabaseMock({}, refreshSuccess);

    await setRedirectActive(supabase, "site-1", "10", false);

    expect(functionCalls[0]).toEqual({
      name: "update-redirect",
      body: {
        siteId: "site-1",
        redirectId: "10",
        isActive: false,
      },
    });
  });
});

describe("deleteRedirect", () => {
  it("deletes DB-backed redirects and refreshes edge rules without importing stale CDN rules", async () => {
    const { supabase, functionCalls } = createSupabaseMock({}, refreshSuccess);

    await deleteRedirect(supabase, "site-1", "10", { db: true });

    expect(functionCalls).toEqual([
      {
        name: "delete-redirect",
        body: {
          siteId: "site-1",
          redirectId: "10",
        },
      },
      {
        name: "refresh-edge-rules",
        body: {
          siteId: "site-1",
          importExistingRedirects: false,
        },
      },
    ]);
  });

  it("does not fall back to legacy edge rules when a default redirect cannot be deleted", async () => {
    const { supabase, functionCalls } = createSupabaseMock(
      {
        redirects: {
          data: { id: "10", is_default: true },
          error: null,
        },
      },
      (name) =>
        name === "delete-redirect"
          ? { error: "Redirect not found or cannot be deleted." }
          : name === "refresh-edge-rules"
            ? refreshSuccess
            : { ok: true },
    );

    await expect(deleteRedirect(supabase, "site-1", "10")).rejects.toThrow(
      "Redirect not found or cannot be deleted.",
    );
    expect(functionCalls).toEqual([
      {
        name: "delete-redirect",
        body: {
          siteId: "site-1",
          redirectId: "10",
        },
      },
    ]);
  });

  it("falls back to legacy CDN edge rules when the DB redirect is missing", async () => {
    const { supabase, functionCalls } = createSupabaseMock(
      {
        redirects: { data: null, error: null },
        site: {
          data: { id: "site-1", url: "https://example.test", pull_zone_id: "pull-1" },
          error: null,
        },
      },
      (name) =>
        name === "delete-redirect"
          ? { error: "Redirect not found or cannot be deleted." }
          : name === "refresh-edge-rules"
            ? refreshSuccess
            : { ok: true },
    );

    await deleteRedirect(supabase, "site-1", "rule-1");

    expect(functionCalls).toEqual([
      {
        name: "delete-redirect",
        body: {
          siteId: "site-1",
          redirectId: "rule-1",
        },
      },
      {
        name: "disable-redirect",
        body: {
          pullZoneId: "pull-1",
          ruleId: "rule-1",
          siteId: "site-1",
        },
      },
      {
        name: "refresh-edge-rules",
        body: {
          siteId: "site-1",
          importExistingRedirects: true,
        },
      },
    ]);
  });

  it("can still disable legacy CDN edge rule IDs", async () => {
    const { supabase, functionCalls } = createSupabaseMock({
      site: {
        data: { id: "site-1", url: "https://example.test", pull_zone_id: "pull-1" },
        error: null,
      },
    }, refreshSuccess);

    await deleteRedirect(supabase, "site-1", "rule-1", { edgeRule: true });

    expect(functionCalls).toEqual([
      {
        name: "disable-redirect",
        body: {
          pullZoneId: "pull-1",
          ruleId: "rule-1",
          siteId: "site-1",
        },
      },
      {
        name: "refresh-edge-rules",
        body: {
          siteId: "site-1",
          importExistingRedirects: true,
        },
      },
    ]);
  });
});

describe("refreshRedirectRules", () => {
  it("passes through the importExistingRedirects option", async () => {
    const { supabase, functionCalls } = createSupabaseMock({}, refreshSuccess);

    await refreshRedirectRules(supabase, "site-1", { importExistingRedirects: true });

    expect(functionCalls).toEqual([
      {
        name: "refresh-edge-rules",
        body: {
          siteId: "site-1",
          importExistingRedirects: true,
        },
      },
    ]);
  });

  it("surfaces per-site Lagos refresh failures instead of reporting success", async () => {
    const { supabase } = createSupabaseMock({}, {
      results: [{
        siteId: "site-1",
        status: "partial",
        error: "Could not update all rules",
        defaultRuleErrors: ["Markdown rule failed"],
      }],
    });

    await expect(
      refreshRedirectRules(supabase, "site-1", { importExistingRedirects: true }),
    ).rejects.toThrow("Could not update all rules; Markdown rule failed");
  });

  it("rejects a success-shaped response that omits the requested site", async () => {
    const { supabase } = createSupabaseMock({}, { message: "No sites found to refresh." });

    await expect(refreshRedirectRules(supabase, "site-1"))
      .rejects.toThrow("did not return a result for site site-1");
  });
});

describe("legacy edge-rule failure handling", () => {
  it("does not refresh after disable-redirect reports a warning response", async () => {
    const { supabase, functionCalls } = createSupabaseMock(
      {
        site: {
          data: { id: "site-1", url: "https://example.test", pull_zone_id: "pull-1" },
          error: null,
        },
      },
      (name) => name === "disable-redirect"
        ? { success: false, warning: { details: "Bunny kept the edge rule." } }
        : { ok: true },
    );

    await expect(
      deleteRedirect(supabase, "site-1", "rule-1", { edgeRule: true }),
    ).rejects.toThrow("Bunny kept the edge rule.");
    expect(functionCalls.map((call) => call.name)).toEqual(["disable-redirect"]);
  });
});

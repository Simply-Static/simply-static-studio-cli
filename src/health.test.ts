import { describe, expect, it } from "vitest";
import {
  MAX_HEALTH_SITES_PER_RUN,
  MAX_SEO_FILE_BYTES,
  applySeoFiles,
  checkSitemaps,
  deleteSeoFile,
  disableIndexNow,
  enableIndexNow,
  getHealthOverview,
  getIndexNowStatus,
  listSeoFiles,
  normalizeSeoFilePath,
  runHealthCheck,
  saveSeoFile,
  setIndexNowAutoSubmit,
  submitIndexNow,
} from "./health.js";
import { createSupabaseMock } from "./test-utils.js";

describe("getHealthOverview", () => {
  it("loads the latest manifest, current health state, recent rows, and its diff", async () => {
    const { supabase, calls } = createSupabaseMock((table) => {
      if (table === "site_deploy_manifest") {
        return { data: { id: "manifest-1", site_id: 12 }, error: null };
      }
      if (table === "site_health_snapshot") {
        return { data: { site_id: 12, overall_status: "healthy" }, error: null };
      }
      if (table === "site_health_issue") {
        return { data: [{ id: "issue-1", site_id: 12, status: "open" }], error: null };
      }
      if (table === "site_health_result") {
        return { data: [{ id: "result-1", site_id: 12 }], error: null };
      }
      if (table === "site_release") {
        return { data: [{ id: "release-1", site_id: 12 }], error: null };
      }
      if (table === "site_deploy_diff") {
        return {
          data: { id: "diff-1", site_id: 12, to_manifest_id: "manifest-1" },
          error: null,
        };
      }
      return { data: null, error: null };
    });

    const overview = await getHealthOverview(supabase, "12", {
      issueLimit: 5,
      resultLimit: 6,
      releaseLimit: 7,
    });

    expect(overview).toMatchObject({
      siteId: "12",
      latestManifest: { id: "manifest-1" },
      snapshot: { overall_status: "healthy" },
      openIssues: [{ id: "issue-1" }],
      recentResults: [{ id: "result-1" }],
      recentReleases: [{ id: "release-1" }],
      latestDiff: { id: "diff-1" },
    });
    expect(calls).toContainEqual({
      table: "site_health_issue",
      method: "eq",
      args: ["status", "open"],
    });
    expect(calls).toContainEqual({ table: "site_health_issue", method: "limit", args: [5] });
    expect(calls).toContainEqual({ table: "site_health_result", method: "limit", args: [6] });
    expect(calls).toContainEqual({ table: "site_release", method: "limit", args: [7] });
    expect(calls).toContainEqual({
      table: "site_deploy_diff",
      method: "eq",
      args: ["to_manifest_id", "manifest-1"],
    });
  });

  it("skips the diff query when no deploy manifest exists", async () => {
    const { supabase, calls } = createSupabaseMock((table) => ({
      data: table === "site_deploy_manifest" ? null : [],
      error: null,
    }));

    const overview = await getHealthOverview(supabase, "12");

    expect(overview.latestManifest).toBeNull();
    expect(overview.latestDiff).toBeNull();
    expect(calls.some((call) => call.table === "site_deploy_diff")).toBe(false);
  });

  it("rejects unbounded overview limits before querying", async () => {
    const { supabase, calls } = createSupabaseMock({});

    await expect(getHealthOverview(supabase, "12", { resultLimit: 101 })).rejects.toThrow(
      "result limit must be an integer between 1 and 100",
    );
    expect(calls).toEqual([]);
  });
});

describe("runHealthCheck", () => {
  it("sends only allowed, deduplicated check types and site IDs", async () => {
    const { supabase, functionCalls } = createSupabaseMock({}, {
      checked: 2,
      failed: 0,
      results: [],
    });

    await runHealthCheck(supabase, ["12", "12", "13"], ["uptime", "ssl", "uptime"]);

    expect(functionCalls).toEqual([
      {
        name: "site-health-check",
        body: {
          site_ids: ["12", "13"],
          check_types: ["uptime", "ssl"],
        },
      },
    ]);
  });

  it("uses the singular Edge Function contract when given one site ID", async () => {
    const { supabase, functionCalls } = createSupabaseMock({}, {
      checked: 1,
      failed: 0,
      results: [],
    });

    await runHealthCheck(supabase, "12");

    expect(functionCalls[0]).toEqual({
      name: "site-health-check",
      body: { site_id: "12" },
    });
  });

  it("rejects unsupported checks and batches larger than the backend limit", async () => {
    const { supabase, functionCalls } = createSupabaseMock({});

    await expect(runHealthCheck(supabase, "12", ["uptime", "ping"])).rejects.toThrow(
      "health check type must be one of",
    );
    await expect(
      runHealthCheck(
        supabase,
        Array.from({ length: MAX_HEALTH_SITES_PER_RUN + 1 }, (_, index) => String(index + 1)),
      ),
    ).rejects.toThrow("No more than 25 sites");
    expect(functionCalls).toEqual([]);
  });
});

describe("SEO file APIs", () => {
  it("normalizes leading slashes but rejects nested or traversal paths", () => {
    expect(normalizeSeoFilePath(" /robots.txt ")).toBe("robots.txt");
    expect(normalizeSeoFilePath("\\google123.html")).toBe("google123.html");
    expect(() => normalizeSeoFilePath("nested/robots.txt")).toThrow("root-level files");
    expect(() => normalizeSeoFilePath("robots..txt")).toThrow("root-level files");
  });

  it("uses exact SEO Edge Function actions and request fields", async () => {
    const { supabase, functionCalls } = createSupabaseMock({}, (_name, body) => {
      const action = (body as { action?: string }).action;
      if (action === "list") return { files: [{ site_id: 12, path: "robots.txt" }] };
      if (action === "save") return { file: { site_id: 12, path: "robots.txt" } };
      if (action === "delete") return { file: { site_id: 12, path: "robots.txt", status: "deleted" } };
      if (action === "apply") return { applied: 1, errors: [] };
      return { checks: [{ path: "sitemap.xml", url: "https://example.test/sitemap.xml", status: 200, ok: true, valid_xml: true }] };
    });

    expect(await listSeoFiles(supabase, "12")).toHaveLength(1);
    await saveSeoFile(supabase, "12", {
      path: "/robots.txt",
      content: "User-agent: *",
      fileKind: "robots",
      mimeType: "text/plain; charset=utf-8",
    });
    await deleteSeoFile(supabase, "12", "/robots.txt");
    await applySeoFiles(supabase, "12");
    expect(await checkSitemaps(supabase, "12")).toHaveLength(1);

    expect(functionCalls).toEqual([
      { name: "seo-files", body: { action: "list", site_id: "12" } },
      {
        name: "seo-files",
        body: {
          action: "save",
          site_id: "12",
          path: "robots.txt",
          content: "User-agent: *",
          file_kind: "robots",
          mime_type: "text/plain; charset=utf-8",
        },
      },
      { name: "seo-files", body: { action: "delete", site_id: "12", path: "robots.txt" } },
      { name: "seo-files", body: { action: "apply", site_id: "12" } },
      { name: "seo-files", body: { action: "check_sitemaps", site_id: "12" } },
    ]);
  });

  it("enforces the UTF-8 1 MiB limit before invoking the backend", async () => {
    const { supabase, functionCalls } = createSupabaseMock({});
    const oversizedUnicodeContent = "é".repeat(Math.floor(MAX_SEO_FILE_BYTES / 2) + 1);

    await expect(
      saveSeoFile(supabase, "12", { path: "robots.txt", content: oversizedUnicodeContent }),
    ).rejects.toThrow("1 MiB");
    expect(functionCalls).toEqual([]);
  });
});

describe("IndexNow APIs", () => {
  it("maps status and mutation helpers to the supported actions", async () => {
    const { supabase, functionCalls } = createSupabaseMock({}, {
      setting: null,
      latest_release: null,
      eligible_url_count: 0,
    });

    await getIndexNowStatus(supabase, "12");
    await enableIndexNow(supabase, "12");
    await disableIndexNow(supabase, "12");
    await setIndexNowAutoSubmit(supabase, "12", false);
    await submitIndexNow(supabase, "12", { releaseId: "release-1" });

    expect(functionCalls).toEqual([
      { name: "indexnow-submit", body: { action: "status", site_id: "12" } },
      { name: "indexnow-submit", body: { action: "enable", site_id: "12" } },
      { name: "indexnow-submit", body: { action: "disable", site_id: "12" } },
      {
        name: "indexnow-submit",
        body: { action: "set_auto_submit", site_id: "12", auto_submit: false },
      },
      {
        name: "indexnow-submit",
        body: { action: "submit", site_id: "12", release_id: "release-1" },
      },
    ]);
  });

  it("omits release_id when manually submitting the latest release", async () => {
    const { supabase, functionCalls } = createSupabaseMock({}, {
      setting: null,
      latest_release: null,
      eligible_url_count: 0,
    });

    await submitIndexNow(supabase, "12");

    expect(functionCalls[0]).toEqual({
      name: "indexnow-submit",
      body: { action: "submit", site_id: "12" },
    });
  });
});

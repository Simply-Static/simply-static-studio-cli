import { describe, expect, it } from "vitest";
import { CliError } from "./errors.js";
import { getSiteStatistics, runPerformanceTest } from "./performance.js";
import { createSupabaseMock } from "./test-utils.js";

describe("runPerformanceTest", () => {
  it("invokes the pagespeed function with the stored site URL", async () => {
    const { supabase, functionCalls } = createSupabaseMock({
      site: {
        data: { id: "site-1", url: "https://example.test" },
        error: null,
      },
    });

    await runPerformanceTest(supabase, "site-1", { force: true });

    expect(functionCalls).toEqual([
      {
        name: "pagespeed",
        body: {
          url: "https://example.test/",
          site_id: "site-1",
          force: true,
        },
      },
    ]);
  });

  it("rejects non-HTTP test URLs", async () => {
    const { supabase } = createSupabaseMock({
      site: {
        data: { id: "site-1", url: "file:///etc/passwd" },
        error: null,
      },
    });

    await expect(runPerformanceTest(supabase, "site-1")).rejects.toThrow(CliError);
  });
});

describe("getSiteStatistics", () => {
  it("includes environment storage zones in the statistics request", async () => {
    const { supabase, functionCalls } = createSupabaseMock((table) => {
      if (table === "site") {
        return {
          data: {
            id: "site-1",
            pull_zone_id: 123,
            storage_zone_id: 456,
          },
          error: null,
        };
      }
      if (table === "site_environment") {
        return {
          data: [{ storage_zone_id: 789 }, { storage_zone_id: null }],
          error: null,
        };
      }
      return { data: null, error: null };
    });

    await getSiteStatistics(supabase, "site-1");

    expect(functionCalls).toEqual([
      {
        name: "statistics",
        body: {
          pullZoneId: 123,
          storageZoneId: 456,
          environmentStorageZoneIds: ["789"],
        },
      },
    ]);
  });
});

import { describe, expect, it } from "vitest";
import { getAccountUsage } from "./account.js";
import { createSupabaseMock } from "./test-utils.js";

describe("getAccountUsage", () => {
  it("deduplicates site metrics and formats byte totals", async () => {
    const { supabase } = createSupabaseMock((table) => {
      if (table === "site") {
        return { data: null, error: null, count: 2 };
      }
      if (table === "site_meta") {
        return {
          data: [
            { site_id: "site-1", storage: 1024, bandwidth: 2048 },
            { site_id: "site-1", storage: 999999, bandwidth: 999999 },
            { site_id: "site-2", storage: 3072, bandwidth: 4096 },
          ],
          error: null,
        };
      }
      return { data: null, error: null };
    });

    await expect(getAccountUsage(supabase, "user-1")).resolves.toMatchObject({
      accountId: "user-1",
      sites: 2,
      storageBytes: 4096,
      bandwidthBytes: 6144,
      storageGb: "0.00",
      bandwidthGb: "0.00",
    });
  });
});

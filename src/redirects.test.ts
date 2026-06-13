import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bulkCreateRedirects } from "./redirects.js";
import { createSupabaseMock } from "./test-utils.js";

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

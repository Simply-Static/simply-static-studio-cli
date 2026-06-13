import { describe, expect, it } from "vitest";
import { CliError } from "./errors.js";
import { assignTagToSite, createTag } from "./tags.js";
import { createSupabaseMock } from "./test-utils.js";

describe("createTag", () => {
  it("normalizes names and colors before inserting", async () => {
    const { supabase, calls } = createSupabaseMock({
      tag: {
        data: { id: "tag-1", account_id: "user-1", name: "Client", color: "#3858E9" },
        error: null,
      },
    });

    await createTag(supabase, "user-1", " Client ", "#3858e9");

    expect(calls.find((call) => call.method === "insert")?.args[0]).toEqual({
      account_id: "user-1",
      name: "Client",
      color: "#3858E9",
    });
  });

  it("rejects invalid colors before inserting", async () => {
    const { supabase, calls } = createSupabaseMock({ tag: { data: null, error: null } });
    await expect(createTag(supabase, "user-1", "Client", "blue")).rejects.toThrow(CliError);
    expect(calls.some((call) => call.method === "insert")).toBe(false);
  });
});

describe("assignTagToSite", () => {
  it("treats duplicate assignments as already assigned", async () => {
    const { supabase } = createSupabaseMock({
      site_tag: {
        data: null,
        error: { message: "duplicate key", code: "23505" },
      },
    });

    await expect(assignTagToSite(supabase, "site-1", "tag-1")).resolves.toEqual({
      assigned: true,
      siteId: "site-1",
      tagId: "tag-1",
    });
  });
});

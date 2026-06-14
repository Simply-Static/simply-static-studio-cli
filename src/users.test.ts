import { describe, expect, it } from "vitest";
import { makeAdmin, removeUser } from "./users.js";
import { createSupabaseMock } from "./test-utils.js";

describe("removeUser", () => {
  it("removes a site user by email without requiring the caller to know the user ID", async () => {
    const { supabase, calls, functionCalls } = createSupabaseMock((table) => {
      if (table === "user_site") {
        return {
          data: { user_id: "user-1", email: "person@example.com" },
          error: null,
        };
      }
      return { data: null, error: null };
    });

    await expect(removeUser(supabase, "site-1", "Person@Example.com")).resolves.toEqual({
      removed: true,
      siteId: "site-1",
      userId: "user-1",
      email: "person@example.com",
    });

    expect(calls).toEqual(
      expect.arrayContaining([
        { table: "user_site", method: "eq", args: ["site_id", "site-1"] },
        { table: "user_site", method: "eq", args: ["email", "person@example.com"] },
        { table: "user_site", method: "eq", args: ["user_id", "user-1"] },
        { table: "site_meta", method: "eq", args: ["email", "person@example.com"] },
      ]),
    );
    expect(functionCalls).toEqual([
      {
        name: "manage-user",
        body: {
          site_id: "site-1",
          email: "person@example.com",
          role: "",
          action: "delete",
          site_user_id: "user-1",
        },
      },
    ]);
  });
});

describe("makeAdmin", () => {
  it("accepts an email and swaps the resolved user into the admin slot", async () => {
    const { supabase, functionCalls } = createSupabaseMock({
      user_site: {
        data: { user_id: "user-2", email: "admin@example.com" },
        error: null,
      },
    });

    await expect(makeAdmin(supabase, "site-1", "admin@example.com")).resolves.toEqual({ ok: true });

    expect(functionCalls).toEqual([
      {
        name: "manage-user",
        body: {
          site_id: "site-1",
          action: "swap-admin",
          site_user_id: "user-2",
        },
      },
    ]);
  });
});

import { describe, expect, it } from "vitest";
import { inviteUser, listUsers, makeAdmin, removeUser } from "./users.js";
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

describe("listUsers", () => {
  it("includes site_id in the hardened get-user-confirmations payload", async () => {
    const { supabase, functionCalls } = createSupabaseMock(
      {
        user_site: {
          data: [{ user_id: "user-2", email: "member@example.com", admin: false, site_id: "site-1" }],
          error: null,
        },
      },
      {
        items: [{ id: "user-2", email_confirmed: true, has_paid_subscription: true }],
      },
    );

    await expect(listUsers(supabase, "site-1")).resolves.toEqual([
      expect.objectContaining({
        user_id: "user-2",
        email_confirmed: true,
        has_paid_subscription: true,
      }),
    ]);
    expect(functionCalls).toEqual([
      {
        name: "get-user-confirmations",
        body: { ids: ["user-2"], site_id: "site-1" },
      },
    ]);
  });

  it("preserves the existing confirmation fallback when lookup fails", async () => {
    const { supabase } = createSupabaseMock(
      {
        user_site: {
          data: [{ user_id: "user-2", email: "member@example.com", admin: false, site_id: "site-1" }],
          error: null,
        },
      },
      { error: "Confirmation lookup failed" },
    );

    await expect(listUsers(supabase, "site-1")).resolves.toEqual([
      expect.objectContaining({ email_confirmed: true, has_paid_subscription: false }),
    ]);
  });
});

describe("WordPress role validation", () => {
  it("rejects the subscriber role removed by the hardened manage-user endpoint", async () => {
    const { supabase, functionCalls } = createSupabaseMock({});

    await expect(
      inviteUser(supabase, "site-1", "person@example.com", "subscriber"),
    ).rejects.toThrow("role must be one of: administrator, editor, author, contributor");
    expect(functionCalls).toEqual([]);
  });
});

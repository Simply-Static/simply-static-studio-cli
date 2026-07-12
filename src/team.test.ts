import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bulkInviteTeamMembers, parseEmailInputFile, removeTeamMember } from "./team.js";
import { createSupabaseMock } from "./test-utils.js";

describe("parseEmailInputFile", () => {
  it("parses and deduplicates newline, comma, and semicolon separated email files", async () => {
    const filePath = join(tmpdir(), `team-emails-${Date.now()}.txt`);
    writeFileSync(filePath, "A@example.com\nb@example.com, a@example.com; c@example.com");

    await expect(parseEmailInputFile(filePath)).resolves.toEqual([
      "a@example.com",
      "b@example.com",
      "c@example.com",
    ]);
  });
});

describe("bulkInviteTeamMembers", () => {
  it("adds an existing user to the account and grants owned site access", async () => {
    const { supabase, calls, functionCalls } = createSupabaseMock((table) => {
      if (table === "user_site") {
        return {
          data: [{ site_id: "site-1", owner_account_id: null }],
          error: null,
        };
      }
      if (table === "account_member") {
        return { data: [], error: null };
      }
      if (table === "user") {
        return {
          data: { id: "member-1", email: "member@example.com" },
          error: null,
        };
      }
      return { data: null, error: null };
    });

    await expect(
      bulkInviteTeamMembers(supabase, "owner-1", ["member@example.com"], { role: "editor" }),
    ).resolves.toEqual([
      {
        email: "member@example.com",
        status: "added",
        userId: "member-1",
        sitesProcessed: 1,
      },
    ]);

    expect(calls.find((call) => call.table === "account_member" && call.method === "insert")?.args[0]).toEqual({
      account_id: "owner-1",
      member_id: "member-1",
    });
    expect(functionCalls).toMatchObject([
      {
        name: "manage-user",
        body: {
          site_id: "site-1",
          email: "member@example.com",
          role: "editor",
          action: "add",
          site_user_id: "member-1",
          owner_account_id: "owner-1",
        },
      },
    ]);
  });

  it("rejects the subscriber role before querying or invoking manage-user", async () => {
    const { supabase, calls, functionCalls } = createSupabaseMock({});

    await expect(
      bulkInviteTeamMembers(supabase, "owner-1", ["member@example.com"], { role: "subscriber" }),
    ).rejects.toThrow("role must be one of: administrator, editor, author, contributor");
    expect(calls).toEqual([]);
    expect(functionCalls).toEqual([]);
  });
});

describe("removeTeamMember", () => {
  it("removes the member's site_meta rows as well as site access", async () => {
    const { supabase, calls, functionCalls } = createSupabaseMock({
      user_site: {
        data: [{ site_id: "site-1" }, { site_id: "site-2" }],
        error: null,
      },
      site_meta: { data: null, error: null },
      account_member: { data: null, error: null },
    });

    await expect(
      removeTeamMember(supabase, "owner-1", "member-1", "member@example.com"),
    ).resolves.toEqual({ removed: true, memberId: "member-1", sitesProcessed: 2 });

    expect(functionCalls).toEqual([
      {
        name: "manage-user",
        body: {
          site_id: "site-1",
          email: "member@example.com",
          action: "delete",
          site_user_id: "member-1",
        },
      },
      {
        name: "manage-user",
        body: {
          site_id: "site-2",
          email: "member@example.com",
          action: "delete",
          site_user_id: "member-1",
        },
      },
    ]);
    expect(calls.filter((call) => call.table === "site_meta" && call.method === "delete")).toHaveLength(2);
    expect(calls).toEqual(expect.arrayContaining([
      { table: "site_meta", method: "eq", args: ["site_id", "site-1"] },
      { table: "site_meta", method: "eq", args: ["site_id", "site-2"] },
      { table: "site_meta", method: "eq", args: ["email", "member@example.com"] },
    ]));
  });

  it("does not remove the account membership when site_meta cleanup fails", async () => {
    const { supabase, calls } = createSupabaseMock((table) => {
      if (table === "user_site") return { data: [{ site_id: "site-1" }], error: null };
      if (table === "site_meta") return { data: null, error: { message: "site_meta cleanup failed" } };
      return { data: null, error: null };
    });

    await expect(
      removeTeamMember(supabase, "owner-1", "member-1", "member@example.com"),
    ).rejects.toThrow("site_meta cleanup failed");
    expect(calls.some((call) => call.table === "account_member" && call.method === "delete")).toBe(false);
  });
});

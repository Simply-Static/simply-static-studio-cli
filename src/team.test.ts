import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bulkInviteTeamMembers, parseEmailInputFile } from "./team.js";
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
});

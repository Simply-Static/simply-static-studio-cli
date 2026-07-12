import { describe, expect, it } from "vitest";
import {
  createReportShare,
  deleteReportSchedule,
  disableReportSchedule,
  generateReportPdf,
  getReportById,
  getSignedReportPdfUrl,
  listReportSchedules,
  listReportsBySite,
  listReportShares,
  revokeReportShare,
  saveReportSchedule,
} from "./reports.js";
import { createSupabaseMock } from "./test-utils.js";

const REPORT_ID = "123e4567-e89b-42d3-a456-426614174000";
const SHARE_ID = "223e4567-e89b-42d3-a456-426614174000";
const SCHEDULE_ID = "323e4567-e89b-42d3-a456-426614174000";

describe("report queries", () => {
  it("lists a site's reports newest first with a bounded limit", async () => {
    const reports = [{ id: REPORT_ID, site_id: 42 }];
    const { supabase, calls } = createSupabaseMock({
      reports: { data: reports, error: null },
    });

    await expect(listReportsBySite(supabase, "42", 50)).resolves.toEqual(reports);
    expect(calls).toEqual([
      { table: "reports", method: "select", args: ["*"] },
      { table: "reports", method: "eq", args: ["site_id", 42] },
      { table: "reports", method: "order", args: ["created_at", { ascending: false }] },
      { table: "reports", method: "limit", args: [50] },
    ]);
  });

  it("rejects invalid limits and site IDs before querying", async () => {
    const { supabase, calls } = createSupabaseMock({});

    await expect(listReportsBySite(supabase, "not-a-site", 20)).rejects.toThrow("siteId");
    await expect(listReportsBySite(supabase, 42, 201)).rejects.toThrow(
      "limit must be an integer between 1 and 200",
    );
    expect(calls).toEqual([]);
  });

  it("gets one report by its backend-compatible UUID", async () => {
    const report = { id: REPORT_ID, site_id: 42 };
    const { supabase, calls } = createSupabaseMock({
      reports: { data: report, error: null },
    });

    await expect(getReportById(supabase, REPORT_ID)).resolves.toEqual(report);
    expect(calls).toEqual([
      { table: "reports", method: "select", args: ["*"] },
      { table: "reports", method: "eq", args: ["id", REPORT_ID] },
      { table: "reports", method: "maybeSingle", args: [] },
    ]);
  });

  it("rejects malformed report IDs without querying", async () => {
    const { supabase, calls } = createSupabaseMock({});

    await expect(getReportById(supabase, "report-1")).rejects.toThrow("valid UUID");
    expect(calls).toEqual([]);
  });
});

describe("report PDF actions", () => {
  it("uses report-actions for user-authorized PDF generation and signed URLs", async () => {
    const report = { id: REPORT_ID, site_id: 42, pdf_storage_path: "reports/demo.pdf" };
    const { supabase, functionCalls } = createSupabaseMock({}, (name, body) => {
      const action = (body as { action?: string }).action;
      return action === "generate_pdf"
        ? { report }
        : { signed_url: "https://storage.example.test/report.pdf?token=secret" };
    });

    await expect(generateReportPdf(supabase, REPORT_ID)).resolves.toEqual(report);
    await expect(getSignedReportPdfUrl(supabase, REPORT_ID)).resolves.toBe(
      "https://storage.example.test/report.pdf?token=secret",
    );
    expect(functionCalls).toEqual([
      { name: "report-actions", body: { action: "generate_pdf", report_id: REPORT_ID } },
      { name: "report-actions", body: { action: "signed_pdf_url", report_id: REPORT_ID } },
    ]);
  });

  it("never invokes an action for an invalid report ID", async () => {
    const { supabase, functionCalls } = createSupabaseMock({});

    await expect(generateReportPdf(supabase, "../../report")).rejects.toThrow("valid UUID");
    expect(functionCalls).toEqual([]);
  });
});

describe("report shares", () => {
  it("lists, creates, and revokes shares using normalized optional fields", async () => {
    const share = { id: SHARE_ID, report_id: REPORT_ID, site_id: 42 };
    const { supabase, functionCalls } = createSupabaseMock({}, (name, body) => {
      const action = (body as { action?: string }).action;
      if (action === "list_shares") return { shares: [share] };
      return { share };
    });

    await expect(listReportShares(supabase, REPORT_ID)).resolves.toEqual([share]);
    await expect(createReportShare(supabase, REPORT_ID, {
      recipientEmail: " CLIENT@Example.com ",
      password: " report-secret ",
      expiresAt: "2099-01-02T03:04:05Z",
    })).resolves.toEqual(share);
    await expect(revokeReportShare(supabase, REPORT_ID, SHARE_ID)).resolves.toEqual(share);

    expect(functionCalls).toEqual([
      { name: "report-actions", body: { action: "list_shares", report_id: REPORT_ID } },
      {
        name: "report-actions",
        body: {
          action: "create_share",
          report_id: REPORT_ID,
          recipient_email: "client@example.com",
          password: "report-secret",
          expires_at: "2099-01-02T03:04:05.000Z",
        },
      },
      {
        name: "report-actions",
        body: { action: "revoke_share", report_id: REPORT_ID, share_id: SHARE_ID },
      },
    ]);
  });

  it("rejects invalid share inputs before invoking the backend", async () => {
    const { supabase, functionCalls } = createSupabaseMock({});

    await expect(createReportShare(supabase, REPORT_ID, {
      recipientEmail: "not-an-email",
    })).rejects.toThrow("Invalid email address");
    await expect(createReportShare(supabase, REPORT_ID, {
      expiresAt: "yesterday-ish",
    })).rejects.toThrow("valid date and time");
    await expect(revokeReportShare(supabase, REPORT_ID, "share-1")).rejects.toThrow("valid UUID");
    expect(functionCalls).toEqual([]);
  });
});

describe("report schedules", () => {
  it("lists all schedules or filters by a validated site ID", async () => {
    const schedule = { id: SCHEDULE_ID, site_id: 42, cadence: "monthly" };
    const { supabase, functionCalls } = createSupabaseMock({}, { schedules: [schedule] });

    await expect(listReportSchedules(supabase)).resolves.toEqual([schedule]);
    await expect(listReportSchedules(supabase, "42")).resolves.toEqual([schedule]);
    expect(functionCalls).toEqual([
      { name: "report-actions", body: { action: "list_schedules" } },
      { name: "report-actions", body: { action: "list_schedules", site_id: 42 } },
    ]);
  });

  it("saves a portfolio schedule with deduplicated numeric site IDs", async () => {
    const schedule = { id: SCHEDULE_ID, site_id: 42, cadence: "monthly" };
    const { supabase, functionCalls } = createSupabaseMock({}, { schedule });

    await expect(saveReportSchedule(supabase, ["42", 43, "42"], "MONTHLY", {
      scheduleId: SCHEDULE_ID,
      name: " Client Portfolio ",
      autoShare: true,
      recipientEmail: "CLIENT@example.com",
    })).resolves.toEqual(schedule);

    expect(functionCalls).toEqual([
      {
        name: "report-actions",
        body: {
          action: "save_schedule",
          schedule_id: SCHEDULE_ID,
          site_id: 42,
          site_ids: [42, 43],
          scope: "portfolio",
          cadence: "monthly",
          name: "Client Portfolio",
          auto_share: true,
          recipient_email: "client@example.com",
        },
      },
    ]);
  });

  it("rejects quarterly because Lagos supports only weekly and monthly schedules", async () => {
    const { supabase, functionCalls } = createSupabaseMock({});

    await expect(saveReportSchedule(supabase, [42], "quarterly")).rejects.toThrow(
      "cadence must be one of: weekly, monthly",
    );
    await expect(saveReportSchedule(supabase, [42], "monthly", {
      autoShare: true,
    })).rejects.toThrow("recipientEmail is required");
    expect(functionCalls).toEqual([]);
  });

  it("disables by UUID and deletes by the backend site/cadence selector", async () => {
    const schedule = { id: SCHEDULE_ID, site_id: 42, cadence: "weekly" };
    const { supabase, functionCalls } = createSupabaseMock({}, (name, body) =>
      (body as { action?: string }).action === "disable_schedule"
        ? { schedule }
        : { deleted: true, schedule_id: SCHEDULE_ID },
    );

    await expect(disableReportSchedule(supabase, SCHEDULE_ID)).resolves.toEqual(schedule);
    await expect(deleteReportSchedule(supabase, { siteId: "42", cadence: "weekly" })).resolves.toEqual({
      deleted: true,
      schedule_id: SCHEDULE_ID,
    });
    expect(functionCalls).toEqual([
      {
        name: "report-actions",
        body: { action: "disable_schedule", schedule_id: SCHEDULE_ID },
      },
      {
        name: "report-actions",
        body: { action: "delete_schedule", site_id: 42, cadence: "weekly" },
      },
    ]);
  });
});

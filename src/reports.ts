import type { SupabaseClient } from "@supabase/supabase-js";
import { CliError } from "./errors.js";
import { invokeFunction } from "./supabase.js";
import {
  normalizeEmail,
  parsePositiveInteger,
  requireAllowedValue,
} from "./validation.js";

const DEFAULT_REPORT_LIMIT = 20;
const MAX_REPORT_LIMIT = 200;
const MAX_SCHEDULE_SITES = 100;
const REPORT_CADENCES = ["weekly", "monthly"] as const;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ReportCadence = (typeof REPORT_CADENCES)[number];

export interface ReportRecord {
  id: string;
  site_id: string | number;
  report_kind?: string;
  generation_status?: string;
  outcome_status?: string;
  pdf_storage_path?: string | null;
  created_at?: string;
  [key: string]: unknown;
}

export interface ReportShareRecord {
  id: string;
  report_id: string;
  site_id: string | number;
  public_url?: string;
  recipient_email?: string;
  expires_at?: string | null;
  revoked_at?: string | null;
  [key: string]: unknown;
}

export interface ReportScheduleRecord {
  id: string;
  site_id: string | number;
  site_ids?: Array<string | number>;
  scope?: "site" | "portfolio";
  cadence: ReportCadence;
  enabled?: boolean;
  name?: string;
  recipient_email?: string;
  auto_share?: boolean;
  [key: string]: unknown;
}

export interface CreateReportShareOptions {
  recipientEmail?: string;
  password?: string;
  expiresAt?: string;
}

export interface SaveReportScheduleOptions {
  scheduleId?: string;
  name?: string;
  autoShare?: boolean;
  recipientEmail?: string;
}

export type ReportScheduleSelector =
  | string
  | { scheduleId: string }
  | { siteId: string | number; cadence: string };

function requiredUuid(value: unknown, label: string): string {
  const id = String(value ?? "").trim();
  if (!UUID_PATTERN.test(id)) {
    throw new CliError(`${label} must be a valid UUID.`);
  }
  return id;
}

function normalizeCadence(value: string): ReportCadence {
  return requireAllowedValue(
    String(value || "").trim().toLowerCase(),
    REPORT_CADENCES,
    "cadence",
  );
}

function normalizeSiteId(value: string | number, label = "siteId"): number {
  return parsePositiveInteger(value, label, { min: 1 });
}

function normalizeSiteIds(values: Array<string | number>): number[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new CliError("Provide at least one site ID.");
  }
  if (values.length > MAX_SCHEDULE_SITES) {
    throw new CliError(`A report schedule cannot include more than ${MAX_SCHEDULE_SITES} sites.`);
  }
  return [...new Set(values.map((value) => normalizeSiteId(value, "site ID")))];
}

function normalizeOptionalTimestamp(
  value: string | undefined,
  label: string,
  options: { future?: boolean } = {},
): string | undefined {
  if (value === undefined || String(value).trim() === "") return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new CliError(`${label} must be a valid date and time.`);
  }
  if (options.future && parsed.getTime() <= Date.now()) {
    throw new CliError(`${label} must be in the future.`);
  }
  return parsed.toISOString();
}

function normalizeOptionalName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const name = value.trim();
  if (!name) return undefined;
  if (name.length > 200) {
    throw new CliError("Schedule name must be 200 characters or fewer.");
  }
  return name;
}

function responseField<T>(value: T | null | undefined, label: string): T {
  if (value === undefined || value === null) {
    throw new CliError(`Report service did not return ${label}.`);
  }
  return value;
}

function scheduleMutationBody(selector: ReportScheduleSelector): Record<string, unknown> {
  if (typeof selector === "string") {
    return { schedule_id: requiredUuid(selector, "scheduleId") };
  }
  if ("scheduleId" in selector) {
    return { schedule_id: requiredUuid(selector.scheduleId, "scheduleId") };
  }
  return {
    site_id: normalizeSiteId(selector.siteId),
    cadence: normalizeCadence(selector.cadence),
  };
}

export async function listReportsBySite(
  supabase: SupabaseClient,
  siteId: string | number,
  limit = DEFAULT_REPORT_LIMIT,
): Promise<ReportRecord[]> {
  const safeSiteId = normalizeSiteId(siteId);
  const safeLimit = parsePositiveInteger(limit, "limit", {
    min: 1,
    max: MAX_REPORT_LIMIT,
  });
  const { data, error } = await supabase
    .from("reports")
    .select("*")
    .eq("site_id", safeSiteId)
    .order("created_at", { ascending: false })
    .limit(safeLimit);

  if (error) throw new CliError(error.message);
  return (data || []) as ReportRecord[];
}

export async function getReportById(
  supabase: SupabaseClient,
  reportId: string,
): Promise<ReportRecord> {
  const safeReportId = requiredUuid(reportId, "reportId");
  const { data, error } = await supabase
    .from("reports")
    .select("*")
    .eq("id", safeReportId)
    .maybeSingle();

  if (error) throw new CliError(error.message);
  if (!data) throw new CliError(`Report ${safeReportId} was not found.`);
  return data as ReportRecord;
}

export async function generateReportPdf(
  supabase: SupabaseClient,
  reportId: string,
): Promise<ReportRecord> {
  const result = await invokeFunction<{ report?: ReportRecord }>(supabase, "report-actions", {
    action: "generate_pdf",
    report_id: requiredUuid(reportId, "reportId"),
  });
  return responseField(result.report, "the generated report");
}

export async function getSignedReportPdfUrl(
  supabase: SupabaseClient,
  reportId: string,
): Promise<string> {
  const result = await invokeFunction<{ signed_url?: string | null }>(supabase, "report-actions", {
    action: "signed_pdf_url",
    report_id: requiredUuid(reportId, "reportId"),
  });
  const signedUrl = responseField(result.signed_url, "a signed PDF URL");
  if (!/^https?:\/\//i.test(signedUrl)) {
    throw new CliError("Report service returned an invalid signed PDF URL.");
  }
  return signedUrl;
}

export async function listReportShares(
  supabase: SupabaseClient,
  reportId: string,
): Promise<ReportShareRecord[]> {
  const result = await invokeFunction<{ shares?: ReportShareRecord[] }>(supabase, "report-actions", {
    action: "list_shares",
    report_id: requiredUuid(reportId, "reportId"),
  });
  return Array.isArray(result.shares) ? result.shares : [];
}

export async function createReportShare(
  supabase: SupabaseClient,
  reportId: string,
  options: CreateReportShareOptions = {},
): Promise<ReportShareRecord> {
  const recipientEmail = options.recipientEmail === undefined
    ? undefined
    : normalizeEmail(options.recipientEmail);
  const password = options.password?.trim();
  if (password && password.length > 256) {
    throw new CliError("Report password must be 256 characters or fewer.");
  }
  const expiresAt = normalizeOptionalTimestamp(options.expiresAt, "expiresAt", {
    future: true,
  });
  const result = await invokeFunction<{ share?: ReportShareRecord }>(supabase, "report-actions", {
    action: "create_share",
    report_id: requiredUuid(reportId, "reportId"),
    ...(recipientEmail ? { recipient_email: recipientEmail } : {}),
    ...(password ? { password } : {}),
    ...(expiresAt ? { expires_at: expiresAt } : {}),
  });
  return responseField(result.share, "the created share link");
}

export async function revokeReportShare(
  supabase: SupabaseClient,
  reportId: string,
  shareId: string,
): Promise<ReportShareRecord> {
  const result = await invokeFunction<{ share?: ReportShareRecord }>(supabase, "report-actions", {
    action: "revoke_share",
    report_id: requiredUuid(reportId, "reportId"),
    share_id: requiredUuid(shareId, "shareId"),
  });
  return responseField(result.share, "the revoked share link");
}

export async function listReportSchedules(
  supabase: SupabaseClient,
  siteId?: string | number,
): Promise<ReportScheduleRecord[]> {
  const result = await invokeFunction<{ schedules?: ReportScheduleRecord[] }>(supabase, "report-actions", {
    action: "list_schedules",
    ...(siteId === undefined ? {} : { site_id: normalizeSiteId(siteId) }),
  });
  return Array.isArray(result.schedules) ? result.schedules : [];
}

export async function saveReportSchedule(
  supabase: SupabaseClient,
  siteIds: Array<string | number>,
  cadence: string,
  options: SaveReportScheduleOptions = {},
): Promise<ReportScheduleRecord> {
  const normalizedSiteIds = normalizeSiteIds(siteIds);
  const normalizedCadence = normalizeCadence(cadence);
  const recipientEmail = options.recipientEmail === undefined
    ? undefined
    : normalizeEmail(options.recipientEmail);
  if (options.autoShare === true && !recipientEmail) {
    throw new CliError("recipientEmail is required when automatic sharing is enabled.");
  }
  const name = normalizeOptionalName(options.name);
  const scheduleId = options.scheduleId === undefined
    ? undefined
    : requiredUuid(options.scheduleId, "scheduleId");
  const result = await invokeFunction<{ schedule?: ReportScheduleRecord }>(supabase, "report-actions", {
    action: "save_schedule",
    ...(scheduleId ? { schedule_id: scheduleId } : {}),
    site_id: normalizedSiteIds[0],
    site_ids: normalizedSiteIds,
    scope: normalizedSiteIds.length > 1 ? "portfolio" : "site",
    cadence: normalizedCadence,
    ...(name ? { name } : {}),
    ...(options.autoShare === undefined ? {} : { auto_share: options.autoShare }),
    ...(recipientEmail ? { recipient_email: recipientEmail } : {}),
  });
  return responseField(result.schedule, "the saved schedule");
}

export async function disableReportSchedule(
  supabase: SupabaseClient,
  selector: ReportScheduleSelector,
): Promise<ReportScheduleRecord> {
  const result = await invokeFunction<{ schedule?: ReportScheduleRecord }>(supabase, "report-actions", {
    action: "disable_schedule",
    ...scheduleMutationBody(selector),
  });
  return responseField(result.schedule, "the disabled schedule");
}

export async function deleteReportSchedule(
  supabase: SupabaseClient,
  selector: ReportScheduleSelector,
): Promise<{ deleted: boolean; schedule_id: string }> {
  return invokeFunction(supabase, "report-actions", {
    action: "delete_schedule",
    ...scheduleMutationBody(selector),
  });
}

export const listReports = listReportsBySite;
export const getReport = getReportById;
export const getSignedPdfUrl = getSignedReportPdfUrl;

import type { SupabaseClient } from "@supabase/supabase-js";
import { CliError } from "./errors.js";
import { invokeFunction } from "./supabase.js";
import { assertSafeId, parsePositiveInteger, requireAllowedValue } from "./validation.js";

export const HEALTH_CHECK_TYPES = [
  "uptime",
  "response_time",
  "ssl",
  "dns",
  "cdn",
  "static_freshness",
  "robots",
  "sitemap",
  "indexability",
  "ai_readiness",
] as const;

export const SEO_FILE_ACTIONS = ["list", "save", "delete", "apply", "check_sitemaps"] as const;
export const INDEXNOW_ACTIONS = ["status", "enable", "disable", "set_auto_submit", "submit"] as const;
export const MAX_HEALTH_SITES_PER_RUN = 25;
export const MAX_HEALTH_OVERVIEW_ROWS = 100;
export const MAX_SEO_FILE_BYTES = 1024 * 1024;

export type HealthCheckType = (typeof HEALTH_CHECK_TYPES)[number];
export type SeoFileAction = (typeof SEO_FILE_ACTIONS)[number];
export type IndexNowAction = (typeof INDEXNOW_ACTIONS)[number];
export type HealthRecord = Record<string, unknown>;

export interface SiteDeployManifest extends HealthRecord {
  id: string;
  site_id: string | number;
  deploy_id?: string | null;
  health_status?: string | null;
  finished_at?: string | null;
}

export interface SiteHealthSnapshot extends HealthRecord {
  site_id: string | number;
  overall_status?: string;
  availability_status?: string;
  freshness_status?: string;
  seo_status?: string;
  open_issue_count?: number;
  last_checked_at?: string | null;
}

export interface SiteHealthIssue extends HealthRecord {
  id: string;
  site_id: string | number;
  pillar?: string;
  check_type?: string;
  severity?: string;
  title?: string;
  status?: string;
  last_seen_at?: string;
}

export interface SiteHealthResult extends HealthRecord {
  id: string;
  site_id: string | number;
  pillar?: string;
  check_type?: string;
  status?: string;
  checked_at?: string;
}

export interface SiteRelease extends HealthRecord {
  id: string;
  site_id: string | number;
  release_id?: string;
  deploy_id?: string | null;
  status?: string;
  created_at?: string;
}

export interface SiteDeployDiff extends HealthRecord {
  id: string;
  site_id: string | number;
  from_manifest_id?: string | null;
  to_manifest_id: string;
  status?: string;
  summary?: HealthRecord;
  details?: HealthRecord;
}

export interface HealthOverviewOptions {
  issueLimit?: number;
  resultLimit?: number;
  releaseLimit?: number;
}

export interface HealthOverview {
  siteId: string;
  latestManifest: SiteDeployManifest | null;
  snapshot: SiteHealthSnapshot | null;
  openIssues: SiteHealthIssue[];
  recentResults: SiteHealthResult[];
  recentReleases: SiteRelease[];
  latestDiff: SiteDeployDiff | null;
}

export interface HealthCheckSiteResult extends HealthRecord {
  site_id: string;
  url?: string;
  checks?: HealthCheckType[];
  errors?: Array<{ check_type: string; error: string }>;
  error?: string;
  alerts?: unknown;
}

export interface HealthCheckResponse {
  checked: number;
  failed?: number;
  results: HealthCheckSiteResult[];
}

export interface SeoFileRecord extends HealthRecord {
  id?: string;
  site_id: string | number;
  path: string;
  file_kind?: string;
  mime_type?: string;
  content_text?: string;
  size?: number;
  content_hash?: string | null;
  status?: string;
  last_pushed_at?: string | null;
  last_push_status?: string | null;
  last_push_error?: string | null;
}

export interface SaveSeoFileOptions {
  path: string;
  content: string;
  fileKind?: string;
  mimeType?: string;
}

export interface SeoFileApplyResult {
  applied: number;
  errors: string[];
}

export interface SitemapCheck extends HealthRecord {
  path: string;
  url: string;
  status: number;
  ok: boolean;
  valid_xml: boolean;
  bytes?: number;
  error?: string;
}

export interface IndexNowSetting extends HealthRecord {
  id?: string;
  site_id?: string | number;
  enabled?: boolean;
  auto_submit?: boolean;
  key_path?: string;
  key_location?: string | null;
  endpoint?: string;
  last_submitted_at?: string | null;
  last_submission_status?: string | null;
  last_submission_details?: HealthRecord;
}

export interface IndexNowSubmission extends HealthRecord {
  status?: string;
  reason?: string;
}

export interface IndexNowStatus extends HealthRecord {
  setting: IndexNowSetting | null;
  latest_release: SiteRelease | null;
  eligible_url_count: number;
  skipped_reason?: string;
  submission?: IndexNowSubmission;
}

export interface SubmitIndexNowOptions {
  releaseId?: string;
}

function throwQueryError(error: { message: string } | null, fallback: string): void {
  if (error) throw new CliError(error.message || fallback);
}

function overviewLimit(value: number | undefined, defaultValue: number, label: string): number {
  return parsePositiveInteger(value ?? defaultValue, label, {
    min: 1,
    max: MAX_HEALTH_OVERVIEW_ROWS,
  });
}

export async function getHealthOverview(
  supabase: SupabaseClient,
  siteId: string,
  options: HealthOverviewOptions = {},
): Promise<HealthOverview> {
  const safeSiteId = assertSafeId(siteId, "siteId");
  const issueLimit = overviewLimit(options.issueLimit, 20, "issue limit");
  const resultLimit = overviewLimit(options.resultLimit, 50, "result limit");
  const releaseLimit = overviewLimit(options.releaseLimit, 20, "release limit");

  const { data: manifestData, error: manifestError } = await supabase
    .from("site_deploy_manifest")
    .select("*")
    .eq("site_id", safeSiteId)
    .order("finished_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  throwQueryError(manifestError, "Could not load the latest deploy manifest.");

  const latestManifest = (manifestData || null) as SiteDeployManifest | null;
  const diffQuery = latestManifest?.id
    ? supabase
        .from("site_deploy_diff")
        .select("*")
        .eq("to_manifest_id", latestManifest.id)
        .maybeSingle()
    : Promise.resolve({ data: null, error: null });

  const [snapshotResult, issuesResult, resultsResult, releasesResult, diffResult] = await Promise.all([
    supabase
      .from("site_health_snapshot")
      .select("*")
      .eq("site_id", safeSiteId)
      .maybeSingle(),
    supabase
      .from("site_health_issue")
      .select("*")
      .eq("site_id", safeSiteId)
      .eq("status", "open")
      .order("last_seen_at", { ascending: false })
      .limit(issueLimit),
    supabase
      .from("site_health_result")
      .select("*")
      .eq("site_id", safeSiteId)
      .order("checked_at", { ascending: false })
      .limit(resultLimit),
    supabase
      .from("site_release")
      .select("*")
      .eq("site_id", safeSiteId)
      .order("created_at", { ascending: false })
      .limit(releaseLimit),
    diffQuery,
  ]);

  throwQueryError(snapshotResult.error, "Could not load the health snapshot.");
  throwQueryError(issuesResult.error, "Could not load open health issues.");
  throwQueryError(resultsResult.error, "Could not load recent health results.");
  throwQueryError(releasesResult.error, "Could not load recent releases.");
  throwQueryError(diffResult.error, "Could not load the latest deploy diff.");

  return {
    siteId: safeSiteId,
    latestManifest,
    snapshot: (snapshotResult.data || null) as SiteHealthSnapshot | null,
    openIssues: (issuesResult.data || []) as SiteHealthIssue[],
    recentResults: (resultsResult.data || []) as SiteHealthResult[],
    recentReleases: (releasesResult.data || []) as SiteRelease[],
    latestDiff: (diffResult.data || null) as SiteDeployDiff | null,
  };
}

function normalizeHealthCheckTypes(checkTypes: readonly string[] | undefined): HealthCheckType[] | undefined {
  if (checkTypes === undefined) return undefined;
  if (checkTypes.length === 0) {
    throw new CliError("Choose at least one health check.");
  }

  const normalized = checkTypes.map((value) =>
    requireAllowedValue(String(value || "").trim(), HEALTH_CHECK_TYPES, "health check type"),
  );
  return [...new Set(normalized)];
}

export async function runHealthCheck(
  supabase: SupabaseClient,
  siteIdOrIds: string | readonly string[],
  checkTypes?: readonly string[],
): Promise<HealthCheckResponse> {
  const types = normalizeHealthCheckTypes(checkTypes);
  const body: { site_id?: string; site_ids?: string[]; check_types?: HealthCheckType[] } = {};

  if (typeof siteIdOrIds !== "string") {
    if (siteIdOrIds.length === 0) {
      throw new CliError("Provide at least one siteId to check.");
    }
    if (siteIdOrIds.length > MAX_HEALTH_SITES_PER_RUN) {
      throw new CliError(`No more than ${MAX_HEALTH_SITES_PER_RUN} sites can be checked at once.`);
    }
    body.site_ids = [...new Set(siteIdOrIds.map((siteId) => assertSafeId(siteId, "siteId")))];
  } else {
    body.site_id = assertSafeId(siteIdOrIds, "siteId");
  }

  if (types) body.check_types = types;
  return invokeFunction<HealthCheckResponse>(supabase, "site-health-check", body);
}

export function normalizeSeoFilePath(value: string): string {
  const path = String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");

  if (!path || path.includes("/") || path.includes("..") || path.includes("?") || path.includes("#")) {
    throw new CliError("SEO files must be root-level files such as robots.txt or google123.html.");
  }
  return path;
}

export function validateSeoFileContent(content: string): string {
  const normalized = String(content ?? "");
  const bytes = new TextEncoder().encode(normalized).byteLength;
  if (bytes > MAX_SEO_FILE_BYTES) {
    throw new CliError(`SEO files must be ${MAX_SEO_FILE_BYTES} bytes (1 MiB) or smaller.`);
  }
  return normalized;
}

export async function listSeoFiles(
  supabase: SupabaseClient,
  siteId: string,
): Promise<SeoFileRecord[]> {
  const response = await invokeFunction<{ files?: SeoFileRecord[] }>(supabase, "seo-files", {
    action: "list",
    site_id: assertSafeId(siteId, "siteId"),
  });
  return Array.isArray(response?.files) ? response.files : [];
}

export async function saveSeoFile(
  supabase: SupabaseClient,
  siteId: string,
  options: SaveSeoFileOptions,
): Promise<SeoFileRecord> {
  const response = await invokeFunction<{ file?: SeoFileRecord }>(supabase, "seo-files", {
    action: "save",
    site_id: assertSafeId(siteId, "siteId"),
    path: normalizeSeoFilePath(options.path),
    content: validateSeoFileContent(options.content),
    ...(options.fileKind === undefined ? {} : { file_kind: options.fileKind }),
    ...(options.mimeType === undefined ? {} : { mime_type: options.mimeType }),
  });

  if (!response?.file) throw new CliError("SEO file save did not return a file record.");
  return response.file;
}

export async function deleteSeoFile(
  supabase: SupabaseClient,
  siteId: string,
  path: string,
): Promise<SeoFileRecord | null> {
  const response = await invokeFunction<{ file?: SeoFileRecord | null }>(supabase, "seo-files", {
    action: "delete",
    site_id: assertSafeId(siteId, "siteId"),
    path: normalizeSeoFilePath(path),
  });
  return response?.file || null;
}

export async function applySeoFiles(
  supabase: SupabaseClient,
  siteId: string,
): Promise<SeoFileApplyResult> {
  return invokeFunction<SeoFileApplyResult>(supabase, "seo-files", {
    action: "apply",
    site_id: assertSafeId(siteId, "siteId"),
  });
}

export async function checkSitemaps(
  supabase: SupabaseClient,
  siteId: string,
): Promise<SitemapCheck[]> {
  const response = await invokeFunction<{ checks?: SitemapCheck[] }>(supabase, "seo-files", {
    action: "check_sitemaps",
    site_id: assertSafeId(siteId, "siteId"),
  });
  return Array.isArray(response?.checks) ? response.checks : [];
}

async function invokeIndexNow(
  supabase: SupabaseClient,
  siteId: string,
  action: IndexNowAction,
  extra: Record<string, unknown> = {},
): Promise<IndexNowStatus> {
  return invokeFunction<IndexNowStatus>(supabase, "indexnow-submit", {
    action,
    site_id: assertSafeId(siteId, "siteId"),
    ...extra,
  });
}

export async function getIndexNowStatus(
  supabase: SupabaseClient,
  siteId: string,
): Promise<IndexNowStatus> {
  return invokeIndexNow(supabase, siteId, "status");
}

export async function enableIndexNow(
  supabase: SupabaseClient,
  siteId: string,
): Promise<IndexNowStatus> {
  return invokeIndexNow(supabase, siteId, "enable");
}

export async function disableIndexNow(
  supabase: SupabaseClient,
  siteId: string,
): Promise<IndexNowStatus> {
  return invokeIndexNow(supabase, siteId, "disable");
}

export async function setIndexNowAutoSubmit(
  supabase: SupabaseClient,
  siteId: string,
  autoSubmit: boolean,
): Promise<IndexNowStatus> {
  if (typeof autoSubmit !== "boolean") throw new CliError("autoSubmit must be a boolean.");
  return invokeIndexNow(supabase, siteId, "set_auto_submit", { auto_submit: autoSubmit });
}

export async function submitIndexNow(
  supabase: SupabaseClient,
  siteId: string,
  options: SubmitIndexNowOptions = {},
): Promise<IndexNowStatus> {
  return invokeIndexNow(supabase, siteId, "submit", {
    ...(options.releaseId === undefined
      ? {}
      : { release_id: assertSafeId(options.releaseId, "releaseId") }),
  });
}

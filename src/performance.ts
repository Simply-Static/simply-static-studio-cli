import type { SupabaseClient } from "@supabase/supabase-js";
import { CliError } from "./errors.js";
import { getSite } from "./sites.js";
import { invokeFunction } from "./supabase.js";
import { assertSafeId, parsePositiveInteger } from "./validation.js";

export interface SiteStatisticsResult {
  siteId: string;
  pullZoneId: string;
  storageZoneId?: string;
  environmentStorageZoneIds: string[];
  statistics: unknown;
}

export interface PerformanceRunOptions {
  url?: string;
  force?: boolean;
}

function assertPublicHttpUrl(value: string, label = "URL"): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new CliError(`${label} must use HTTP or HTTPS.`);
  }
  url.hash = "";
  return url.toString();
}

export async function getEnvironmentStorageZoneIds(
  supabase: SupabaseClient,
  siteId: string,
): Promise<string[]> {
  const safeSiteId = assertSafeId(siteId, "siteId");
  const { data, error } = await supabase
    .from("site_environment")
    .select("storage_zone_id")
    .eq("site_id", safeSiteId)
    .not("storage_zone_id", "is", null);

  if (error) throw new CliError(error.message);
  return (data || [])
    .map((row) => row.storage_zone_id)
    .filter((value): value is string | number => value !== null && value !== undefined)
    .map(String);
}

export async function runPerformanceTest(
  supabase: SupabaseClient,
  siteId: string,
  options: PerformanceRunOptions = {},
): Promise<unknown> {
  const safeSiteId = assertSafeId(siteId, "siteId");
  const site = await getSite(supabase, safeSiteId);
  const rawUrl = options.url || String(site.url || "");
  if (!rawUrl) {
    throw new CliError("Site does not have a URL.");
  }

  return invokeFunction(supabase, "pagespeed", {
    url: assertPublicHttpUrl(rawUrl, "Site URL"),
    site_id: safeSiteId,
    ...(options.force ? { force: true } : {}),
  });
}

export async function getSiteStatistics(
  supabase: SupabaseClient,
  siteId: string,
): Promise<SiteStatisticsResult> {
  const safeSiteId = assertSafeId(siteId, "siteId");
  const site = await getSite(supabase, safeSiteId);
  if (!site.pull_zone_id) {
    throw new CliError("Site does not have a pull_zone_id yet.");
  }

  const environmentStorageZoneIds = await getEnvironmentStorageZoneIds(supabase, safeSiteId);
  const statistics = await invokeFunction(supabase, "statistics", {
    pullZoneId: site.pull_zone_id,
    storageZoneId: site.storage_zone_id,
    environmentStorageZoneIds,
  });

  return {
    siteId: safeSiteId,
    pullZoneId: String(site.pull_zone_id),
    ...(site.storage_zone_id ? { storageZoneId: String(site.storage_zone_id) } : {}),
    environmentStorageZoneIds,
    statistics,
  };
}

export async function listPerformanceReports(
  supabase: SupabaseClient,
  siteId: string,
  limit = 10,
): Promise<unknown[]> {
  const safeSiteId = assertSafeId(siteId, "siteId");
  const safeLimit = parsePositiveInteger(limit, "limit", { min: 1, max: 100 });
  const { data, error } = await supabase
    .from("pagespeed_reports")
    .select("id, site_id, desktop_score, mobile_score, ttfb_avg, created_at, report_data")
    .eq("site_id", safeSiteId)
    .order("created_at", { ascending: false })
    .limit(safeLimit);

  if (error) throw new CliError(error.message);
  return data || [];
}

import type { SupabaseClient } from "@supabase/supabase-js";
import { CliError } from "./errors.js";
import { assertSafeId } from "./validation.js";

export interface AccountUsage {
  accountId: string;
  sites: number;
  storageBytes: number;
  bandwidthBytes: number;
  storageGb: string;
  bandwidthGb: string;
  subscription?: unknown;
}

function bytesToGbString(bytes: number): string {
  return (bytes / (1024 * 1024 * 1024)).toFixed(2);
}

export async function getAccountSubscription(
  supabase: SupabaseClient,
  accountId: string,
): Promise<unknown | null> {
  const safeAccountId = assertSafeId(accountId, "accountId");
  const { data, error } = await supabase
    .from("subscription")
    .select("*")
    .eq("user_id", safeAccountId)
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new CliError(error.message);
  return data || null;
}

export async function getAccountUsage(
  supabase: SupabaseClient,
  accountId: string,
  options: { includeSubscription?: boolean } = {},
): Promise<AccountUsage> {
  const safeAccountId = assertSafeId(accountId, "accountId");

  const { count, error: sitesError } = await supabase
    .from("site")
    .select("id, user_site!inner(user_id)", { count: "exact", head: true })
    .eq("user_site.user_id", safeAccountId);
  if (sitesError) throw new CliError(sitesError.message);

  const { data: metricRows, error: metricsError } = await supabase
    .from("site_meta")
    .select("site_id, storage, bandwidth, site!inner(user_site!inner(user_id, admin))")
    .eq("site.user_site.user_id", safeAccountId)
    .eq("site.user_site.admin", true);
  if (metricsError) throw new CliError(metricsError.message);

  const seenSites = new Set<string>();
  let storageBytes = 0;
  let bandwidthBytes = 0;
  for (const row of metricRows || []) {
    const siteId = String(row.site_id || "");
    if (!siteId || seenSites.has(siteId)) continue;
    seenSites.add(siteId);
    storageBytes += Number(row.storage || 0);
    bandwidthBytes += Number(row.bandwidth || 0);
  }

  return {
    accountId: safeAccountId,
    sites: count || 0,
    storageBytes,
    bandwidthBytes,
    storageGb: bytesToGbString(storageBytes),
    bandwidthGb: bytesToGbString(bandwidthBytes),
    ...(options.includeSubscription ? { subscription: await getAccountSubscription(supabase, safeAccountId) } : {}),
  };
}

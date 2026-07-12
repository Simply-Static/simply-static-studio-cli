import type { SupabaseClient } from "@supabase/supabase-js";
import { CliError } from "./errors.js";
import { invokeFunction } from "./supabase.js";
import { assertSafeId, parsePositiveInteger } from "./validation.js";

const DEFAULT_RELEASE_LIMIT = 10;
const MAX_RELEASE_LIMIT = 100;

export interface MigrationLogResult {
  content: string;
  line_count: number;
}

export interface SiteReleaseRecord {
  id: string;
  site_id: string | number;
  release_id: string;
  environment: string;
  status: string;
  snapshot_id?: string | null;
  deploy_id?: string | null;
  created_at?: string;
  [key: string]: unknown;
}

export interface RollbackSnapshot {
  id: string;
  snapshot_id?: string;
  deploy_id?: string;
  [key: string]: unknown;
}

export interface RollbackStatus {
  available: boolean;
  snapshots: RollbackSnapshot[];
  status: unknown;
  max_snapshots: number;
  error: string | null;
  [key: string]: unknown;
}

type FunctionEnvelope<T> = {
  data?: T;
  error?: unknown;
};

function unwrapFunctionData<T>(result: T | FunctionEnvelope<T>): T {
  if (result && typeof result === "object" && "data" in result) {
    const data = (result as FunctionEnvelope<T>).data;
    if (data !== undefined) return data;
  }
  return result as T;
}

export async function cancelExport(
  supabase: SupabaseClient,
  siteId: string,
): Promise<unknown> {
  return invokeFunction(supabase, "cancel-export", {
    site_id: assertSafeId(siteId, "siteId"),
  });
}

export async function getMigrationLog(
  supabase: SupabaseClient,
  siteId: string,
): Promise<MigrationLogResult> {
  return invokeFunction<MigrationLogResult>(supabase, "migration-log", {
    site_id: assertSafeId(siteId, "siteId"),
  });
}

export async function listProductionSiteReleases(
  supabase: SupabaseClient,
  siteId: string,
  limit: number = DEFAULT_RELEASE_LIMIT,
): Promise<SiteReleaseRecord[]> {
  const safeSiteId = assertSafeId(siteId, "siteId");
  const safeLimit = parsePositiveInteger(limit, "limit", {
    min: 1,
    max: MAX_RELEASE_LIMIT,
  });
  const { data, error } = await supabase
    .from("site_release")
    .select("*")
    .eq("site_id", safeSiteId)
    .eq("environment", "production")
    .order("created_at", { ascending: false })
    .limit(safeLimit);

  if (error) throw new CliError(error.message);
  return (data || []) as SiteReleaseRecord[];
}

export async function getRollbackStatus(
  supabase: SupabaseClient,
  siteId: string,
): Promise<RollbackStatus> {
  const result = await invokeFunction<RollbackStatus | FunctionEnvelope<RollbackStatus>>(
    supabase,
    "rollback-static-export",
    {
      site_id: assertSafeId(siteId, "siteId"),
      action: "status",
    },
  );
  return unwrapFunctionData(result);
}

export async function listRollbackSnapshots(
  supabase: SupabaseClient,
  siteId: string,
): Promise<RollbackSnapshot[]> {
  const status = await getRollbackStatus(supabase, siteId);
  return Array.isArray(status.snapshots) ? status.snapshots : [];
}

export async function startRollback(
  supabase: SupabaseClient,
  siteId: string,
  snapshotId: string,
): Promise<unknown> {
  const result = await invokeFunction<unknown>(supabase, "rollback-static-export", {
    site_id: assertSafeId(siteId, "siteId"),
    snapshot_id: assertSafeId(snapshotId, "snapshotId"),
  });
  return result && typeof result === "object" && "data" in result
    ? (result as FunctionEnvelope<unknown>).data
    : result;
}

// Short aliases are useful for callers that already have a site-scoped context.
export const listSiteReleases = listProductionSiteReleases;
export const getRollbackSnapshots = listRollbackSnapshots;
export const rollbackStaticExport = startRollback;

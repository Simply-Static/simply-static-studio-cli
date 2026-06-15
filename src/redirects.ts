import { readFile } from "node:fs/promises";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CliError } from "./errors.js";
import { invokeFunction } from "./supabase.js";
import { getSite } from "./sites.js";
import { assertReadableFileWithinLimit, assertSafeId } from "./validation.js";

const MAX_BULK_REDIRECTS = 1000;
const MAX_BULK_REDIRECT_FILE_BYTES = 512 * 1024;
const MAX_REDIRECT_PATH_LENGTH = 2048;

export interface UpdateRedirectOptions {
  fromPath?: string;
  toPath?: string;
  isActive?: boolean;
}

export interface DeleteRedirectOptions {
  pullZoneId?: string;
  db?: boolean;
  edgeRule?: boolean;
}

export interface RefreshRedirectRulesOptions {
  importExistingRedirects?: boolean;
}

function cleanHost(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

async function resolveRedirectContext(
  supabase: SupabaseClient,
  siteId: string,
  pullZoneId?: string,
  domain?: string,
): Promise<{ pullZoneId: string; domain: string }> {
  const safeSiteId = assertSafeId(siteId, "siteId");
  const site = await getSite(supabase, safeSiteId);
  const resolvedPullZoneId = pullZoneId || site.pull_zone_id;
  if (!resolvedPullZoneId) {
    throw new CliError("Site does not have a pull_zone_id yet.");
  }
  return {
    pullZoneId: String(resolvedPullZoneId),
    domain: domain || cleanHost(String(site.url || "")),
  };
}

function normalizeOptionalRedirectPath(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  const clean = String(value).trim();
  if (!clean) {
    throw new CliError(`${label} cannot be empty.`);
  }
  if (clean.length > MAX_REDIRECT_PATH_LENGTH) {
    throw new CliError(`${label} must be ${MAX_REDIRECT_PATH_LENGTH} characters or fewer.`);
  }
  return clean;
}

function shouldFallbackToLegacyEdgeRule(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes("not found") || message.includes("function not found");
}

function isAmbiguousDeleteRedirectError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes("not found or cannot be deleted");
}

async function isDefaultRedirect(
  supabase: SupabaseClient,
  safeSiteId: string,
  safeRedirectId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("redirects")
    .select("id, is_default")
    .eq("site_id", safeSiteId)
    .eq("id", safeRedirectId)
    .maybeSingle();

  if (error) throw new CliError(error.message);
  return Boolean((data as { is_default?: unknown } | null)?.is_default);
}

export async function refreshRedirectRules(
  supabase: SupabaseClient,
  siteId: string,
  options: RefreshRedirectRulesOptions = {},
): Promise<unknown> {
  const safeSiteId = assertSafeId(siteId, "siteId");
  return invokeFunction(supabase, "refresh-edge-rules", {
    siteId: safeSiteId,
    ...(options.importExistingRedirects === undefined
      ? {}
      : { importExistingRedirects: options.importExistingRedirects }),
  });
}

export async function listRedirects(
  supabase: SupabaseClient,
  siteId: string,
  pullZoneId?: string,
): Promise<unknown> {
  const safeSiteId = assertSafeId(siteId, "siteId");
  const context = await resolveRedirectContext(supabase, safeSiteId, pullZoneId);
  return invokeFunction(supabase, "get-redirects", {
    pullZoneId: context.pullZoneId,
    siteId: safeSiteId,
  });
}

export async function updateRedirect(
  supabase: SupabaseClient,
  siteId: string,
  redirectId: string,
  options: UpdateRedirectOptions,
): Promise<unknown> {
  const safeSiteId = assertSafeId(siteId, "siteId");
  const safeRedirectId = assertSafeId(redirectId, "redirectId");
  const fromPath = normalizeOptionalRedirectPath(options.fromPath, "fromPath");
  const toPath = normalizeOptionalRedirectPath(options.toPath, "toPath");
  const body: {
    siteId: string;
    redirectId: string;
    fromPath?: string;
    toPath?: string;
    isActive?: boolean;
  } = {
    siteId: safeSiteId,
    redirectId: safeRedirectId,
  };

  if (fromPath !== undefined) body.fromPath = fromPath;
  if (toPath !== undefined) body.toPath = toPath;
  if (options.isActive !== undefined) body.isActive = Boolean(options.isActive);

  if (body.fromPath === undefined && body.toPath === undefined && body.isActive === undefined) {
    throw new CliError("Provide at least one redirect field to update.");
  }

  const result = await invokeFunction(supabase, "update-redirect", body);
  await refreshRedirectRules(supabase, safeSiteId, { importExistingRedirects: false });
  return result;
}

export async function setRedirectActive(
  supabase: SupabaseClient,
  siteId: string,
  redirectId: string,
  isActive: boolean,
): Promise<unknown> {
  return updateRedirect(supabase, siteId, redirectId, { isActive });
}

export async function createRedirect(
  supabase: SupabaseClient,
  siteId: string,
  fromPath: string,
  toPath: string,
  options: { pullZoneId?: string; domain?: string } = {},
): Promise<unknown> {
  const safeSiteId = assertSafeId(siteId, "siteId");
  const context = await resolveRedirectContext(supabase, safeSiteId, options.pullZoneId, options.domain);
  return invokeFunction(supabase, "create-redirect", {
    fromPath,
    toPath,
    pullZoneId: context.pullZoneId,
    domain: context.domain,
    siteId: safeSiteId,
  });
}

async function deleteLegacyEdgeRule(
  supabase: SupabaseClient,
  safeSiteId: string,
  ruleId: string,
  pullZoneId?: string,
): Promise<unknown> {
  const context = await resolveRedirectContext(supabase, safeSiteId, pullZoneId);
  const result = await invokeFunction(supabase, "disable-redirect", {
    pullZoneId: context.pullZoneId,
    ruleId,
    siteId: safeSiteId,
  });
  await refreshRedirectRules(supabase, safeSiteId, { importExistingRedirects: true });
  return result;
}

export async function deleteRedirect(
  supabase: SupabaseClient,
  siteId: string,
  redirectId: string,
  options: DeleteRedirectOptions = {},
): Promise<unknown> {
  const safeSiteId = assertSafeId(siteId, "siteId");
  const safeRedirectId = assertSafeId(redirectId, "redirectId");
  if (options.db && options.edgeRule) {
    throw new CliError("Use only one of --db or --edge-rule.");
  }

  if (options.edgeRule) {
    return deleteLegacyEdgeRule(supabase, safeSiteId, safeRedirectId, options.pullZoneId);
  }

  let result: unknown;
  try {
    result = await invokeFunction(supabase, "delete-redirect", {
      siteId: safeSiteId,
      redirectId: safeRedirectId,
    });
  } catch (error) {
    if (options.db || !shouldFallbackToLegacyEdgeRule(error)) {
      throw error;
    }
    if (isAmbiguousDeleteRedirectError(error) && (await isDefaultRedirect(supabase, safeSiteId, safeRedirectId))) {
      throw error;
    }
    return deleteLegacyEdgeRule(supabase, safeSiteId, safeRedirectId, options.pullZoneId);
  }

  await refreshRedirectRules(supabase, safeSiteId, { importExistingRedirects: false });
  return result;
}

export async function bulkCreateRedirects(
  supabase: SupabaseClient,
  siteId: string,
  filePath: string,
  options: { pullZoneId?: string; domain?: string } = {},
): Promise<unknown> {
  const safeSiteId = assertSafeId(siteId, "siteId");
  const context = await resolveRedirectContext(supabase, safeSiteId, options.pullZoneId, options.domain);
  await assertReadableFileWithinLimit(filePath, MAX_BULK_REDIRECT_FILE_BYTES);
  const redirects = JSON.parse(await readFile(filePath, "utf8"));
  if (!Array.isArray(redirects)) {
    throw new CliError("Bulk redirect file must contain a JSON array.");
  }
  if (redirects.length > MAX_BULK_REDIRECTS) {
    throw new CliError(`Bulk redirect file cannot contain more than ${MAX_BULK_REDIRECTS} redirects.`);
  }
  for (const redirect of redirects) {
    if (!redirect || typeof redirect !== "object") {
      throw new CliError("Each bulk redirect must be an object.");
    }
    const record = redirect as { fromPath?: unknown; toPath?: unknown };
    if (typeof record.fromPath !== "string" || typeof record.toPath !== "string") {
      throw new CliError("Each bulk redirect must include string fromPath and toPath values.");
    }
    if (record.fromPath.length > 2048 || record.toPath.length > 2048) {
      throw new CliError("Redirect paths must be 2048 characters or fewer.");
    }
  }

  return invokeFunction(supabase, "bulk-create-redirects", {
    siteId: safeSiteId,
    pullZoneId: context.pullZoneId,
    domain: context.domain,
    redirects,
  });
}

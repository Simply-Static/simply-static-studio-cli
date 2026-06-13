import { readFile } from "node:fs/promises";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CliError } from "./errors.js";
import { invokeFunction } from "./supabase.js";
import { getSite } from "./sites.js";
import { assertReadableFileWithinLimit, assertSafeId } from "./validation.js";

const MAX_BULK_REDIRECTS = 1000;
const MAX_BULK_REDIRECT_FILE_BYTES = 512 * 1024;

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

export async function deleteRedirect(
  supabase: SupabaseClient,
  siteId: string,
  ruleId: string,
  pullZoneId?: string,
): Promise<unknown> {
  const safeSiteId = assertSafeId(siteId, "siteId");
  const context = await resolveRedirectContext(supabase, safeSiteId, pullZoneId);
  const result = await invokeFunction(supabase, "disable-redirect", {
    pullZoneId: context.pullZoneId,
    ruleId,
    siteId: safeSiteId,
  });
  await invokeFunction(supabase, "refresh-edge-rules", { siteId: safeSiteId });
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

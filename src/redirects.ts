import { readFile } from "node:fs/promises";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CliError } from "./errors.js";
import { invokeFunction } from "./supabase.js";
import { getSite } from "./sites.js";

function cleanHost(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

async function resolveRedirectContext(
  supabase: SupabaseClient,
  siteId: string,
  pullZoneId?: string,
  domain?: string,
): Promise<{ pullZoneId: string; domain: string }> {
  const site = await getSite(supabase, siteId);
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
  const context = await resolveRedirectContext(supabase, siteId, pullZoneId);
  return invokeFunction(supabase, "get-redirects", {
    pullZoneId: context.pullZoneId,
    siteId,
  });
}

export async function createRedirect(
  supabase: SupabaseClient,
  siteId: string,
  fromPath: string,
  toPath: string,
  options: { pullZoneId?: string; domain?: string } = {},
): Promise<unknown> {
  const context = await resolveRedirectContext(supabase, siteId, options.pullZoneId, options.domain);
  return invokeFunction(supabase, "create-redirect", {
    fromPath,
    toPath,
    pullZoneId: context.pullZoneId,
    domain: context.domain,
    siteId,
  });
}

export async function deleteRedirect(
  supabase: SupabaseClient,
  siteId: string,
  ruleId: string,
  pullZoneId?: string,
): Promise<unknown> {
  const context = await resolveRedirectContext(supabase, siteId, pullZoneId);
  const result = await invokeFunction(supabase, "disable-redirect", {
    pullZoneId: context.pullZoneId,
    ruleId,
    siteId,
  });
  await invokeFunction(supabase, "refresh-edge-rules", { siteId });
  return result;
}

export async function bulkCreateRedirects(
  supabase: SupabaseClient,
  siteId: string,
  filePath: string,
  options: { pullZoneId?: string; domain?: string } = {},
): Promise<unknown> {
  const context = await resolveRedirectContext(supabase, siteId, options.pullZoneId, options.domain);
  const redirects = JSON.parse(await readFile(filePath, "utf8"));
  if (!Array.isArray(redirects)) {
    throw new CliError("Bulk redirect file must contain a JSON array.");
  }

  return invokeFunction(supabase, "bulk-create-redirects", {
    siteId,
    pullZoneId: context.pullZoneId,
    domain: context.domain,
    redirects,
  });
}

import type { SupabaseClient } from "@supabase/supabase-js";
import { CliError } from "./errors.js";
import { invokeFunction } from "./supabase.js";
import { exportSite, getSite, getSiteMeta } from "./sites.js";

function cleanHost(value: string): string {
  return value.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

function siteUrlFromAdminUrl(adminUrl: string): string {
  return adminUrl.replace(/\/wp-admin\/?$/i, "").replace(/\/wp\/wp-admin\/?$/i, "");
}

function splitHost(host: string): { subdomain: string; tld: string } | null {
  const firstDot = host.indexOf(".");
  if (firstDot <= 0) return null;
  return {
    subdomain: host.slice(0, firstDot),
    tld: host.slice(firstDot + 1),
  };
}

export async function getHostnames(
  supabase: SupabaseClient,
  pullZoneId: string,
): Promise<string[]> {
  const data = await invokeFunction<{ hostnames?: string[] }>(supabase, "get-hostnames", { pullZoneId });
  return data.hostnames || [];
}

export async function addDomain(
  supabase: SupabaseClient,
  siteId: string,
  domain: string,
): Promise<unknown> {
  const site = await getSite(supabase, siteId);
  const pullZoneId = site.pull_zone_id;
  if (!pullZoneId) throw new CliError("Site does not have a pull_zone_id yet.");
  const meta = await getSiteMeta(supabase, siteId);
  if (!meta.admin_url || !meta.secret_key) {
    throw new CliError("Site metadata is missing admin_url or secret_key.");
  }

  const siteUrl = siteUrlFromAdminUrl(meta.admin_url);
  const connectData = await invokeFunction(supabase, "connect-domain", {
    pullZoneId,
    domain,
    secret_key: meta.secret_key,
    site_url: siteUrl,
    basic_auth_user: meta.basic_auth_user,
    basic_auth_password: meta.basic_auth_password,
    bedrock: Boolean(site.bedrock),
  });

  const currentHost = cleanHost(String(site.url || ""));
  const isStudioOrEmpty =
    !currentHost || currentHost.endsWith(".onstatic.studio") || currentHost.endsWith(".static.studio");
  if (isStudioOrEmpty) {
    const { error } = await supabase.from("site").update({ url: `https://${domain}` }).eq("id", siteId);
    if (error) throw new CliError(error.message);
  }

  await refreshEdgeRulesForDomain(supabase, siteId, String(pullZoneId), domain, currentHost);
  await exportSite(supabase, siteId);
  return connectData;
}

export async function setPrimaryDomain(
  supabase: SupabaseClient,
  siteId: string,
  domain: string,
): Promise<unknown> {
  const site = await getSite(supabase, siteId);
  const pullZoneId = site.pull_zone_id;
  if (!pullZoneId) throw new CliError("Site does not have a pull_zone_id yet.");
  const meta = await getSiteMeta(supabase, siteId);
  if (!meta.admin_url || !meta.secret_key) {
    throw new CliError("Site metadata is missing admin_url or secret_key.");
  }

  const connectData = await invokeFunction(supabase, "connect-domain", {
    pullZoneId,
    domain,
    secret_key: meta.secret_key,
    site_url: siteUrlFromAdminUrl(meta.admin_url),
    basic_auth_user: meta.basic_auth_user,
    basic_auth_password: meta.basic_auth_password,
    updateOnly: true,
    bedrock: Boolean(site.bedrock),
  });

  const { error } = await supabase.from("site").update({ url: `https://${domain}` }).eq("id", siteId);
  if (error) throw new CliError(error.message);

  await refreshEdgeRulesForDomain(supabase, siteId, String(pullZoneId), domain);
  await exportSite(supabase, siteId);
  return connectData;
}

export async function removeDomain(
  supabase: SupabaseClient,
  siteId: string,
  domain: string,
): Promise<{ removed: string[]; primary: string | null }> {
  const site = await getSite(supabase, siteId);
  const pullZoneId = site.pull_zone_id;
  if (!pullZoneId) throw new CliError("Site does not have a pull_zone_id yet.");
  const meta = await getSiteMeta(supabase, siteId);
  if (!meta.admin_url || !meta.secret_key) {
    throw new CliError("Site metadata is missing admin_url or secret_key.");
  }

  const hostnames = await getHostnames(supabase, String(pullZoneId));
  const domainsToRemove = new Set([domain]);
  if (domain.startsWith("www.")) {
    domainsToRemove.add(domain.replace(/^www\./, ""));
  } else {
    domainsToRemove.add(`www.${domain}`);
  }

  const existing = [...domainsToRemove].filter((hostname) => hostnames.includes(hostname));
  const remaining = hostnames.filter((hostname) => !domainsToRemove.has(hostname));
  const studioHostname = remaining.find(
    (hostname) => hostname.endsWith(".onstatic.studio") || hostname.endsWith(".static.studio"),
  );
  const remainingCustom = remaining.find(
    (hostname) => !hostname.endsWith(".onstatic.studio") && !hostname.endsWith(".static.studio"),
  );

  const currentPrimary = cleanHost(String(site.url || ""));
  let newPrimary = currentPrimary;
  if (domainsToRemove.has(currentPrimary)) {
    newPrimary = studioHostname || remainingCustom || cleanHost(siteUrlFromAdminUrl(meta.admin_url));
    await supabase.from("site").update({ url: `https://${newPrimary}` }).eq("id", siteId);
  }

  const oldUrl = siteUrlFromAdminUrl(meta.admin_url).replace(/(https?:\/\/)wp[-.]/, "$1");
  for (const hostname of existing) {
    await invokeFunction(supabase, "remove-domain", {
      pullZoneId,
      domain: hostname,
      site_url: siteUrlFromAdminUrl(meta.admin_url),
      oldUrl,
      secret_key: meta.secret_key,
      basic_auth_user: meta.basic_auth_user,
      basic_auth_password: meta.basic_auth_password,
      bedrock: Boolean(site.bedrock),
    });
  }

  await refreshEdgeRulesForDomain(supabase, siteId, String(pullZoneId), newPrimary);
  return { removed: existing, primary: newPrimary || null };
}

export async function issueSsl(supabase: SupabaseClient, domain: string): Promise<unknown> {
  return invokeFunction(supabase, "issue-ssl", { domain });
}

async function refreshEdgeRulesForDomain(
  supabase: SupabaseClient,
  siteId: string,
  pullZoneId: string,
  newDomain: string,
  fallbackHost?: string,
): Promise<void> {
  const hostnames = await getHostnames(supabase, pullZoneId);
  const edgeHost =
    hostnames.find((hostname) => hostname.endsWith(".onstatic.studio") || hostname.endsWith(".static.studio")) ||
    fallbackHost ||
    newDomain;
  const split = splitHost(edgeHost);
  if (!split) return;

  await invokeFunction(supabase, "create-edge-rules", {
    pullZoneId,
    subdomain: split.subdomain,
    newDomain,
    tld: split.tld,
    siteId,
  });
}

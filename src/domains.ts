import { isIP } from "node:net";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CliError } from "./errors.js";
import { refreshRedirectRules } from "./redirects.js";
import { exportSite, getSite, getSiteMeta } from "./sites.js";
import { invokeFunction } from "./supabase.js";
import type { SiteMetaRecord, SiteRecord } from "./types.js";
import { assertSafeId, normalizeMountPath } from "./validation.js";

type DomainContext = {
  siteId: string;
  site: SiteRecord;
  meta: SiteMetaRecord;
  pullZoneId: string;
  mountPath: string;
  wordpressUrl: string;
};

export interface DomainMutationResult {
  domain: string;
  primary?: string | null;
  removed?: string[];
  connect?: unknown;
  refresh?: unknown;
  registry?: unknown;
  export?: unknown;
  warnings?: string[];
}

function normalizeDomain(value: string): string {
  const raw = String(value || "").trim();
  if (!raw) throw new CliError("Domain is required.");

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new CliError(`Invalid domain: ${value}`);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new CliError("Domain must be a hostname without credentials, a port, a path, a query, or a fragment.");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const validHostname = hostname.length <= 253 &&
    isIP(hostname) === 0 &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname);
  if (!validHostname) {
    throw new CliError(`Invalid domain: ${value}`);
  }
  return hostname;
}

function cleanHost(value: unknown): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch {
    return raw.replace(/^https?:\/\//i, "").split("/")[0]?.toLowerCase() || "";
  }
}

function isManagedStudioHostname(hostname: string): boolean {
  return hostname.endsWith(".onstatic.studio") ||
    hostname.endsWith(".static.studio") ||
    /\.static\d+\.studio$/.test(hostname);
}

function isProviderHostname(hostname: string): boolean {
  return hostname.endsWith(".b-cdn.net");
}

function assertDomainActionReady(site: SiteRecord): void {
  if (site.status !== "deployed") {
    throw new CliError("Domain actions are available after this site finishes deploying.");
  }
}

function siteUrlFromAdminUrl(adminUrl: string): string {
  return adminUrl.replace(/\/wp\/wp-admin\/?$/i, "/wp").replace(/\/wp-admin\/?$/i, "");
}

function managedPublicHostFromAdminUrl(adminUrl: string): string {
  return cleanHost(siteUrlFromAdminUrl(adminUrl).replace(/(https?:\/\/)wp[-.]/i, "$1"));
}

async function domainContext(supabase: SupabaseClient, siteId: string): Promise<DomainContext> {
  const safeSiteId = assertSafeId(siteId, "siteId");
  const [site, meta] = await Promise.all([
    getSite(supabase, safeSiteId),
    getSiteMeta(supabase, safeSiteId),
  ]);
  if (!site.pull_zone_id) throw new CliError("Site does not have a pull_zone_id yet.");
  assertDomainActionReady(site);
  if (!meta.admin_url || !meta.secret_key) {
    throw new CliError("Site metadata is missing admin_url or secret_key.");
  }
  return {
    siteId: safeSiteId,
    site,
    meta,
    pullZoneId: String(site.pull_zone_id),
    mountPath: normalizeMountPath(site.mount_path),
    wordpressUrl: siteUrlFromAdminUrl(meta.admin_url),
  };
}

export async function getHostnames(
  supabase: SupabaseClient,
  pullZoneId: string,
): Promise<string[]> {
  const data = await invokeFunction<{ hostnames?: string[] }>(supabase, "get-hostnames", { pullZoneId });
  return data.hostnames || [];
}

async function domainAction(
  supabase: SupabaseClient,
  action: "lookup" | "register" | "unregister",
  siteId: string,
  domain: string,
): Promise<any> {
  return invokeFunction(supabase, "domain-actions", {
    action,
    site_id: siteId,
    hostname: domain,
  });
}

function connectWarnings(result: any): string[] {
  return [
    result?.wordpress?.warning,
    result?.secondary?.error,
  ].filter(Boolean).map(String);
}

function wordpressUpdateFailure(result: any): string | null {
  if (result?.wordpress?.warning) return String(result.wordpress.warning);
  if (result?.wordpress && result.wordpress.updated !== true) {
    return "WordPress did not confirm the domain update.";
  }
  return null;
}

async function connectDomain(
  supabase: SupabaseClient,
  context: DomainContext,
  domain: string,
  options: { updateOnly?: boolean; includeSecondary?: boolean; mountPath?: string } = {},
): Promise<any> {
  return invokeFunction(supabase, "connect-domain", {
    pullZoneId: context.pullZoneId,
    domain,
    siteId: context.siteId,
    secret_key: context.meta.secret_key,
    site_url: context.wordpressUrl,
    basic_auth_user: context.meta.basic_auth_user,
    basic_auth_password: context.meta.basic_auth_password,
    bedrock: Boolean(context.site.bedrock),
    mount_path: options.mountPath ?? context.mountPath,
    ...(options.updateOnly ? { updateOnly: true } : {}),
    ...(options.includeSecondary === undefined ? {} : { includeSecondary: options.includeSecondary }),
  });
}

async function refreshDomains(supabase: SupabaseClient, siteId: string): Promise<unknown> {
  return refreshRedirectRules(supabase, siteId, { importExistingRedirects: true });
}

export async function addDomain(
  supabase: SupabaseClient,
  siteId: string,
  domain: string,
): Promise<DomainMutationResult> {
  const hostname = normalizeDomain(domain);
  const context = await domainContext(supabase, siteId);
  const ownership = await domainAction(supabase, "lookup", context.siteId, hostname);
  if (ownership?.conflict) {
    const conflict = ownership.conflict;
    throw new CliError(
      `${hostname} is already connected to ${conflict.site_name || `site ${conflict.site_id}`}. Remove or transfer it before continuing.`,
    );
  }

  const connect = await connectDomain(supabase, context, hostname);
  const wordpressFailure = wordpressUpdateFailure(connect);
  if (wordpressFailure) {
    await domainAction(supabase, "register", context.siteId, hostname);
    throw new CliError(
      `The CDN hostname was connected, but WordPress could not update the site URL: ${wordpressFailure}`,
    );
  }
  const currentHost = cleanHost(context.site.url);
  if (!currentHost || isManagedStudioHostname(currentHost)) {
    const { error } = await supabase.from("site").update({ url: `https://${hostname}` }).eq("id", context.siteId);
    if (error) throw new CliError(error.message);
  }

  const registry = await domainAction(supabase, "register", context.siteId, hostname);
  const refresh = await refreshDomains(supabase, context.siteId);
  const exported = await exportSite(supabase, context.siteId);
  const warnings = connectWarnings(connect);
  return {
    domain: hostname,
    connect,
    refresh,
    registry,
    export: exported,
    ...(warnings.length ? { warnings } : {}),
  };
}

export async function setPrimaryDomain(
  supabase: SupabaseClient,
  siteId: string,
  domain: string,
): Promise<DomainMutationResult> {
  const hostname = normalizeDomain(domain);
  const context = await domainContext(supabase, siteId);
  const ownership = await domainAction(supabase, "lookup", context.siteId, hostname);
  if (ownership?.conflict) {
    throw new CliError(`${hostname} is already connected to another site.`);
  }
  const hostnames = (await getHostnames(supabase, context.pullZoneId)).map(cleanHost);
  if (!hostnames.map((item) => item.toLowerCase()).includes(hostname)) {
    throw new CliError(`${hostname} is not connected to this site's CDN zone.`);
  }

  const connect = await connectDomain(supabase, context, hostname, { updateOnly: true });
  const wordpressFailure = wordpressUpdateFailure(connect);
  if (wordpressFailure) {
    throw new CliError(`WordPress could not update the primary domain: ${wordpressFailure}`);
  }
  const { error } = await supabase
    .from("site")
    .update({ url: `https://${hostname}` })
    .eq("id", context.siteId);
  if (error) throw new CliError(error.message);

  const registry = await domainAction(supabase, "register", context.siteId, hostname);
  const refresh = await refreshDomains(supabase, context.siteId);
  const exported = await exportSite(supabase, context.siteId);
  const warnings = connectWarnings(connect);
  return {
    domain: hostname,
    primary: hostname,
    connect,
    refresh,
    registry,
    export: exported,
    ...(warnings.length ? { warnings } : {}),
  };
}

export async function setMountPath(
  supabase: SupabaseClient,
  siteId: string,
  publicDomain: string,
  mountPath: string,
): Promise<DomainMutationResult & { mount_path: string }> {
  const hostname = normalizeDomain(publicDomain);
  const normalizedMountPath = normalizeMountPath(mountPath);
  const context = await domainContext(supabase, siteId);
  const connect = await connectDomain(supabase, context, hostname, {
    updateOnly: true,
    mountPath: normalizedMountPath,
  });
  const wordpressFailure = wordpressUpdateFailure(connect);
  if (wordpressFailure) {
    throw new CliError(`WordPress could not update the mount path: ${wordpressFailure}`);
  }
  const { error } = await supabase
    .from("site")
    .update({ url: `https://${hostname}`, mount_path: normalizedMountPath })
    .eq("id", context.siteId);
  if (error) throw new CliError(error.message);

  const refresh = await refreshDomains(supabase, context.siteId);
  const exported = await exportSite(supabase, context.siteId);
  const warnings = connectWarnings(connect);
  return {
    domain: hostname,
    primary: hostname,
    mount_path: normalizedMountPath,
    connect,
    refresh,
    export: exported,
    ...(warnings.length ? { warnings } : {}),
  };
}

export async function removeDomain(
  supabase: SupabaseClient,
  siteId: string,
  domain: string,
): Promise<DomainMutationResult> {
  const hostname = normalizeDomain(domain);
  if (isManagedStudioHostname(hostname) || isProviderHostname(hostname)) {
    throw new CliError("Managed Studio and CDN provider hostnames cannot be removed.");
  }
  const context = await domainContext(supabase, siteId);
  await domainAction(supabase, "lookup", context.siteId, hostname);
  const hostnames = (await getHostnames(supabase, context.pullZoneId)).map(cleanHost);
  const domainsToRemove = new Set([
    hostname,
    hostname.startsWith("www.") ? hostname.replace(/^www\./, "") : `www.${hostname}`,
  ]);
  const existing = [...domainsToRemove].filter((item) => hostnames.includes(item));
  if (existing.length === 0) {
    throw new CliError(`${hostname} is not connected to this site's CDN zone.`);
  }

  const remaining = hostnames.filter((item) => !domainsToRemove.has(item));
  const managedFallback = remaining.find((item) => isManagedStudioHostname(item));
  const customFallback = remaining.find((item) =>
    !isManagedStudioHostname(item) && !isProviderHostname(item)
  );
  const currentPrimary = cleanHost(context.site.url);
  const newPrimary = domainsToRemove.has(currentPrimary)
    ? managedFallback || customFallback || managedPublicHostFromAdminUrl(String(context.meta.admin_url))
    : currentPrimary;

  for (const item of existing) {
    const result = await invokeFunction<{
      removal?: { removed?: boolean; warning?: string | null };
    }>(supabase, "remove-domain", {
      pullZoneId: context.pullZoneId,
      domain: item,
      siteId: context.siteId,
      site_url: context.wordpressUrl,
      oldUrl: `https://${newPrimary}`,
      secret_key: context.meta.secret_key,
      basic_auth_user: context.meta.basic_auth_user,
      basic_auth_password: context.meta.basic_auth_password,
      bedrock: Boolean(context.site.bedrock),
      mount_path: context.mountPath,
    });
    if (result.removal?.removed !== true) {
      throw new CliError(result.removal?.warning || `The CDN did not remove ${item}.`);
    }
  }

  if (newPrimary && newPrimary !== currentPrimary) {
    const { error } = await supabase
      .from("site")
      .update({ url: `https://${newPrimary}` })
      .eq("id", context.siteId);
    if (error) throw new CliError(error.message);
  }

  const registry = await domainAction(supabase, "unregister", context.siteId, hostname);
  const refresh = await refreshDomains(supabase, context.siteId);
  return {
    domain: hostname,
    removed: existing,
    primary: newPrimary || null,
    refresh,
    registry,
  };
}

export async function issueSsl(
  supabase: SupabaseClient,
  siteId: string,
  domain: string,
  includeSecondary = true,
): Promise<unknown> {
  const safeSiteId = assertSafeId(siteId, "siteId");
  assertDomainActionReady(await getSite(supabase, safeSiteId));
  return invokeFunction(supabase, "issue-ssl", {
    siteId: safeSiteId,
    domain: normalizeDomain(domain),
    includeSecondary,
  });
}

export async function transferDomain(
  supabase: SupabaseClient,
  sourceSiteId: string,
  targetSiteId: string,
  domain: string,
): Promise<unknown> {
  const source = assertSafeId(sourceSiteId, "sourceSiteId");
  const target = assertSafeId(targetSiteId, "targetSiteId");
  const hostname = normalizeDomain(domain);
  if (isManagedStudioHostname(hostname) || isProviderHostname(hostname)) {
    throw new CliError("Only custom domains can be transferred between sites.");
  }
  if (source === target) {
    throw new CliError("Source and target sites must be different.");
  }
  const [sourceSite, targetSite] = await Promise.all([
    getSite(supabase, source),
    getSite(supabase, target),
  ]);
  assertDomainActionReady(sourceSite);
  assertDomainActionReady(targetSite);
  const transfer = await invokeFunction<Record<string, unknown>>(supabase, "domain-actions", {
    action: "transfer",
    source_site_id: source,
    site_id: target,
    hostname,
  });
  const exported = await exportSite(supabase, target);
  return { ...transfer, export: exported };
}

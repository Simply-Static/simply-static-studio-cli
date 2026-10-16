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

type WordPressRuntimeState = {
  desired_state?: string | null;
  observed_state?: string | null;
  transitioning?: boolean;
  job?: { status?: string | null } | null;
};

export interface DomainRuntimeOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface AddDomainOptions {
  prepareOnly?: boolean;
  includeSecondary?: boolean;
  runtime?: DomainRuntimeOptions;
}

export interface DomainMutationResult {
  domain: string;
  primary?: string | null;
  removed?: string[];
  prepared?: boolean;
  connect?: unknown;
  ssl?: unknown;
  sslWarning?: string | null;
  refresh?: unknown;
  registry?: unknown;
  export?: unknown;
  warnings?: string[];
}

const WORDPRESS_START_POLL_INTERVAL_MS = 1_500;
const WORDPRESS_START_TIMEOUT_MS = 120_000;

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
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname
      .toLowerCase()
      .replace(/\.$/, "");
  } catch {
    return raw.replace(/^https?:\/\//i, "").split("/")[0]?.toLowerCase().replace(/\.$/, "") || "";
  }
}

function isManagedStudioHostname(hostname: string): boolean {
  const normalized = cleanHost(hostname);
  return normalized === "onstatic.studio" ||
    normalized.endsWith(".onstatic.studio") ||
    normalized === "static.studio" ||
    normalized.endsWith(".static.studio") ||
    /\.static\d+\.studio$/.test(hostname);
}

function isProviderHostname(hostname: string): boolean {
  const normalized = cleanHost(hostname);
  return normalized === "b-cdn.net" || normalized.endsWith(".b-cdn.net");
}

function assertDomainActionReady(site: SiteRecord): void {
  if (site.status !== "deployed") {
    throw new CliError("Domain actions are available after this site finishes deploying.");
  }
}

function siteUrlFromAdminUrl(adminUrl: string): string {
  return adminUrl.replace(/\/wp\/wp-admin\/?$/i, "/wp").replace(/\/wp-admin\/?$/i, "");
}

function propertyString(record: Record<string, unknown>, key: string): string {
  return String(record[key] ?? "").trim();
}

function managedPublicHostFromAdminUrl(adminUrl: string, site: SiteRecord): string {
  const adminHost = cleanHost(adminUrl);
  const provisioningId = propertyString(site, "provisioning_id").toLowerCase();
  const wordpressBaseDomain = cleanHost(site.wordpress_base_domain);

  if (
    /^[a-z]{2}[a-z0-9]{13}$/.test(provisioningId) &&
    wordpressBaseDomain
  ) {
    return `${provisioningId}.${wordpressBaseDomain}`;
  }
  if (provisioningId && adminHost.startsWith(`wp-${provisioningId}.`)) {
    return adminHost.slice(3);
  }
  if (adminHost.startsWith("wp.")) {
    return adminHost.slice(3);
  }
  if (
    adminHost.startsWith("wp-") &&
    (adminHost.endsWith(".onstatic.studio") || adminHost.endsWith(".static.studio"))
  ) {
    return adminHost.slice(3);
  }
  return "";
}

function managedStaticHostname(site: SiteRecord, adminUrl: string): string {
  return managedPublicHostFromAdminUrl(adminUrl, site);
}

function isManagedHostnameForSite(
  hostname: string,
  site: SiteRecord,
  adminUrl: string,
): boolean {
  const normalized = cleanHost(hostname);
  if (isManagedStudioHostname(normalized) || isProviderHostname(normalized)) return true;
  const brandedStaticHost = managedStaticHostname(site, adminUrl);
  if (brandedStaticHost && normalized === brandedStaticHost) return true;
  const managedUrl = cleanHost(site.managed_url);
  return Boolean(managedUrl && normalized === managedUrl);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function wordpressRuntimeReady(site: WordPressRuntimeState): boolean {
  return site.desired_state === "on" && site.observed_state === "on";
}

function wordpressRuntimeFailed(site: WordPressRuntimeState): boolean {
  const jobStatus = String(site.job?.status || "");
  return site.observed_state === "failed" || ["failed", "cancelled"].includes(jobStatus);
}

async function invokeWordPressLifecycle(
  supabase: SupabaseClient,
  siteId: string,
  action: "status" | "start",
): Promise<WordPressRuntimeState> {
  const result = await invokeFunction<{ site?: WordPressRuntimeState }>(
    supabase,
    "platform-site-lifecycle",
    { site_id: siteId, action },
  );
  if (!result?.site || typeof result.site !== "object") {
    throw new CliError("WordPress returned an invalid runtime status.");
  }
  return result.site;
}

export async function ensureWordPressReadyForDomain(
  supabase: SupabaseClient,
  siteId: string,
  options: DomainRuntimeOptions = {},
): Promise<WordPressRuntimeState> {
  const safeSiteId = assertSafeId(siteId, "siteId");
  const pollIntervalMs = options.pollIntervalMs ?? WORDPRESS_START_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? WORDPRESS_START_TIMEOUT_MS;
  const sleep = options.sleep ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new CliError("Runtime pollIntervalMs must be greater than zero.");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new CliError("Runtime timeoutMs must be greater than zero.");
  }

  let pollsRemaining = Math.max(1, Math.ceil(timeoutMs / pollIntervalMs));
  let runtime = await invokeWordPressLifecycle(supabase, safeSiteId, "status");
  const pollStatus = async (): Promise<WordPressRuntimeState> => {
    if (pollsRemaining <= 0) {
      throw new CliError(
        "WordPress did not finish starting in time. Please try connecting the domain again.",
      );
    }
    pollsRemaining -= 1;
    await sleep(pollIntervalMs);
    return invokeWordPressLifecycle(supabase, safeSiteId, "status");
  };

  while (!wordpressRuntimeReady(runtime) && runtime.transitioning === true) {
    runtime = await pollStatus();
  }
  if (wordpressRuntimeReady(runtime)) return runtime;

  try {
    runtime = await invokeWordPressLifecycle(supabase, safeSiteId, "start");
  } catch (error) {
    throw new CliError(
      `WordPress could not be started automatically before connecting the domain: ${errorMessage(error)}`,
    );
  }

  while (!wordpressRuntimeReady(runtime)) {
    if (wordpressRuntimeFailed(runtime)) {
      throw new CliError(
        "WordPress could not be started automatically before connecting the domain.",
      );
    }
    runtime = await pollStatus();
  }
  return runtime;
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
  if (result?.wordpress?.updated !== true) {
    return "WordPress did not confirm the domain update.";
  }
  return null;
}

export function automaticSslWarning(error: unknown): string {
  return `its SSL certificate could not be issued automatically: ${errorMessage(error)}`;
}

async function requestSsl(
  supabase: SupabaseClient,
  siteId: string,
  domain: string,
  includeSecondary: boolean,
): Promise<unknown> {
  return invokeFunction(supabase, "issue-ssl", {
    siteId,
    domain,
    includeSecondary,
  });
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
  options: AddDomainOptions = {},
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

  await ensureWordPressReadyForDomain(supabase, context.siteId, options.runtime);
  let connect: any;
  try {
    connect = await connectDomain(supabase, context, hostname, {
      ...(options.prepareOnly ? { updateOnly: true } : {}),
      ...(options.includeSecondary === undefined
        ? {}
        : { includeSecondary: options.includeSecondary }),
    });
  } catch (error) {
    if (
      !options.prepareOnly &&
      error instanceof CliError &&
      error.canPrepareWithoutDns === true
    ) {
      throw new CliError(
        `${error.message} Run the command again with --prepare-only to update WordPress and start an export before changing DNS.`,
        error.exitCode,
        {
          ...(error.status === undefined ? {} : { status: error.status }),
          ...(error.code === undefined ? {} : { code: error.code }),
          ...(error.deliveryAmbiguous === undefined
            ? {}
            : { deliveryAmbiguous: error.deliveryAmbiguous }),
          canPrepareWithoutDns: true,
        },
      );
    }
    throw error;
  }
  const wordpressFailure = wordpressUpdateFailure(connect);
  if (wordpressFailure) {
    throw new CliError(
      `${wordpressFailure} The existing public URL and export were left unchanged. Please try again.`,
    );
  }

  const warnings = connectWarnings(connect);
  let ssl: unknown;
  let sslWarning: string | null = null;
  if (!options.prepareOnly) {
    try {
      ssl = await requestSsl(
        supabase,
        context.siteId,
        hostname,
        options.includeSecondary !== false,
      );
    } catch (error) {
      sslWarning = automaticSslWarning(error);
      warnings.push(sslWarning);
    }
  }

  const currentHost = cleanHost(context.site.url);
  const brandedStaticHost = managedStaticHostname(
    context.site,
    String(context.meta.admin_url),
  );
  if (
    options.prepareOnly ||
    !currentHost ||
    isManagedStudioHostname(currentHost) ||
    currentHost === brandedStaticHost
  ) {
    const { error } = await supabase.from("site").update({ url: `https://${hostname}` }).eq("id", context.siteId);
    if (error) throw new CliError(error.message);
  }

  let refresh: unknown;
  if (!options.prepareOnly) {
    try {
      refresh = await refreshDomains(supabase, context.siteId);
    } catch (error) {
      warnings.push(
        `The domain is connected, but its edge rules could not be refreshed: ${errorMessage(error)}`,
      );
    }
  }
  const exported = await exportSite(supabase, context.siteId);
  let registry: unknown;
  if (!options.prepareOnly) {
    try {
      registry = await domainAction(supabase, "register", context.siteId, hostname);
    } catch (error) {
      warnings.push(
        `The domain is connected, but its ownership record could not be registered: ${errorMessage(error)}`,
      );
    }
  }

  return {
    domain: hostname,
    prepared: options.prepareOnly === true,
    connect,
    sslWarning,
    ...(ssl === undefined ? {} : { ssl }),
    ...(refresh === undefined ? {} : { refresh }),
    ...(registry === undefined ? {} : { registry }),
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
  const warnings = connectWarnings(connect);
  let refresh: unknown;
  try {
    refresh = await refreshDomains(supabase, context.siteId);
  } catch (error) {
    warnings.push(
      `The primary domain was updated, but its edge rules could not be refreshed: ${errorMessage(error)}`,
    );
  }
  const exported = await exportSite(supabase, context.siteId);
  return {
    domain: hostname,
    primary: hostname,
    connect,
    ...(refresh === undefined ? {} : { refresh }),
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

  const warnings = connectWarnings(connect);
  let refresh: unknown;
  try {
    refresh = await refreshDomains(supabase, context.siteId);
  } catch (error) {
    warnings.push(
      `The mount path was updated, but its edge rules could not be refreshed: ${errorMessage(error)}`,
    );
  }
  const exported = await exportSite(supabase, context.siteId);
  return {
    domain: hostname,
    primary: hostname,
    mount_path: normalizedMountPath,
    connect,
    ...(refresh === undefined ? {} : { refresh }),
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
  if (isManagedHostnameForSite(hostname, context.site, String(context.meta.admin_url))) {
    throw new CliError("Managed Studio and CDN provider hostnames cannot be removed.");
  }
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
  const brandedStaticHost = managedStaticHostname(
    context.site,
    String(context.meta.admin_url),
  );
  const managedFallback = remaining.find((item) => item === brandedStaticHost) ||
    remaining.find((item) => item.endsWith(".onstatic.studio"));
  const customFallbacks = remaining.filter((item) =>
    !isManagedStudioHostname(item) &&
    !isProviderHostname(item) &&
    item !== brandedStaticHost
  );
  const fallbackStaticHost = managedFallback || brandedStaticHost ||
    cleanHost(context.site.managed_url);
  const currentPrimary = cleanHost(context.site.url);
  const removingPrimary = domainsToRemove.has(currentPrimary);
  let newPrimary = currentPrimary;
  if (removingPrimary || customFallbacks.length === 0) {
    if (managedFallback) {
      newPrimary = managedFallback;
    } else if (removingPrimary) {
      newPrimary = customFallbacks[0] || fallbackStaticHost;
    }
  }
  const effectivePrimary = newPrimary || fallbackStaticHost;
  const oldUrl = effectivePrimary ? `https://${effectivePrimary}` : "";

  for (const item of existing) {
    const result = await invokeFunction<{
      removal?: { removed?: boolean; warning?: string | null };
    }>(supabase, "remove-domain", {
      pullZoneId: context.pullZoneId,
      domain: item,
      siteId: context.siteId,
      site_url: context.wordpressUrl,
      oldUrl,
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

  const warnings: string[] = [];
  let refresh: unknown;
  try {
    refresh = await refreshDomains(supabase, context.siteId);
  } catch (error) {
    warnings.push(
      `The domain was removed, but its edge rules could not be refreshed: ${errorMessage(error)}`,
    );
  }
  const registry = await domainAction(supabase, "unregister", context.siteId, hostname);
  return {
    domain: hostname,
    removed: existing,
    primary: newPrimary || null,
    ...(refresh === undefined ? {} : { refresh }),
    registry,
    ...(warnings.length ? { warnings } : {}),
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
  return requestSsl(supabase, safeSiteId, normalizeDomain(domain), includeSecondary);
}

export async function transferDomain(
  supabase: SupabaseClient,
  sourceSiteId: string,
  targetSiteId: string,
  domain: string,
): Promise<Record<string, unknown>> {
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
  if (
    isManagedHostnameForSite(hostname, sourceSite, "") ||
    isManagedHostnameForSite(hostname, targetSite, "")
  ) {
    throw new CliError("Only custom domains can be transferred between sites.");
  }
  const transfer = await invokeFunction<Record<string, unknown>>(supabase, "domain-actions", {
    action: "transfer",
    source_site_id: source,
    site_id: target,
    hostname,
  });
  let ssl: unknown;
  let sslWarning: string | null = null;
  try {
    ssl = await requestSsl(supabase, target, hostname, true);
  } catch (error) {
    sslWarning = automaticSslWarning(error);
  }
  const exported = await exportSite(supabase, target);
  const transferWarnings = Array.isArray(transfer.warnings)
    ? transfer.warnings.map(String)
    : [];
  const warnings = sslWarning
    ? [...transferWarnings, sslWarning]
    : transferWarnings;
  return {
    ...transfer,
    export: exported,
    sslWarning,
    ...(ssl === undefined ? {} : { ssl }),
    ...(warnings.length ? { warnings } : {}),
  };
}

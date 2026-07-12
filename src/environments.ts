import type { SupabaseClient } from "@supabase/supabase-js";
import { CliError } from "./errors.js";
import { getSite, getSiteMeta } from "./sites.js";
import { invokeFunction } from "./supabase.js";
import type { SiteMetaRecord, SiteRecord } from "./types.js";
import { assertSafeId, environmentSlug, normalizeEnvironmentTitle } from "./validation.js";

export interface EnvironmentRecord {
  id: string | number;
  site_id?: string | number;
  name?: string;
  title?: string;
  url?: string;
  storage_zone_id?: string | number | null;
  pull_zone_id?: string | number | null;
  [key: string]: unknown;
}

export interface EnvironmentStatus {
  enabled: boolean;
  addon?: unknown;
  environments: EnvironmentRecord[];
}

export type EnvironmentReference = string | number;

export interface EnvironmentHostnameState {
  environment: EnvironmentRecord;
  managedHostname: string;
  hostnames: string[];
  customHostnames: string[];
}

export interface EnvironmentDomainMutationResult extends EnvironmentHostnameState {
  domain?: string;
  removed: string[];
  unchanged?: boolean;
  connect?: unknown;
  wordpress?: unknown;
  edgeRules?: unknown;
  warnings: string[];
}

type EnvironmentDomainContext = {
  siteId: string;
  site: SiteRecord;
  meta: SiteMetaRecord;
  environment: EnvironmentRecord;
  environmentName: string;
  pullZoneId: string;
  managedHostname: string;
  managedSubdomain: string;
  managedTld: string;
  wordpressUrl: string;
};

function normalizeHostname(value: unknown, label = "hostname"): string {
  const raw = String(value ?? "").trim().replace(/[\u3002\uFF0E\uFF61]/g, ".");
  if (!raw) throw new CliError(`${label} is required.`);

  let parsed: URL;
  try {
    parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new CliError(`${label} must be a valid hostname.`);
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    parsed.search ||
    parsed.hash
  ) {
    throw new CliError(`${label} must be a hostname without credentials, a port, a path, a query, or a fragment.`);
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  const valid = hostname.length <= 253 &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname);
  if (!valid) throw new CliError(`${label} must be a valid hostname.`);
  return hostname;
}

function isManagedStudioHostname(hostname: string): boolean {
  return hostname.endsWith(".b-cdn.net") ||
    hostname.endsWith(".onstatic.studio") ||
    /\.static\d*\.studio$/.test(hostname);
}

function managedEnvironmentParts(environment: EnvironmentRecord): {
  hostname: string;
  subdomain: string;
  tld: string;
} {
  const hostname = normalizeHostname(environment.url, "Environment managed hostname");
  const suffix = hostname.endsWith(".onstatic.studio")
    ? ".onstatic.studio"
    : hostname.match(/\.static\d*\.studio$/)?.[0];
  if (!suffix) {
    throw new CliError("Could not determine the environment Studio hostname.");
  }
  const subdomain = hostname.slice(0, -suffix.length);
  if (!subdomain) throw new CliError("Could not determine the environment Studio subdomain.");
  return { hostname, subdomain, tld: suffix.slice(1) };
}

function wordpressUrlFromAdminUrl(adminUrl: string): string {
  return adminUrl.replace(/\/wp-admin\/?$/i, "").replace(/\/$/, "");
}

function environmentLookupValue(value: EnvironmentReference): string {
  const lookup = String(value ?? "").trim();
  if (!lookup || lookup.length > 200 || /[\u0000-\u001f\u007f]/.test(lookup)) {
    throw new CliError("Environment identifier must be between 1 and 200 printable characters.");
  }
  return lookup;
}

export async function resolveEnvironment(
  supabase: SupabaseClient,
  siteId: string,
  reference: EnvironmentReference,
): Promise<EnvironmentRecord> {
  const safeSiteId = assertSafeId(siteId, "siteId");
  const lookup = environmentLookupValue(reference);
  const lowerLookup = lookup.toLowerCase();
  const slugLookup = environmentSlug(lookup);
  const { data, error } = await supabase
    .from("site_environment")
    .select("*")
    .eq("site_id", safeSiteId)
    .order("created_at", { ascending: true });
  if (error) throw new CliError(error.message);

  const environments = (data || []) as EnvironmentRecord[];
  const environment = environments.find((item) => String(item.id) === lookup) ||
    environments.find((item) => String(item.name || "").toLowerCase() === lowerLookup) ||
    environments.find((item) => String(item.name || "").toLowerCase() === slugLookup) ||
    environments.find((item) => String(item.title || "").toLowerCase() === lowerLookup);
  if (!environment) {
    throw new CliError(`Environment ${lookup} was not found for site ${safeSiteId}.`);
  }
  return environment;
}

async function environmentDomainContext(
  supabase: SupabaseClient,
  siteId: string,
  reference: EnvironmentReference,
): Promise<EnvironmentDomainContext> {
  const safeSiteId = assertSafeId(siteId, "siteId");
  const [site, meta, environment] = await Promise.all([
    getSite(supabase, safeSiteId),
    getSiteMeta(supabase, safeSiteId),
    resolveEnvironment(supabase, safeSiteId, reference),
  ]);
  if (site.status !== "deployed") {
    throw new CliError("Environment domain actions are available after the parent site finishes deploying.");
  }
  if (!environment.pull_zone_id) {
    throw new CliError("This environment is missing a CDN pull zone.");
  }
  if (!environment.name) {
    throw new CliError("This environment is missing its WordPress environment name.");
  }
  if (!meta.admin_url || !meta.secret_key) {
    throw new CliError("Site metadata is missing admin_url or secret_key.");
  }
  const managed = managedEnvironmentParts(environment);
  return {
    siteId: safeSiteId,
    site,
    meta,
    environment,
    environmentName: String(environment.name),
    pullZoneId: String(environment.pull_zone_id),
    managedHostname: managed.hostname,
    managedSubdomain: managed.subdomain,
    managedTld: managed.tld,
    wordpressUrl: wordpressUrlFromAdminUrl(meta.admin_url),
  };
}

async function getHostnamesForContext(
  supabase: SupabaseClient,
  context: EnvironmentDomainContext,
): Promise<EnvironmentHostnameState> {
  const result = await invokeFunction<{ hostnames?: unknown[] }>(supabase, "get-hostnames", {
    pullZoneId: context.pullZoneId,
  });
  const hostnames = [...new Set((Array.isArray(result.hostnames) ? result.hostnames : [])
    .map((hostname) => normalizeHostname(hostname, "CDN hostname")))];
  return {
    environment: context.environment,
    managedHostname: context.managedHostname,
    hostnames,
    customHostnames: hostnames.filter((hostname) => !isManagedStudioHostname(hostname)),
  };
}

export async function listEnvironmentHostnames(
  supabase: SupabaseClient,
  siteId: string,
  reference: EnvironmentReference,
): Promise<EnvironmentHostnameState> {
  const context = await environmentDomainContext(supabase, siteId, reference);
  return getHostnamesForContext(supabase, context);
}

function wordpressConnectionBody(context: EnvironmentDomainContext) {
  return {
    siteId: context.siteId,
    environmentName: context.environmentName,
    secret_key: context.meta.secret_key,
    site_url: context.wordpressUrl,
    bedrock: Boolean(context.site.bedrock),
  };
}

async function removeEnvironmentHostname(
  supabase: SupabaseClient,
  context: EnvironmentDomainContext,
  hostname: string,
): Promise<unknown> {
  const result = await invokeFunction<{
    removal?: { removed?: boolean; warning?: string | null };
  }>(supabase, "remove-domain", {
    pullZoneId: context.pullZoneId,
    domain: hostname,
    siteId: context.siteId,
    environmentName: context.environmentName,
  });
  if (result.removal?.removed !== true) {
    throw new CliError(result.removal?.warning || `The CDN did not remove ${hostname}.`);
  }
  return result;
}

function operationWarnings(result: any): string[] {
  const warnings: string[] = [];
  if (result?.wordpress?.warning) warnings.push(String(result.wordpress.warning));
  if (result?.secondary?.error) warnings.push(String(result.secondary.error));
  const edgeWarning = result?.warning;
  if (typeof edgeWarning === "string") warnings.push(edgeWarning);
  if (edgeWarning && typeof edgeWarning === "object") {
    if (edgeWarning.message) warnings.push(String(edgeWarning.message));
    for (const rule of Array.isArray(edgeWarning.rules) ? edgeWarning.rules : []) {
      const detail = rule?.details || rule?.error;
      if (detail) warnings.push(String(detail));
    }
  }
  return warnings;
}

async function syncEnvironmentEdgeRules(
  supabase: SupabaseClient,
  context: EnvironmentDomainContext,
  customDomain?: string,
): Promise<unknown> {
  return invokeFunction(supabase, "create-edge-rules", {
    pullZoneId: context.pullZoneId,
    subdomain: context.managedSubdomain,
    tld: context.managedTld,
    ...(customDomain ? { newDomain: customDomain } : {}),
  });
}

export async function connectEnvironmentDomain(
  supabase: SupabaseClient,
  siteId: string,
  reference: EnvironmentReference,
  domain: string,
): Promise<EnvironmentDomainMutationResult> {
  const hostname = normalizeHostname(domain, "Custom domain");
  if (isManagedStudioHostname(hostname)) {
    throw new CliError("Environment custom domains cannot use a managed Studio hostname.");
  }
  const context = await environmentDomainContext(supabase, siteId, reference);
  const before = await getHostnamesForContext(supabase, context);
  if (before.customHostnames.length === 1 && before.customHostnames[0] === hostname) {
    return { ...before, domain: hostname, removed: [], unchanged: true, warnings: [] };
  }

  const removed: string[] = [];
  for (const existing of before.customHostnames) {
    await removeEnvironmentHostname(supabase, context, existing);
    removed.push(existing);
  }

  const connect = await invokeFunction<any>(supabase, "connect-domain", {
    pullZoneId: context.pullZoneId,
    domain: hostname,
    includeSecondary: false,
    ...wordpressConnectionBody(context),
  });
  const edgeRules = await syncEnvironmentEdgeRules(supabase, context, hostname);
  const after = await getHostnamesForContext(supabase, context);
  return {
    ...after,
    domain: hostname,
    removed,
    connect,
    edgeRules,
    warnings: [...operationWarnings(connect), ...operationWarnings(edgeRules)],
  };
}

export async function removeEnvironmentDomains(
  supabase: SupabaseClient,
  siteId: string,
  reference: EnvironmentReference,
): Promise<EnvironmentDomainMutationResult> {
  const context = await environmentDomainContext(supabase, siteId, reference);
  const before = await getHostnamesForContext(supabase, context);
  const removed: string[] = [];
  for (const hostname of before.customHostnames) {
    await removeEnvironmentHostname(supabase, context, hostname);
    removed.push(hostname);
  }
  if (removed.length === 0) {
    return { ...before, removed, unchanged: true, warnings: [] };
  }

  const wordpress = await invokeFunction<any>(supabase, "connect-domain", {
    pullZoneId: context.pullZoneId,
    domain: context.managedHostname,
    updateOnly: true,
    includeSecondary: false,
    ...wordpressConnectionBody(context),
  });
  const edgeRules = await syncEnvironmentEdgeRules(supabase, context);
  const after = await getHostnamesForContext(supabase, context);
  return {
    ...after,
    removed,
    wordpress,
    edgeRules,
    warnings: [...operationWarnings(wordpress), ...operationWarnings(edgeRules)],
  };
}

export async function issueEnvironmentSsl(
  supabase: SupabaseClient,
  siteId: string,
  reference: EnvironmentReference,
  domain: string,
): Promise<unknown> {
  const hostname = normalizeHostname(domain, "SSL hostname");
  const context = await environmentDomainContext(supabase, siteId, reference);
  const state = await getHostnamesForContext(supabase, context);
  if (!state.hostnames.includes(hostname)) {
    throw new CliError(`${hostname} is not connected to this environment's CDN zone.`);
  }
  return invokeFunction(supabase, "issue-ssl", {
    domain: hostname,
    includeSecondary: false,
    siteId: context.siteId,
  });
}

export const connectEnvironmentCustomDomain = connectEnvironmentDomain;
export const removeEnvironmentCustomDomains = removeEnvironmentDomains;

export function parentSubdomainFromAdminUrl(adminUrl: string): string {
  const url = new URL(adminUrl);
  const parts = url.hostname.split(".");
  const first = parts[0] || "";
  if (first.startsWith("wp-")) return first.replace(/^wp-/, "");
  if (first === "wp" && parts[1]) return parts[1];
  if (first) return first;
  throw new CliError("Could not determine parent subdomain from admin_url.");
}

async function environmentContext(
  supabase: SupabaseClient,
  siteId: string,
): Promise<{ siteId: string; parentSubdomain: string; secretKey: string }> {
  const safeSiteId = assertSafeId(siteId, "siteId");
  const meta = await getSiteMeta(supabase, safeSiteId);
  if (!meta.admin_url || !meta.secret_key) {
    throw new CliError("Site metadata is missing admin_url or secret_key.");
  }
  return {
    siteId: safeSiteId,
    parentSubdomain: parentSubdomainFromAdminUrl(meta.admin_url),
    secretKey: meta.secret_key,
  };
}

export async function getEnvironmentStatus(
  supabase: SupabaseClient,
  siteId: string,
): Promise<EnvironmentStatus> {
  const safeSiteId = assertSafeId(siteId, "siteId");
  const [{ data: addon, error: addonError }, { data: environments, error: envError }] = await Promise.all([
    supabase.from("addon").select("*").eq("site_id", safeSiteId).maybeSingle(),
    supabase.from("site_environment").select("*").eq("site_id", safeSiteId).order("created_at", { ascending: true }),
  ]);

  if (addonError) throw new CliError(addonError.message);
  if (envError) throw new CliError(envError.message);

  return {
    enabled: Boolean((addon as { environments?: boolean } | null)?.environments),
    ...(addon ? { addon } : {}),
    environments: (environments || []) as EnvironmentRecord[],
  };
}

export async function enableEnvironments(
  supabase: SupabaseClient,
  siteId: string,
): Promise<EnvironmentStatus> {
  const safeSiteId = assertSafeId(siteId, "siteId");

  try {
    await invokeFunction(supabase, "create-environment-wp", {
      title: "Production",
      slug: "production",
      site_id: safeSiteId,
    });
  } catch {
    // The database flag is still the source of truth for enabling the add-on.
  }

  const { data: existingAddon, error: fetchError } = await supabase
    .from("addon")
    .select("id")
    .eq("site_id", safeSiteId)
    .maybeSingle();
  if (fetchError) throw new CliError(fetchError.message);

  if (existingAddon) {
    const { error } = await supabase.from("addon").update({ environments: true }).eq("site_id", safeSiteId);
    if (error) throw new CliError(error.message);
  } else {
    const { error } = await supabase.from("addon").insert({ site_id: safeSiteId, environments: true });
    if (error) throw new CliError(error.message);
  }

  return getEnvironmentStatus(supabase, safeSiteId);
}

export async function createEnvironment(
  supabase: SupabaseClient,
  siteId: string,
  title: string,
): Promise<unknown> {
  const cleanTitle = normalizeEnvironmentTitle(title);
  const context = await environmentContext(supabase, siteId);
  return invokeFunction(supabase, "create-environment", {
    site_id: context.siteId,
    parent_subdomain: context.parentSubdomain,
    title: cleanTitle,
    secret_key: context.secretKey,
  });
}

export async function deleteEnvironment(
  supabase: SupabaseClient,
  siteId: string,
  nameOrTitle: string,
  options: { disableIntegration?: boolean } = {},
): Promise<unknown> {
  const context = await environmentContext(supabase, siteId);
  const name = environmentSlug(nameOrTitle) || assertSafeId(nameOrTitle, "environment name");
  if (name === "production") {
    throw new CliError("Production cannot be deleted as a child environment.");
  }

  return invokeFunction(supabase, "delete-environment", {
    site_id: context.siteId,
    parent_subdomain: context.parentSubdomain,
    name,
    secret_key: context.secretKey,
    ...(options.disableIntegration ? { disable_integration: true } : {}),
  });
}

export async function disableEnvironments(
  supabase: SupabaseClient,
  siteId: string,
): Promise<{ disabled: true; deleted: unknown[] }> {
  const safeSiteId = assertSafeId(siteId, "siteId");
  await getSite(supabase, safeSiteId);
  const context = await environmentContext(supabase, safeSiteId);
  const status = await getEnvironmentStatus(supabase, safeSiteId);
  const deleted: unknown[] = [];

  if (status.environments.length > 0) {
    for (let index = 0; index < status.environments.length; index += 1) {
      const environment = status.environments[index];
      if (!environment) continue;
      const name = String(environment.name || "");
      if (!name) continue;
      deleted.push(
        await invokeFunction(supabase, "delete-environment", {
          site_id: context.siteId,
          parent_subdomain: context.parentSubdomain,
          name,
          secret_key: context.secretKey,
          ...(index === status.environments.length - 1 ? { disable_integration: true } : {}),
        }),
      );
    }
  } else {
    deleted.push(
      await invokeFunction(supabase, "delete-environment", {
        site_id: context.siteId,
        parent_subdomain: context.parentSubdomain,
        secret_key: context.secretKey,
        disable_integration: true,
      }),
    );
  }

  const { error } = await supabase.from("addon").delete().eq("site_id", safeSiteId);
  if (error) throw new CliError(error.message);

  return { disabled: true, deleted };
}

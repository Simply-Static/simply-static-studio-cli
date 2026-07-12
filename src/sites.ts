import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_TLD, SUPABASE_API_VERSION } from "./constants.js";
import { CliError } from "./errors.js";
import { invokeFunction } from "./supabase.js";
import { randomAlpha, randomAlphanumeric, randomDomainWord } from "./random.js";
import type { SiteMetaRecord, SiteRecord } from "./types.js";
import {
  assertSafeId,
  normalizeMountPath,
  parsePositiveInteger,
  requireAllowedValue,
  sanitizeSearchTerm,
} from "./validation.js";

export interface CreateSiteOptions {
  name?: string;
  subdomain?: string;
  tld?: string;
  url?: string;
  /** @deprecated Studio derives the admin URL on the server. */
  adminUrl?: string;
  email: string;
  userId: string;
  bedrock?: boolean;
  hasMigration?: boolean;
  phpVersion?: string;
  /** @deprecated Studio derives account ownership from the authenticated user. */
  ownerAccountId?: string | null;
  mountPath?: string;
}

const MANAGED_SITE_HOST_RE = /(?:\.onstatic\.studio|\.static\d*\.studio)$/;
const MANAGED_SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PHP_VERSIONS = ["7.4", "8.0", "8.1", "8.2", "8.3", "8.4"] as const;

export function normalizeManagedSiteUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw new CliError("Site URL must be a valid managed Studio HTTPS URL.");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash ||
    !MANAGED_SITE_HOST_RE.test(hostname)
  ) {
    throw new CliError("New sites must use an HTTPS managed Studio hostname without a path, query, or credentials.");
  }
  return `https://${hostname}`;
}

function normalizeManagedSubdomain(value: string): string {
  const subdomain = String(value || "").trim().toLowerCase();
  if (!MANAGED_SUBDOMAIN_RE.test(subdomain)) {
    throw new CliError(
      "Site subdomain must be 1-63 lowercase letters, numbers, or hyphens and cannot start or end with a hyphen.",
    );
  }
  return subdomain;
}

function normalizeSiteName(value: string | undefined): string {
  const name = String(value || randomDomainWord()).trim();
  if (!name || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new CliError("Site name must be between 1 and 200 printable characters.");
  }
  return name;
}

export function generateSiteSeed(options: Partial<CreateSiteOptions> = {}): {
  name: string;
  subdomain: string;
  tld: string;
  url: string;
  adminUrl: string;
} {
  const requestedUrl = options.url ? normalizeManagedSiteUrl(options.url) : undefined;
  const requestedHost = requestedUrl ? new URL(requestedUrl).hostname : "";
  const urlSubdomain = requestedHost.split(".")[0] || "";
  const subdomain = normalizeManagedSubdomain(
    options.subdomain || urlSubdomain || `${randomAlpha(2)}${randomAlphanumeric(13)}`,
  );
  if (urlSubdomain && subdomain !== urlSubdomain) {
    throw new CliError("Site subdomain must match the hostname supplied with --url.");
  }
  const tld = requestedHost
    ? requestedHost.split(".").slice(1).join(".")
    : String(options.tld || DEFAULT_TLD).trim().toLowerCase();
  const url = requestedUrl || normalizeManagedSiteUrl(`https://${subdomain}.${tld}`);
  const hostname = new URL(url).hostname;
  const wpHostname = hostname.endsWith(".onstatic.studio") ? `wp-${hostname}` : `wp.${hostname}`;
  const adminUrl = `https://${wpHostname}/wp-admin`;
  return {
    name: normalizeSiteName(options.name),
    subdomain,
    tld,
    url,
    adminUrl,
  };
}

export async function listSites(
  supabase: SupabaseClient,
  user: { id: string; email?: string },
  options: {
    page?: number;
    pageSize?: number;
    search?: string;
    sort?: string;
    ascending?: boolean;
  } = {},
): Promise<{ data: SiteRecord[]; count: number }> {
  const page = parsePositiveInteger(options.page || 1, "page", { min: 1, max: 10_000 });
  const pageSize = parsePositiveInteger(options.pageSize || 20, "page size", { min: 1, max: 100 });
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  const orderField = requireAllowedValue(options.sort || "created_at", [
    "id",
    "name",
    "url",
    "status",
    "created_at",
    "updated_at",
  ] as const, "sort");
  const orderAsc = options.ascending ?? false;

  const { data: subscription } = await supabase
    .from("subscription")
    .select("partner_id")
    .eq("user_id", user.id)
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();

  let query = supabase
    .from("site")
    .select(
      "*, user_site!inner(user_id, admin, owner_account_id),site_meta(email, admin_url, secret_key, pagespeed_desktop, pagespeed_mobile, ttfb)",
      { count: "exact" },
    )
    .eq("user_site.user_id", user.id)
    .order(orderField, { ascending: orderAsc });

  // Keep the embed left-joined so team-only rows are still visible, while
  // preventing one member from receiving another member's site metadata.
  if (user.email) {
    query = query.eq("site_meta.email", user.email);
  }

  if ((subscription as { partner_id?: string } | null)?.partner_id === "hardypress") {
    query = query.eq("hp_webhook_pending", false);
  }

  const search = sanitizeSearchTerm(options.search);
  if (search) {
    const escaped = search.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    query = query.or(`name.ilike."%${escaped}%",url.ilike."%${escaped}%"`);
  }

  const { data, error, count } = await query.range(from, to);
  if (error) throw new CliError(error.message);

  return { data: (data || []) as SiteRecord[], count: count || 0 };
}

export async function getSite(supabase: SupabaseClient, siteId: string): Promise<SiteRecord> {
  const safeSiteId = assertSafeId(siteId, "siteId");
  const { data, error } = await supabase
    .from("site")
    .select("*, site_meta(*), user_site(*)")
    .eq("id", safeSiteId)
    .maybeSingle();

  if (error) throw new CliError(error.message);
  if (!data) throw new CliError(`Site ${safeSiteId} was not found.`);
  return data as SiteRecord;
}

export async function getSiteMeta(
  supabase: SupabaseClient,
  siteId: string,
  email?: string,
): Promise<SiteMetaRecord> {
  const safeSiteId = assertSafeId(siteId, "siteId");
  let query = supabase
    .from("site_meta")
    .select("*")
    .eq("site_id", safeSiteId)
    .order("id", { ascending: false })
    .limit(1);

  if (email) {
    query = query.eq("email", email);
  }

  const { data, error } = await query.maybeSingle();
  if (error) throw new CliError(error.message);
  if (!data) throw new CliError(`No site_meta record found for site ${safeSiteId}.`);
  return data as SiteMetaRecord;
}

export function basicAuthCredentialsFromMeta(meta: SiteMetaRecord): {
  basic_auth_user: string;
  basic_auth_password: string;
  admin_url?: string;
} {
  if (!meta.basic_auth_user || !meta.basic_auth_password) {
    throw new CliError("Basic Auth credentials were not found for this site.");
  }
  return {
    basic_auth_user: meta.basic_auth_user,
    basic_auth_password: meta.basic_auth_password,
    ...(meta.admin_url ? { admin_url: meta.admin_url } : {}),
  };
}

export async function getBasicAuthCredentials(
  supabase: SupabaseClient,
  siteId: string,
  email?: string,
): Promise<ReturnType<typeof basicAuthCredentialsFromMeta>> {
  return basicAuthCredentialsFromMeta(await getSiteMeta(supabase, siteId, email));
}

function stripUrlCredentials(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
      return parsed.toString();
    }
  } catch {
    return url;
  }
  return url;
}

export async function getMagicLoginLink(
  supabase: SupabaseClient,
  siteId: string,
  email?: string,
): Promise<{ url: string; siteId: string; staticSiteId: string; email: string }> {
  const safeSiteId = assertSafeId(siteId, "siteId");
  const [site, meta] = await Promise.all([
    getSite(supabase, safeSiteId),
    getSiteMeta(supabase, safeSiteId, email),
  ]);
  const staticSiteId = site.static_site_record_id
    ? String(site.static_site_record_id)
    : "";
  if (!staticSiteId) {
    throw new CliError(`Site ${safeSiteId} is missing static_site_record_id.`);
  }
  if (!meta.email) {
    throw new CliError(`No site_meta email found for site ${safeSiteId}.`);
  }

  const result = await invokeFunction<{ url?: string }>(supabase, "get-magic-link", {
    siteId: safeSiteId,
    staticSiteId,
    email: meta.email,
  });

  if (!result?.url) {
    throw new CliError("Could not extract a valid login URL from WordPress response.");
  }

  return {
    url: stripUrlCredentials(result.url),
    siteId: safeSiteId,
    staticSiteId,
    email: meta.email,
  };
}

export async function createSite(
  supabase: SupabaseClient,
  options: CreateSiteOptions,
): Promise<{ site: SiteRecord; queue: unknown; credentials: Record<string, string> }> {
  const seed = generateSiteSeed(options);
  const mountPath = normalizeMountPath(options.mountPath);
  const phpVersion = requireAllowedValue(
    String(options.phpVersion || "8.3"),
    PHP_VERSIONS,
    "PHP version",
  );

  const recordResult = await invokeFunction<{ site: SiteRecord }>(supabase, "create-site-record", {
    url: seed.url,
    name: seed.name,
    ...(options.bedrock ? { bedrock: true } : {}),
    email: options.email,
    user_id: options.userId,
    mount_path: mountPath,
  });

  const siteId = String(recordResult.site.id);
  const queue = await invokeFunction(supabase, "queue-site", {
    siteHasMigration: Boolean(options.hasMigration),
    site_id: siteId,
    apiVersion: SUPABASE_API_VERSION,
    phpVersion,
  });
  const meta = await getSiteMeta(supabase, siteId, options.email);

  return {
    site: recordResult.site,
    queue,
    credentials: {
      username: requiredCredential(meta.username, "username"),
      password: requiredCredential(meta.password, "password"),
      basic_auth_user: requiredCredential(meta.basic_auth_user, "basic_auth_user"),
      basic_auth_password: requiredCredential(meta.basic_auth_password, "basic_auth_password"),
      admin_url: requiredCredential(meta.admin_url, "admin_url"),
      secret_key: requiredCredential(meta.secret_key, "secret_key"),
    },
  };
}

function requiredCredential(value: unknown, field: string): string {
  const credential = String(value || "");
  if (!credential) {
    throw new CliError(`The site was created, but ${field} was missing from its server-generated credentials.`);
  }
  return credential;
}

export async function updateSite(
  supabase: SupabaseClient,
  siteId: string,
  changes: { name?: string; notes?: string; status?: string },
): Promise<SiteRecord> {
  const safeSiteId = assertSafeId(siteId, "siteId");
  const update: Record<string, string> = {};
  if (changes.name !== undefined) update.name = changes.name;
  if (changes.notes !== undefined) update.notes = changes.notes;
  if (changes.status !== undefined) update.status = changes.status;
  if (Object.keys(update).length === 0) {
    throw new CliError("No changes supplied.");
  }

  const { data, error } = await supabase.from("site").update(update).eq("id", safeSiteId).select().single();
  if (error) throw new CliError(error.message);
  return data as SiteRecord;
}

export async function deleteSite(supabase: SupabaseClient, siteId: string): Promise<unknown> {
  return invokeFunction(supabase, "queue-site-delete", { record_id: assertSafeId(siteId, "siteId") });
}

export type SitePushMode = "full" | "changes";
export type SiteExportType = "export" | "update";

export function sitePushModeToExportType(mode: string | undefined = "full"): SiteExportType {
  switch (mode.trim().toLowerCase()) {
    case "full":
    case "export":
      return "export";
    case "changes":
    case "update":
      return "update";
    default:
      throw new CliError("Push mode must be `full` or `changes`.");
  }
}

export async function exportSite(
  supabase: SupabaseClient,
  siteId: string,
  type: SiteExportType = "export",
): Promise<unknown> {
  return invokeFunction(supabase, "export-site", { site_id: assertSafeId(siteId, "siteId"), type });
}

export async function pushSite(
  supabase: SupabaseClient,
  siteId: string,
  mode: string | undefined = "full",
): Promise<unknown> {
  return exportSite(supabase, siteId, sitePushModeToExportType(mode));
}

export async function redeploySite(supabase: SupabaseClient, siteId: string): Promise<unknown> {
  return invokeFunction(supabase, "redeploy-site", { site_id: siteId });
}

export async function getSiteMigrationSubdomain(
  supabase: SupabaseClient,
  siteId: string,
): Promise<string> {
  const meta = await getSiteMeta(supabase, siteId);
  const adminUrl = meta.admin_url;
  if (adminUrl) {
    const match = adminUrl.match(/^https?:\/\/(?:wp[.-])?([^.]+)\./i);
    if (match?.[1]) {
      return match[1];
    }
  }

  const site = await getSite(supabase, siteId);
  const host = String(site.url || "").replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  const subdomain = host.split(".")[0];
  if (!subdomain) {
    throw new CliError(`Could not determine migration upload subdomain for site ${siteId}.`);
  }
  return subdomain;
}

export async function retryFailedDeployment(supabase: SupabaseClient, siteId: string): Promise<unknown> {
  return invokeFunction(supabase, "retry-failed-deployment", { site_id: assertSafeId(siteId, "siteId") });
}

export async function getChangesCount(supabase: SupabaseClient, siteId: string): Promise<number> {
  const result = await invokeFunction<{ data?: { changes_count?: number } }>(supabase, "get-changes-count", {
    site_id: assertSafeId(siteId, "siteId"),
  });
  return result?.data?.changes_count || 0;
}

export async function clearCache(supabase: SupabaseClient, siteId: string): Promise<unknown> {
  const site = await getSite(supabase, assertSafeId(siteId, "siteId"));
  if (!site.pull_zone_id) {
    throw new CliError("Site does not have a pull_zone_id yet.");
  }
  return invokeFunction(supabase, "clear-cache", { pull_zone: site.pull_zone_id });
}

export function siteSummaryRows(sites: SiteRecord[]): Record<string, unknown>[] {
  return sites.map((site) => {
    const mountPath = normalizeMountPath(site.mount_path);
    const baseUrl = String(site.url || "").replace(/\/+$/, "");
    return {
      id: site.id,
      name: site.name,
      url: baseUrl ? `${baseUrl}${mountPath}` : site.url,
      ...(mountPath ? { base_url: site.url, mount_path: mountPath } : {}),
      status: site.status,
      created_at: site.created_at,
    };
  });
}

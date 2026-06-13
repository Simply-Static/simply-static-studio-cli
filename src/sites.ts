import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_TLD, SUPABASE_API_VERSION } from "./constants.js";
import { CliError } from "./errors.js";
import { invokeFunction } from "./supabase.js";
import { md5, randomAlphanumeric, randomAlpha, randomDomainWord, randomPassword, randomUsername } from "./random.js";
import type { SiteMetaRecord, SiteRecord } from "./types.js";
import {
  assertSafeId,
  parsePositiveInteger,
  requireAllowedValue,
  sanitizeSearchTerm,
} from "./validation.js";

export interface CreateSiteOptions {
  name?: string;
  subdomain?: string;
  tld?: string;
  url?: string;
  adminUrl?: string;
  email: string;
  userId: string;
  bedrock?: boolean;
  hasMigration?: boolean;
  phpVersion?: string;
  ownerAccountId?: string | null;
}

export function generateSiteSeed(options: Partial<CreateSiteOptions> = {}): {
  name: string;
  subdomain: string;
  tld: string;
  url: string;
  adminUrl: string;
} {
  const tld = options.tld || DEFAULT_TLD;
  const subdomain = options.subdomain || `${randomAlpha(2)}${randomAlphanumeric(13)}`;
  const url = options.url || `https://${subdomain}.${tld}`;
  const adminUrl = options.adminUrl || `https://wp-${subdomain}.${tld}/wp-admin`;
  return {
    name: options.name || randomDomainWord(),
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

  let query = supabase
    .from("site")
    .select(
      "*, user_site!inner(user_id, admin, owner_account_id),site_meta!inner(email, admin_url, secret_key, pagespeed_desktop, pagespeed_mobile, ttfb)",
      { count: "exact" },
    )
    .eq("user_site.user_id", user.id)
    .order(orderField, { ascending: orderAsc });

  if (user.email) {
    query = query.eq("site_meta.email", user.email);
  }

  const search = sanitizeSearchTerm(options.search);
  if (search) {
    query = query.or(`name.ilike.%${search}%,url.ilike.%${search}%`);
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

export async function createSite(
  supabase: SupabaseClient,
  options: CreateSiteOptions,
): Promise<{ site: SiteRecord; queue: unknown; credentials: Record<string, string> }> {
  const seed = generateSiteSeed(options);
  const password = randomPassword();
  const username = randomUsername();
  const basicAuthUser = randomUsername();
  const basicAuthPassword = randomPassword();
  const secretKey = md5(seed.url);
  const adminUrl = options.bedrock
    ? seed.adminUrl.replace(/\/wp-admin\/?$/, "/wp/wp-admin")
    : seed.adminUrl;

  const recordResult = await invokeFunction<{ site: SiteRecord }>(supabase, "create-site-record", {
    url: seed.url,
    name: seed.name,
    initial_export_done: false,
    ...(options.bedrock ? { bedrock: true } : {}),
    password,
    username,
    basic_auth_user: basicAuthUser,
    basic_auth_password: basicAuthPassword,
    admin_url: adminUrl,
    secret_key: secretKey,
    email: options.email,
    user_id: options.userId,
    owner_account_id: options.ownerAccountId || null,
  });

  const siteId = String(recordResult.site.id);
  const queue = await invokeFunction(supabase, "queue-site", {
    subdomain: seed.subdomain,
    tld: seed.tld,
    username,
    password,
    email: options.email,
    basic_auth_user: basicAuthUser,
    basic_auth_password: basicAuthPassword,
    secret_key: secretKey,
    siteHasMigration: Boolean(options.hasMigration),
    site_id: siteId,
    apiVersion: SUPABASE_API_VERSION,
    phpVersion: options.phpVersion || "8.3",
  });

  return {
    site: recordResult.site,
    queue,
    credentials: {
      username,
      password,
      basic_auth_user: basicAuthUser,
      basic_auth_password: basicAuthPassword,
      admin_url: adminUrl,
      secret_key: secretKey,
    },
  };
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
  return invokeFunction(supabase, "clear-cache", { siteId: assertSafeId(siteId, "siteId") });
}

export function siteSummaryRows(sites: SiteRecord[]): Record<string, unknown>[] {
  return sites.map((site) => ({
    id: site.id,
    name: site.name,
    url: site.url,
    status: site.status,
    created_at: site.created_at,
  }));
}

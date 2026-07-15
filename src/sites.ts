import type { SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_API_VERSION } from "./constants.js";
import { CliError } from "./errors.js";
import { invokeFunction } from "./supabase.js";
import { randomDomainWord } from "./random.js";
import type { SiteMetaRecord, SiteRecord } from "./types.js";
import { uploadMigrationFile, type UploadMigrationOptions } from "./upload.js";
import {
  assertSafeId,
  normalizeMountPath,
  parsePositiveInteger,
  requireAllowedValue,
  sanitizeSearchTerm,
} from "./validation.js";

export interface CreateSiteOptions {
  name?: string;
  email: string;
  userId: string;
  bedrock?: boolean;
  phpVersion?: string;
  mountPath?: string;
}

export interface CreateSiteWithMigrationOptions extends CreateSiteOptions {
  migrationFile: string;
  allowAnyZipName?: boolean;
  onUploadProgress?: UploadMigrationOptions["onProgress"];
}

export interface CreateSiteResult {
  site: SiteRecord;
  queue: unknown;
  credentials: Record<string, string>;
  provisioning?: {
    identifier?: string;
    managed_url?: string;
    admin_url?: string;
  };
}

type PreparedSiteProvisioning = {
  name: string;
  mountPath: string;
  phpVersion: (typeof PHP_VERSIONS)[number];
};

const PHP_VERSIONS = ["7.4", "8.0", "8.1", "8.2", "8.3", "8.4"] as const;

function normalizeSiteName(value: string | undefined): string {
  const name = String(value || randomDomainWord()).trim();
  if (!name || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new CliError("Site name must be between 1 and 200 printable characters.");
  }
  return name;
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
): Promise<CreateSiteResult> {
  return provisionSite(supabase, options, prepareSiteProvisioning(options), false);
}

export async function createSiteWithMigration(
  supabase: SupabaseClient,
  options: CreateSiteWithMigrationOptions,
): Promise<CreateSiteResult & {
  upload: Omit<Awaited<ReturnType<typeof uploadMigrationFile>>, "migrationToken" | "siteIdentifier">;
}> {
  const prepared = prepareSiteProvisioning(options);
  const upload = await uploadMigrationFile(supabase, {
    filePath: options.migrationFile,
    newSite: true,
    ...(options.allowAnyZipName === undefined
      ? {}
      : { allowAnyZipName: options.allowAnyZipName }),
    ...(options.onUploadProgress ? { onProgress: options.onUploadProgress } : {}),
  });
  if (!upload.migrationToken) {
    throw new CliError("Migration upload did not return a signed site creation token.");
  }
  const result = await provisionSite(
    supabase,
    options,
    prepared,
    true,
    upload.migrationToken,
  );
  const { migrationToken: _migrationToken, siteIdentifier: _siteIdentifier, ...publicUpload } = upload;
  return { ...result, upload: publicUpload };
}

function prepareSiteProvisioning(options: CreateSiteOptions): PreparedSiteProvisioning {
  return {
    name: normalizeSiteName(options.name),
    mountPath: normalizeMountPath(options.mountPath),
    phpVersion: requireAllowedValue(
      String(options.phpVersion || "8.3"),
      PHP_VERSIONS,
      "PHP version",
    ),
  };
}

async function provisionSite(
  supabase: SupabaseClient,
  options: CreateSiteOptions,
  prepared: PreparedSiteProvisioning,
  hasMigration: boolean,
  migrationToken?: string,
): Promise<CreateSiteResult> {
  const { name, mountPath, phpVersion } = prepared;

  const recordResult = await invokeFunction<{
    site: SiteRecord;
    provisioning?: CreateSiteResult["provisioning"];
  }>(supabase, "create-site-record", {
    name,
    ...(options.bedrock ? { bedrock: true } : {}),
    email: options.email,
    user_id: options.userId,
    mount_path: mountPath,
    ...(migrationToken ? { migration_token: migrationToken } : {}),
  });

  const siteId = String(recordResult.site.id);
  const queue = await invokeFunction(supabase, "queue-site", {
    siteHasMigration: hasMigration,
    site_id: siteId,
    apiVersion: SUPABASE_API_VERSION,
    phpVersion,
  });
  const meta = await getSiteMeta(supabase, siteId, options.email);

  return {
    site: recordResult.site,
    queue,
    ...(recordResult.provisioning ? { provisioning: recordResult.provisioning } : {}),
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

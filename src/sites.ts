import type { SupabaseClient } from "@supabase/supabase-js";
import {
  PLATFORM_HOSTING_PROVIDER,
  PLATFORM_PROVISIONING_API_VERSION,
} from "./constants.js";
import { CliError } from "./errors.js";
import { invokeFunction, invokeIdempotentFunction } from "./supabase.js";
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
  migrationArtifactId?: string;
}

export interface CreateSiteWithMigrationOptions extends CreateSiteOptions {
  migrationFile: string;
  allowAnyZipName?: boolean;
  onUploadProgress?: UploadMigrationOptions["onProgress"];
}

export type CreateSiteFromArtifactOptions = CreateSiteOptions & {
  migrationArtifactId: string;
};

export interface CreateSiteResult {
  site: SiteRecord;
  queue: unknown;
  credentials: Record<string, string>;
  provisioning?: {
    identifier?: string;
    managed_url?: string;
    admin_url?: string;
    static_url?: string;
    queued?: boolean;
    job?: unknown;
    error?: string | null;
  };
}

const SITE_CLIENT_SELECT = [
  "id",
  "created_at",
  "url",
  "managed_url",
  "provisioning_id",
  "name",
  "status",
  "notes",
  "dns_record_id",
  "static_site_record_id",
  "pull_zone_id",
  "storage_zone_id",
  "export_details",
  "migration_details",
  "initial_export_done",
  "is_migrating",
  "custom_domain",
  "hp_webhook_pending",
  "bedrock",
  "mount_path",
  "status_changed_at",
  "mount_provider",
  "first_deployed_at",
  "backup_enabled",
  "migration_upload_job_id",
  "migration_upload_status",
  "migration_upload_error",
  "migration_upload_attempts",
  "migration_upload_updated_at",
  "php_version",
  "wordpress_base_domain",
  "platform:platform_site(desired_state,observed_state)",
].join(",");

type PreparedSiteProvisioning = {
  name: string;
  mountPath: string;
  phpVersion: (typeof PLATFORM_PHP_VERSIONS)[number];
};

const PLATFORM_PHP_VERSIONS = ["7.4", "8.1", "8.2", "8.3", "8.4"] as const;
const CANONICAL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function normalizeSiteName(value: string | undefined): string {
  const name = value === undefined ? randomDomainWord() : String(value).trim();
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
      `${SITE_CLIENT_SELECT},user_site!inner(user_id,admin,owner_account_id),site_meta(email)`,
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

  return { data: (data || []) as unknown as SiteRecord[], count: count || 0 };
}

export async function getSite(supabase: SupabaseClient, siteId: string): Promise<SiteRecord> {
  const safeSiteId = assertSafeId(siteId, "siteId");
  const { data, error } = await supabase
    .from("site")
    .select(
      `${SITE_CLIENT_SELECT},user_site(user_id,email,admin,owner_account_id)`,
    )
    .eq("id", safeSiteId)
    .maybeSingle();

  if (error) throw new CliError(error.message);
  if (!data) throw new CliError(`Site ${safeSiteId} was not found.`);
  return data as unknown as SiteRecord;
}

export async function getSiteMeta(
  supabase: SupabaseClient,
  siteId: string,
  email?: string,
): Promise<SiteMetaRecord> {
  const safeSiteId = assertSafeId(siteId, "siteId");
  let query = supabase
    .from("site_meta")
    .select(
      "id,site_id,email,username,basic_auth_user,basic_auth_password,admin_url,secret_key,storage,bandwidth,pagespeed_desktop,pagespeed_mobile,ttfb,pagespeed_updated_at",
    )
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
): Promise<{ url: string; siteId: string; email: string }> {
  const safeSiteId = assertSafeId(siteId, "siteId");
  const meta = await getSiteMeta(supabase, safeSiteId, email);
  if (!meta.email) {
    throw new CliError(`No site_meta email found for site ${safeSiteId}.`);
  }

  const result = await invokeFunction<{ url?: string }>(supabase, "get-magic-link", {
    siteId: safeSiteId,
    email: meta.email,
  });

  if (!result?.url) {
    throw new CliError("Could not extract a valid login URL from WordPress response.");
  }

  return {
    url: stripUrlCredentials(result.url),
    siteId: safeSiteId,
    email: meta.email,
  };
}

export async function createSite(
  supabase: SupabaseClient,
  options: CreateSiteFromArtifactOptions,
): Promise<CreateSiteResult> {
  const prepared = prepareSiteProvisioning(options);
  if (!options.migrationArtifactId) {
    throw new CliError(
      "Empty site creation is temporarily unavailable. Provide a migration archive or finalized migration artifact.",
    );
  }
  const migrationArtifactId = normalizeMigrationArtifactId(options.migrationArtifactId);
  return provisionSite(
    supabase,
    options,
    prepared,
    migrationArtifactId,
  );
}

export async function createSiteWithMigration(
  supabase: SupabaseClient,
  options: CreateSiteWithMigrationOptions,
): Promise<CreateSiteResult & {
  upload: Omit<Awaited<ReturnType<typeof uploadMigrationFile>>, "siteIdentifier">;
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
  if (!upload.artifactId) {
    throw new CliError("Migration upload did not return a finalized Docker migration artifact.");
  }
  const result = await provisionSite(
    supabase,
    options,
    prepared,
    upload.artifactId,
  );
  const { siteIdentifier: _siteIdentifier, ...publicUpload } = upload;
  return { ...result, upload: publicUpload };
}

function prepareSiteProvisioning(options: CreateSiteOptions): PreparedSiteProvisioning {
  if (options.bedrock) {
    throw new CliError("Bedrock is not supported by the Docker platform.");
  }
  return {
    name: normalizeSiteName(options.name),
    mountPath: normalizeMountPath(options.mountPath),
    phpVersion: requireAllowedValue(
      String(options.phpVersion || "8.3"),
      PLATFORM_PHP_VERSIONS,
      "PHP version",
    ),
  };
}

function normalizeMigrationArtifactId(value: string): string {
  const artifactId = String(value || "").trim().toLowerCase();
  if (!CANONICAL_UUID_RE.test(artifactId)) {
    throw new CliError("migration artifact ID must be a canonical UUID.");
  }
  return artifactId;
}

async function provisionSite(
  supabase: SupabaseClient,
  options: CreateSiteOptions,
  prepared: PreparedSiteProvisioning,
  migrationArtifactId: string,
): Promise<CreateSiteResult> {
  const { name, mountPath, phpVersion } = prepared;

  let recordResult: {
    site: SiteRecord;
    provisioning?: CreateSiteResult["provisioning"];
  };
  try {
    recordResult = await invokeFunction(supabase, "create-site-record", {
      name,
      ...(options.bedrock ? { bedrock: true } : {}),
      email: options.email,
      user_id: options.userId,
      mount_path: mountPath,
      platform_canary: true,
      phpVersion,
      migration_artifact_id: migrationArtifactId,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CliError(
      `Site creation for migration artifact ${migrationArtifactId} could not be confirmed. Check sites list before retrying with --migration-artifact-id ${migrationArtifactId}. ${detail}`,
    );
  }

  const siteId = String(recordResult?.site?.id || "");
  if (!/^\d+$/.test(siteId) || Number(siteId) <= 0) {
    throw new CliError("The site record was created without a valid ID.");
  }
  if (recordResult.site.hosting_provider !== PLATFORM_HOSTING_PROVIDER) {
    throw new CliError(
      `Site ${siteId} was created without the required Docker provider; deployment was not queued.`,
    );
  }
  const serverJob = recordResult.provisioning?.job;
  let queue: unknown = recordResult.provisioning?.queued === true &&
      serverJob &&
      typeof serverJob === "object" &&
      "id" in serverJob &&
      Boolean(serverJob.id)
    ? serverJob
    : undefined;
  if (!queue) {
    try {
      queue = await invokeFunction(supabase, "queue-platform-site", {
        site_id: siteId,
        apiVersion: PLATFORM_PROVISIONING_API_VERSION,
        phpVersion,
      });
    } catch (error) {
      const fallbackDetail = error instanceof Error ? error.message : String(error || "");
      const detail = fallbackDetail || recordResult.provisioning?.error ||
        "Deployment could not be queued.";
      throw new CliError(
        `Site ${siteId} was created, but deployment could not be queued. ${detail}`,
      );
    }
  }

  let meta: SiteMetaRecord;
  try {
    meta = await getSiteMeta(supabase, siteId, options.email);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CliError(
      `Site ${siteId} was created and deployment was queued, but its credentials could not be loaded. ${detail}`,
    );
  }

  return {
    site: recordResult.site,
    queue,
    ...(recordResult.provisioning ? { provisioning: recordResult.provisioning } : {}),
    credentials: publicCredentialsFromMeta(meta),
  };
}

function publicCredentialsFromMeta(meta: SiteMetaRecord): Record<string, string> {
  const credentials: Record<string, string> = {};
  for (const field of [
    "username",
    "basic_auth_user",
    "basic_auth_password",
    "admin_url",
    "secret_key",
  ] as const) {
    const value = String(meta[field] || "");
    if (value) {
      credentials[field] = value;
    }
  }
  return credentials;
}

export async function updateSite(
  supabase: SupabaseClient,
  siteId: string,
  changes: { name?: string; notes?: string },
): Promise<SiteRecord> {
  const safeSiteId = assertSafeId(siteId, "siteId");
  if (Object.prototype.hasOwnProperty.call(changes, "status")) {
    throw new CliError("Site status cannot be updated directly.");
  }
  if (changes.name === undefined && changes.notes === undefined) {
    throw new CliError("No changes supplied.");
  }
  if (changes.name !== undefined && changes.notes !== undefined) {
    throw new CliError(
      "Update the site name and notes in separate commands to avoid partial changes.",
    );
  }

  let updated: SiteRecord | undefined;
  if (changes.name !== undefined) {
    const name = normalizeSiteName(changes.name);
    const result = await invokeFunction<{ site?: SiteRecord }>(
      supabase,
      "update-site-name",
      { site_id: safeSiteId, name },
    );
    if (
      !result?.site ||
      String(result.site.id) !== safeSiteId ||
      result.site.name !== name
    ) {
      throw new CliError("The site-name update returned an invalid response.");
    }
    updated = result.site;
  }

  if (changes.notes !== undefined) {
    const { data, error } = await supabase
      .from("site")
      .update({ notes: changes.notes })
      .eq("id", safeSiteId)
      .select(SITE_CLIENT_SELECT)
      .single();
    if (error) throw new CliError(error.message);
    updated = data as unknown as SiteRecord;
  }

  return updated!;
}

export async function deleteSite(supabase: SupabaseClient, siteId: string): Promise<unknown> {
  return invokeIdempotentFunction(supabase, "queue-site-delete", {
    record_id: assertSafeId(siteId, "siteId"),
    request_id: crypto.randomUUID(),
  });
}

export async function getPlatformSiteLifecycle(
  supabase: SupabaseClient,
  siteId: string,
): Promise<unknown> {
  return invokeFunction(supabase, "platform-site-lifecycle", {
    site_id: assertSafeId(siteId, "siteId"),
    action: "status",
  });
}

export async function updatePlatformSiteLifecycle(
  supabase: SupabaseClient,
  siteId: string,
  action: "start" | "stop",
): Promise<unknown> {
  return invokeFunction(supabase, "platform-site-lifecycle", {
    site_id: assertSafeId(siteId, "siteId"),
    action,
  });
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

export async function redeploySite(
  supabase: SupabaseClient,
  siteId: string,
  migrationArtifactId?: string,
): Promise<unknown> {
  const safeSiteId = assertSafeId(siteId, "siteId");
  const artifactId = migrationArtifactId === undefined
    ? undefined
    : normalizeMigrationArtifactId(migrationArtifactId);
  return invokeFunction(supabase, "redeploy-site", {
    site_id: safeSiteId,
    apiVersion: PLATFORM_PROVISIONING_API_VERSION,
    ...(artifactId ? { migration_artifact_id: artifactId } : {}),
  });
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
    const platform = Array.isArray(site.platform) ? site.platform[0] : site.platform;
    return {
      id: site.id,
      name: site.name,
      url: baseUrl ? `${baseUrl}${mountPath}` : site.url,
      ...(mountPath ? { base_url: site.url, mount_path: mountPath } : {}),
      status: site.status,
      ...(platform
        ? {
          desired_state: platform?.desired_state ?? null,
          observed_state: platform?.observed_state ?? null,
        }
        : {}),
      created_at: site.created_at,
    };
  });
}

import type { SupabaseClient } from "@supabase/supabase-js";
import { CliError } from "./errors.js";
import { getSite, getSiteMeta } from "./sites.js";
import { invokeFunction } from "./supabase.js";
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

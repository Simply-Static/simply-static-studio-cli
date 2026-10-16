import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CliError } from "./errors.js";
import {
  basicAuthCredentialsFromMeta,
  clearCache,
  createSite,
  createSiteWithMigration,
  getMagicLoginLink,
  getPlatformSiteLifecycle,
  listSites,
  redeploySite,
  siteSummaryRows,
  sitePushModeToExportType,
  updatePlatformSiteLifecycle,
  updateSite,
} from "./sites.js";
import { createSupabaseMock } from "./test-utils.js";

describe("sitePushModeToExportType", () => {
  it("maps full pushes to backend exports", () => {
    expect(sitePushModeToExportType()).toBe("export");
    expect(sitePushModeToExportType("full")).toBe("export");
    expect(sitePushModeToExportType("export")).toBe("export");
  });

  it("maps changes pushes to backend updates", () => {
    expect(sitePushModeToExportType("changes")).toBe("update");
    expect(sitePushModeToExportType("update")).toBe("update");
  });

  it("rejects unknown push modes", () => {
    expect(() => sitePushModeToExportType("partial")).toThrow(CliError);
  });
});

describe("basicAuthCredentialsFromMeta", () => {
  it("extracts only Basic Auth credentials and admin URL", () => {
    expect(
      basicAuthCredentialsFromMeta({
        basic_auth_user: "auth-user",
        basic_auth_password: "auth-pass",
        username: "wp-user",
        password: "wp-pass",
        admin_url: "https://wp.example.test/wp-admin",
      }),
    ).toEqual({
      basic_auth_user: "auth-user",
      basic_auth_password: "auth-pass",
      admin_url: "https://wp.example.test/wp-admin",
    });
  });

  it("rejects missing Basic Auth credentials", () => {
    expect(() => basicAuthCredentialsFromMeta({})).toThrow(CliError);
  });
});

describe("getMagicLoginLink", () => {
  it("uses the canonical site ID and strips embedded URL credentials", async () => {
    const { supabase, functionCalls } = createSupabaseMock((table) => {
      if (table === "site_meta") {
        return {
          data: { site_id: "site-1", email: "person@example.com" },
          error: null,
        };
      }
      return { data: null, error: null };
    }, { url: "https://basic-user:basic-pass@wp.example.test/wp-admin/?token=abc" });

    await expect(getMagicLoginLink(supabase, "site-1", "person@example.com")).resolves.toEqual({
      url: "https://wp.example.test/wp-admin/?token=abc",
      siteId: "site-1",
      email: "person@example.com",
    });

    expect(functionCalls).toEqual([
      {
        name: "get-magic-link",
        body: {
          siteId: "site-1",
          email: "person@example.com",
        },
      },
    ]);
  });

});

describe("createSite", () => {
  const artifactId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const serverCredentials = {
    site_id: "42",
    email: "person@example.com",
    username: "server-user",
    password: "server-password",
    basic_auth_user: "server-basic-user",
    basic_auth_password: "server-basic-password",
    admin_url: "https://wp-demo.onstatic.studio/wp-admin",
    secret_key: "server-secret",
  };

  it("requires Docker assignment and queues platform provisioning API v1", async () => {
    const { supabase, functionCalls } = createSupabaseMock(
      { site_meta: { data: serverCredentials, error: null } },
      (name) => name === "create-site-record"
        ? {
          site: {
            id: "42",
            name: "Example",
            url: "https://ab1234567890123.onstatic.studio",
            hosting_provider: "static-studio-docker",
          },
          provisioning: {
            queued: false,
            identifier: "ab1234567890123",
            managed_url: "https://ab1234567890123.onstatic.studio",
            job: { id: "server-job-must-not-be-used" },
          },
        }
        : { message: "Site queued" },
    );

    await expect(createSite(supabase, {
      name: "Example",
      email: "person@example.com",
      userId: "user-1",
      mountPath: " /blog/ ",
      phpVersion: "8.4",
      migrationArtifactId: artifactId,
    })).resolves.toMatchObject({
      site: { id: "42" },
      provisioning: { identifier: "ab1234567890123" },
      credentials: {
        username: "server-user",
        basic_auth_user: "server-basic-user",
        basic_auth_password: "server-basic-password",
        admin_url: "https://wp-demo.onstatic.studio/wp-admin",
        secret_key: "server-secret",
      },
    });

    expect(functionCalls[0]).toEqual({
      name: "create-site-record",
      body: {
        name: "Example",
        email: "person@example.com",
        user_id: "user-1",
        mount_path: "/blog",
        platform_canary: true,
        phpVersion: "8.4",
        migration_artifact_id: artifactId,
      },
    });
    expect(functionCalls[1]).toEqual({
      name: "queue-platform-site",
      body: {
        site_id: "42",
        apiVersion: 1,
        phpVersion: "8.4",
      },
    });
  });

  it("uses the provisioning job returned by site creation without queueing twice", async () => {
    const job = {
      id: "20000000-0000-4000-8000-000000000002",
      status: "pending_assignment",
      generation: 1,
    };
    const { supabase, functionCalls } = createSupabaseMock(
      { site_meta: { data: serverCredentials, error: null } },
      (name) => {
        if (name !== "create-site-record") {
          throw new Error(`Unexpected function: ${name}`);
        }
        return {
          site: {
            id: "42",
            name: "Server Queued",
            hosting_provider: "static-studio-docker",
          },
          provisioning: {
            queued: true,
            identifier: "ab1234567890123",
            job,
            error: null,
          },
        };
      },
    );

    await expect(createSite(supabase, {
      name: "Server Queued",
      email: "person@example.com",
      userId: "user-1",
      migrationArtifactId: artifactId,
    })).resolves.toMatchObject({ queue: job });
    expect(functionCalls.map(({ name }) => name)).toEqual(["create-site-record"]);
  });

  it.each(["7.4", "8.1"])("accepts Docker PHP %s", async (phpVersion) => {
    const { supabase, functionCalls } = createSupabaseMock(
      { site_meta: { data: serverCredentials, error: null } },
      (name) => name === "create-site-record"
        ? {
          site: {
            id: "42",
            name: "Legacy PHP",
            hosting_provider: "static-studio-docker",
          },
        }
        : { ok: true },
    );

    await createSite(supabase, {
      name: "Legacy PHP",
      email: "person@example.com",
      userId: "user-1",
      phpVersion,
      migrationArtifactId: artifactId,
    });

    expect(functionCalls[0]?.body).toMatchObject({ phpVersion });
    expect(functionCalls[1]?.body).toMatchObject({ phpVersion });
  });

  it("uses a finalized private Docker artifact for migration provisioning", async () => {
    const directory = mkdtempSync(join(tmpdir(), "static-studio-site-"));
    const migrationFile = join(directory, "studio-backup-site.zip");
    const artifactId = "11111111-1111-4111-8111-111111111111";
    const artifactKey =
      `private/platform-migrations/ab1234567890123/${artifactId}/source.zip`;
    writeFileSync(migrationFile, "zip");
    vi.stubGlobal("fetch", async () =>
      new Response(null, { status: 200, headers: { etag: "migration-etag" } })
    );

    try {
      const { supabase, functionCalls } = createSupabaseMock(
        { site_meta: { data: serverCredentials, error: null } },
        (name, body) => {
          if (name === "get-upload-credentials") {
            const action = (body as { action?: string }).action;
            if (action === "init") {
              return {
                token: "upload-token",
                partCount: 1,
                bucket: "platform_migrations",
                key: artifactKey,
                siteIdentifier: "ab1234567890123",
                artifactId,
              };
            }
            if (action === "sign_parts") {
              return { urls: [{ partNumber: 1, url: "https://uploads.example.test/1" }] };
            }
          }
          if (name === "complete-migration-upload") {
            return {
              ok: true,
              committed: true,
              bucket: "platform_migrations",
              key: artifactKey,
              siteIdentifier: "ab1234567890123",
              artifactId,
              artifactStatus: "ready",
              status: "ready",
            };
          }
          if (name === "create-site-record") {
            return {
              site: {
                id: "42",
                name: "Imported Site",
                hosting_provider: "static-studio-docker",
              },
            };
          }
          return { message: "Site queued" };
        },
      );

      await createSiteWithMigration(supabase, {
        name: "Imported Site",
        email: "person@example.com",
        userId: "user-1",
        migrationFile,
      });

      const init = functionCalls.find((call) =>
        call.name === "get-upload-credentials" && (call.body as { action?: string }).action === "init"
      );
      const create = functionCalls.find((call) => call.name === "create-site-record");
      const queue = functionCalls.find((call) => call.name === "queue-site");
      expect(init?.body).toMatchObject({
        key: "public/site-migration-pending.zip",
        purpose: "new_site",
        uploadProtocol: 3,
        platformCanary: true,
      });
      expect(create?.body).toMatchObject({
        name: "Imported Site",
        migration_artifact_id: artifactId,
      });
      expect(create?.body).not.toHaveProperty("url");
      expect(queue).toBeUndefined();
      expect(functionCalls.find((call) => call.name === "queue-platform-site")?.body)
        .toMatchObject({ site_id: "42", apiVersion: 1 });
    } finally {
      vi.unstubAllGlobals();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not expose or require the WordPress administrator password", async () => {
    const { password: _password, ...incompleteCredentials } = serverCredentials;
    const { supabase } = createSupabaseMock(
      { site_meta: { data: incompleteCredentials, error: null } },
      (name) => name === "create-site-record"
        ? {
          site: {
            id: "42",
            name: "Example",
            url: "https://demo.onstatic.studio",
            hosting_provider: "static-studio-docker",
          },
        }
        : { message: "Site queued" },
    );

    await expect(createSite(supabase, {
      name: "Example",
      email: "person@example.com",
      userId: "user-1",
      migrationArtifactId: artifactId,
    })).resolves.not.toHaveProperty("credentials.password");
  });

  it("preserves the created site identity when platform queueing fails", async () => {
    const { supabase } = createSupabaseMock(
      {},
      (name) => name === "create-site-record"
        ? {
          site: {
            id: "42",
            name: "Recovered Site",
            hosting_provider: "static-studio-docker",
          },
        }
        : { ok: false, error: "queue unavailable" },
    );

    await expect(createSite(supabase, {
      name: "Recovered Site",
      email: "person@example.com",
      userId: "user-1",
      migrationArtifactId: artifactId,
    })).rejects.toThrow(
      "Site 42 was created, but deployment could not be queued. queue unavailable",
    );
  });

  it("resumes creation from a finalized Docker migration artifact", async () => {
    const { supabase, functionCalls } = createSupabaseMock(
      { site_meta: { data: serverCredentials, error: null } },
      (name) => name === "create-site-record"
        ? {
          site: {
            id: "42",
            name: "Resumed Site",
            hosting_provider: "static-studio-docker",
          },
        }
        : { ok: true },
    );

    await createSite(supabase, {
      name: "Resumed Site",
      email: "person@example.com",
      userId: "user-1",
      migrationArtifactId: artifactId.toUpperCase(),
    });

    expect(functionCalls[0]?.body).toMatchObject({
      migration_artifact_id: artifactId,
    });
  });

  it("rejects a non-canonical migration artifact before site creation", async () => {
    const { supabase, functionCalls } = createSupabaseMock({});

    await expect(createSite(supabase, {
      name: "Invalid Artifact",
      email: "person@example.com",
      userId: "user-1",
      migrationArtifactId: "not-an-artifact",
    })).rejects.toThrow("canonical UUID");
    expect(functionCalls).toEqual([]);
  });

  it("rejects empty site creation before calling Studio", async () => {
    const { supabase, functionCalls } = createSupabaseMock({});

    await expect(createSite(supabase, {
      name: "Empty Site",
      email: "person@example.com",
      userId: "user-1",
      migrationArtifactId: "",
    })).rejects.toThrow("Empty site creation is temporarily unavailable");
    expect(functionCalls).toEqual([]);
  });

  it("rejects unsupported PHP versions before creating a site record", async () => {
    const { supabase, functionCalls } = createSupabaseMock({});

    await expect(createSite(supabase, {
      name: "Example",
      email: "person@example.com",
      userId: "user-1",
      phpVersion: "9.0",
      migrationArtifactId: artifactId,
    })).rejects.toThrow("PHP version must be one of");
    expect(functionCalls).toEqual([]);
  });

  it("rejects Bedrock before creating a Docker site", async () => {
    const { supabase, functionCalls } = createSupabaseMock({});
    await expect(createSite(supabase, {
      name: "Bedrock",
      email: "person@example.com",
      userId: "user-1",
      bedrock: true,
      migrationArtifactId: artifactId,
    })).rejects.toThrow("Bedrock is not supported");
    expect(functionCalls).toEqual([]);
  });
});

describe("clearCache", () => {
  it("resolves the site pull zone and sends the hardened pull_zone payload", async () => {
    const { supabase, functionCalls } = createSupabaseMock({
      site: { data: { id: "site-1", pull_zone_id: 501 }, error: null },
    });

    await clearCache(supabase, "site-1");

    expect(functionCalls).toEqual([
      { name: "clear-cache", body: { pull_zone: 501 } },
    ]);
  });

  it("does not invoke cache clearing before a pull zone exists", async () => {
    const { supabase, functionCalls } = createSupabaseMock({
      site: { data: { id: "site-1", pull_zone_id: null }, error: null },
    });

    await expect(clearCache(supabase, "site-1")).rejects.toThrow("does not have a pull_zone_id");
    expect(functionCalls).toEqual([]);
  });
});

describe("siteSummaryRows", () => {
  it("shows the mounted public URL while retaining the Studio base URL", () => {
    expect(siteSummaryRows([{
      id: "site-1",
      name: "Mounted Site",
      url: "https://example.com/",
      mount_path: "/blog/",
      status: "deployed",
    }])).toEqual([{
      id: "site-1",
      name: "Mounted Site",
      url: "https://example.com/blog",
      base_url: "https://example.com/",
      mount_path: "/blog",
      status: "deployed",
      created_at: undefined,
    }]);
  });

  it("reports only the supported Docker lifecycle state", () => {
    expect(siteSummaryRows([{
      id: "42",
      name: "Docker Site",
      url: "https://example.test",
      status: "deployed",
      hosting_provider: "static-studio-docker",
      platform: {
        desired_state: "running",
        observed_state: "running",
        always_on: true,
      },
    }])).toEqual([{
      id: "42",
      name: "Docker Site",
      url: "https://example.test",
      status: "deployed",
      desired_state: "running",
      observed_state: "running",
      created_at: undefined,
    }]);
  });
});

describe("Docker runtime controls", () => {
  it("uses the lifecycle Edge contract", async () => {
    const { supabase, functionCalls } = createSupabaseMock({}, { ok: true });

    await getPlatformSiteLifecycle(supabase, "42");
    await updatePlatformSiteLifecycle(supabase, "42", "start");

    expect(functionCalls).toEqual([
      {
        name: "platform-site-lifecycle",
        body: { site_id: "42", action: "status" },
      },
      {
        name: "platform-site-lifecycle",
        body: { site_id: "42", action: "start" },
      },
    ]);
  });
});

describe("site updates", () => {
  it("routes name updates through the administrator-only Edge function", async () => {
    const { supabase, functionCalls, calls } = createSupabaseMock(
      {},
      { ok: true, site: { id: "42", name: "Renamed site" } },
    );

    await expect(updateSite(supabase, "42", {
      name: "  Renamed site  ",
    })).resolves.toEqual({ id: "42", name: "Renamed site" });
    expect(functionCalls).toEqual([{
      name: "update-site-name",
      body: { site_id: "42", name: "Renamed site" },
    }]);
    expect(calls).toEqual([]);
  });

  it("keeps notes as the only direct site-table mutation", async () => {
    const updated = { id: "42", notes: "Private note" };
    const { supabase, calls, functionCalls } = createSupabaseMock({
      site: { data: updated, error: null },
    });

    await expect(updateSite(supabase, "42", {
      notes: "Private note",
    })).resolves.toEqual(updated);
    expect(calls).toContainEqual({
      table: "site",
      method: "update",
      args: [{ notes: "Private note" }],
    });
    expect(functionCalls).toEqual([]);
  });

  it("rejects combined name and notes updates before making partial changes", async () => {
    const { supabase, calls, functionCalls } = createSupabaseMock({});

    await expect(updateSite(supabase, "42", {
      name: "Renamed site",
      notes: "Private note",
    })).rejects.toThrow("separate commands");
    expect(calls).toEqual([]);
    expect(functionCalls).toEqual([]);
  });

  it("rejects direct status mutations", async () => {
    const { supabase, calls, functionCalls } = createSupabaseMock({});

    await expect(updateSite(
      supabase,
      "42",
      { status: "deployed" } as { name?: string; notes?: string },
    )).rejects.toThrow(/status cannot be updated directly/i);
    expect(calls).toEqual([]);
    expect(functionCalls).toEqual([]);
  });
});

describe("Docker redeployments", () => {
  it("queues an ordinary redeploy through platform API v1", async () => {
    const { supabase, functionCalls } = createSupabaseMock({}, { status: "queued" });

    await redeploySite(supabase, "42");

    expect(functionCalls).toEqual([{
      name: "redeploy-site",
      body: { site_id: "42", apiVersion: 1 },
    }]);
  });

  it("queues a replacement with a normalized migration artifact", async () => {
    const artifactId = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    const { supabase, functionCalls } = createSupabaseMock({}, { status: "queued" });

    await redeploySite(supabase, "42", artifactId);

    expect(functionCalls).toEqual([{
      name: "redeploy-site",
      body: {
        site_id: "42",
        apiVersion: 1,
        migration_artifact_id: artifactId.toLowerCase(),
      },
    }]);
  });

  it("rejects an invalid replacement artifact before invoking the API", async () => {
    const { supabase, functionCalls } = createSupabaseMock({});

    await expect(redeploySite(supabase, "42", "not-an-artifact"))
      .rejects.toThrow(/canonical UUID/i);
    expect(functionCalls).toEqual([]);
  });
});

describe("listSites validation", () => {
  it("keeps team sites visible while scoping metadata and quoting search filters", async () => {
    const { supabase, calls } = createSupabaseMock((table) =>
      table === "subscription"
        ? { data: null, error: null }
        : { data: [], error: null, count: 0 },
    );

    await listSites(
      supabase,
      { id: "user-1", email: "person@example.com" },
      { search: 'client "alpha"' },
    );

    expect(calls).toContainEqual({
      table: "site",
      method: "eq",
      args: ["site_meta.email", "person@example.com"],
    });
    expect(calls).toContainEqual({
      table: "site",
      method: "or",
      args: ['name.ilike."%client \\"alpha\\"%",url.ilike."%client \\"alpha\\"%"'],
    });
    const select = calls.find((call) => call.table === "site" && call.method === "select");
    expect(String(select?.args[0])).toContain("site_meta(email");
    expect(String(select?.args[0])).not.toContain("site_meta!inner");
    expect(String(select?.args[0])).toContain("wordpress_base_domain");
    expect(String(select?.args[0])).toContain(
      "platform:platform_site(desired_state,observed_state)",
    );
    for (const retiredColumn of [
      "site_id",
      "server_id",
      "event_id",
      "backup_last_checked_at",
      "is_docker_migrating",
      "hosting_provider",
      "always_on",
    ]) {
      expect(String(select?.args[0])).not.toContain(retiredColumn);
    }
  });

  it("rejects unsafe sort fields before querying", async () => {
    const { supabase } = createSupabaseMock({ site: { data: [], error: null, count: 0 } });
    await expect(
      listSites(supabase, { id: "user-1", email: "person@example.com" }, { sort: "created_at.desc.nullslast" }),
    ).rejects.toThrow(CliError);
  });

  it("rejects unsafe search terms before querying", async () => {
    const { supabase } = createSupabaseMock({ site: { data: [], error: null, count: 0 } });
    await expect(
      listSites(supabase, { id: "user-1", email: "person@example.com" }, { search: "demo),id.eq.1" }),
    ).rejects.toThrow(CliError);
  });
});

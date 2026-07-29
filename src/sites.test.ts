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
  siteSummaryRows,
  sitePushModeToExportType,
  updatePlatformRuntimePolicy,
  updatePlatformSiteLifecycle,
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
            identifier: "ab1234567890123",
            managed_url: "https://ab1234567890123.onstatic.studio",
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
    })).rejects.toThrow(
      "Site 42 was created, but deployment could not be queued. queue unavailable",
    );
  });

  it("resumes creation from a finalized Docker migration artifact", async () => {
    const artifactId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
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

  it("rejects unsupported PHP versions before creating a site record", async () => {
    const { supabase, functionCalls } = createSupabaseMock({});

    await expect(createSite(supabase, {
      name: "Example",
      email: "person@example.com",
      userId: "user-1",
      phpVersion: "9.0",
    })).rejects.toThrow("PHP version must be one of");
    expect(functionCalls).toEqual([]);
  });

  it("rejects legacy PHP versions and Bedrock before creating a Docker site", async () => {
    const { supabase, functionCalls } = createSupabaseMock({});
    await expect(createSite(supabase, {
      name: "Legacy PHP",
      email: "person@example.com",
      userId: "user-1",
      phpVersion: "8.1",
    })).rejects.toThrow("PHP version must be one of");
    await expect(createSite(supabase, {
      name: "Bedrock",
      email: "person@example.com",
      userId: "user-1",
      bedrock: true,
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
});

describe("Docker runtime controls", () => {
  it("uses the lifecycle and runtime-policy Edge contracts", async () => {
    const { supabase, functionCalls } = createSupabaseMock({}, { ok: true });

    await getPlatformSiteLifecycle(supabase, "42");
    await updatePlatformSiteLifecycle(supabase, "42", "start");
    await updatePlatformRuntimePolicy(supabase, "42", true);

    expect(functionCalls).toEqual([
      {
        name: "platform-site-lifecycle",
        body: { site_id: "42", action: "status" },
      },
      {
        name: "platform-site-lifecycle",
        body: { site_id: "42", action: "start" },
      },
      {
        name: "platform-runtime-policy",
        body: { site_id: "42", always_on: true },
      },
    ]);
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

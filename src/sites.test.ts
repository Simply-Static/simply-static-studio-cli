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
  listSites,
  siteSummaryRows,
  sitePushModeToExportType,
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
  it("calls the dashboard magic-link function and strips embedded URL credentials", async () => {
    const { supabase, functionCalls } = createSupabaseMock((table) => {
      if (table === "site") {
        return {
          data: { id: "site-1", static_site_record_id: "static-1" },
          error: null,
        };
      }
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
      staticSiteId: "static-1",
      email: "person@example.com",
    });

    expect(functionCalls).toEqual([
      {
        name: "get-magic-link",
        body: {
          siteId: "site-1",
          staticSiteId: "static-1",
          email: "person@example.com",
        },
      },
    ]);
  });

  it("uses the canonical static_site_record_id when a legacy alias also exists", async () => {
    const { supabase, functionCalls } = createSupabaseMock((table) => {
      if (table === "site") {
        return {
          data: {
            id: "site-1",
            static_site_id: "legacy-static-id",
            static_site_record_id: "canonical-static-id",
          },
          error: null,
        };
      }
      if (table === "site_meta") {
        return { data: { site_id: "site-1", email: "person@example.com" }, error: null };
      }
      return { data: null, error: null };
    }, { url: "https://wp.example.test/wp-admin" });

    await getMagicLoginLink(supabase, "site-1", "person@example.com");

    expect(functionCalls[0]).toEqual({
      name: "get-magic-link",
      body: {
        siteId: "site-1",
        staticSiteId: "canonical-static-id",
        email: "person@example.com",
      },
    });
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

  it("uses server-generated credentials and the reduced Lagos queue payload", async () => {
    const { supabase, functionCalls } = createSupabaseMock(
      { site_meta: { data: serverCredentials, error: null } },
      (name) => name === "create-site-record"
        ? {
          site: { id: "42", name: "Example", url: "https://ab1234567890123.onstatic.studio" },
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
        password: "server-password",
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
      },
    });
    expect(functionCalls[1]).toEqual({
      name: "queue-site",
      body: {
        siteHasMigration: false,
        site_id: "42",
        apiVersion: 2,
        phpVersion: "8.4",
      },
    });
  });

  it("uses the server-signed upload identity for migration provisioning", async () => {
    const directory = mkdtempSync(join(tmpdir(), "static-studio-site-"));
    const migrationFile = join(directory, "studio-backup-site.zip");
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
                key: "public/site-migration-ab1234567890123.zip",
                siteIdentifier: "ab1234567890123",
              };
            }
            if (action === "sign_parts") {
              return { urls: [{ partNumber: 1, url: "https://uploads.example.test/1" }] };
            }
            if (action === "complete") {
              return {
                ok: true,
                key: "public/site-migration-ab1234567890123.zip",
                siteIdentifier: "ab1234567890123",
                migrationToken: "signed-migration-token",
              };
            }
          }
          if (name === "create-site-record") {
            return { site: { id: "42", name: "Imported Site" } };
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
      });
      expect(create?.body).toMatchObject({
        name: "Imported Site",
        migration_token: "signed-migration-token",
      });
      expect(create?.body).not.toHaveProperty("url");
      expect(queue?.body).toMatchObject({ siteHasMigration: true });
    } finally {
      vi.unstubAllGlobals();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports when the server-created credential record is incomplete", async () => {
    const { password: _password, ...incompleteCredentials } = serverCredentials;
    const { supabase } = createSupabaseMock(
      { site_meta: { data: incompleteCredentials, error: null } },
      (name) => name === "create-site-record"
        ? { site: { id: "42", name: "Example", url: "https://demo.onstatic.studio" } }
        : { message: "Site queued" },
    );

    await expect(createSite(supabase, {
      name: "Example",
      email: "person@example.com",
      userId: "user-1",
    })).rejects.toThrow("password was missing from its server-generated credentials");
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

import { describe, expect, it } from "vitest";
import {
  addDomain,
  issueSsl,
  removeDomain,
  setMountPath,
  transferDomain,
} from "./domains.js";
import { createSupabaseMock } from "./test-utils.js";

function domainTables() {
  return {
    site: {
      data: {
        id: "site-1",
        url: "https://demo.onstatic.studio",
        status: "deployed",
        pull_zone_id: "501",
        mount_path: "/blog",
        bedrock: false,
      },
      error: null,
    },
    site_meta: {
      data: {
        site_id: "site-1",
        admin_url: "https://wp-demo.onstatic.studio/wp-admin",
        secret_key: "site-secret",
        basic_auth_user: "basic-user",
        basic_auth_password: "basic-password",
      },
      error: null,
    },
  };
}

describe("domain mutations", () => {
  it("uses the authenticated Lagos domain registry, mount-path, refresh, and export payloads", async () => {
    const { supabase, functionCalls } = createSupabaseMock(domainTables(), (name, body) => {
      if (name === "domain-actions") {
        return (body as { action?: string }).action === "lookup"
          ? { conflict: null }
          : { registered: true };
      }
      if (name === "connect-domain") {
        return {
          wordpress: { attempted: true, updated: true, warning: null },
          secondary: { error: "The www hostname could not be added." },
        };
      }
      if (name === "refresh-edge-rules") {
        return { results: [{ siteId: "site-1", status: "success" }] };
      }
      if (name === "export-site") return { data: { message: "Export started." } };
      return { ok: true };
    });

    await expect(addDomain(supabase, "site-1", "Example.COM")).resolves.toMatchObject({
      domain: "example.com",
      warnings: ["The www hostname could not be added."],
      registry: { registered: true },
    });

    expect(functionCalls).toEqual([
      {
        name: "domain-actions",
        body: { action: "lookup", site_id: "site-1", hostname: "example.com" },
      },
      {
        name: "connect-domain",
        body: {
          pullZoneId: "501",
          domain: "example.com",
          siteId: "site-1",
          secret_key: "site-secret",
          site_url: "https://wp-demo.onstatic.studio",
          basic_auth_user: "basic-user",
          basic_auth_password: "basic-password",
          bedrock: false,
          mount_path: "/blog",
        },
      },
      {
        name: "domain-actions",
        body: { action: "register", site_id: "site-1", hostname: "example.com" },
      },
      {
        name: "refresh-edge-rules",
        body: { siteId: "site-1", importExistingRedirects: true },
      },
      {
        name: "export-site",
        body: { site_id: "site-1", type: "export" },
      },
    ]);
  });

  it("stops before connecting when the domain registry reports a conflict", async () => {
    const { supabase, functionCalls } = createSupabaseMock(domainTables(), (name) =>
      name === "domain-actions"
        ? { conflict: { site_id: "site-2", site_name: "Existing Site" } }
        : { ok: true },
    );

    await expect(addDomain(supabase, "site-1", "example.com")).rejects.toThrow(
      "already connected to Existing Site",
    );
    expect(functionCalls).toEqual([
      {
        name: "domain-actions",
        body: { action: "lookup", site_id: "site-1", hostname: "example.com" },
      },
    ]);
  });

  it("does not switch public routing when WordPress rejects the domain update", async () => {
    const { supabase, calls, functionCalls } = createSupabaseMock(domainTables(), (name, body) => {
      if (name === "domain-actions") {
        return (body as { action?: string }).action === "lookup"
          ? { conflict: null }
          : { registered: true };
      }
      if (name === "connect-domain") {
        return {
          wordpress: { attempted: true, updated: false, warning: "WordPress is unavailable." },
          secondary: { error: null },
        };
      }
      return { ok: true };
    });

    await expect(addDomain(supabase, "site-1", "example.com")).rejects.toThrow(
      "CDN hostname was connected, but WordPress could not update",
    );
    expect(functionCalls.map((call) => call.name)).toEqual([
      "domain-actions",
      "connect-domain",
      "domain-actions",
    ]);
    expect(calls.some((call) => call.table === "site" && call.method === "update")).toBe(false);
  });

  it("treats a CDN removal warning as a failure and does not unregister the domain", async () => {
    const { supabase, functionCalls } = createSupabaseMock(domainTables(), (name) => {
      if (name === "get-hostnames") {
        return { hostnames: ["demo.onstatic.studio", "example.com"] };
      }
      if (name === "remove-domain") {
        return { removal: { removed: false, warning: "Bunny rejected the removal." } };
      }
      return { ok: true };
    });

    await expect(removeDomain(supabase, "site-1", "example.com")).rejects.toThrow(
      "Bunny rejected the removal.",
    );
    expect(functionCalls.map((call) => call.name)).toEqual([
      "domain-actions",
      "get-hostnames",
      "remove-domain",
    ]);
  });

  it("refuses to remove managed Studio hostnames", async () => {
    const { supabase, functionCalls } = createSupabaseMock(domainTables());

    await expect(removeDomain(supabase, "site-1", "demo.onstatic.studio"))
      .rejects.toThrow("cannot be removed");
    expect(functionCalls).toEqual([]);
  });

  it("rejects ambiguous or malformed removal targets before invoking the backend", async () => {
    const { supabase, functionCalls } = createSupabaseMock(domainTables());

    for (const domain of [
      "example.com:8443",
      "localhost",
      "127.0.0.1",
      "bad..example.com",
      "-bad.example.com",
    ]) {
      await expect(removeDomain(supabase, "site-1", domain)).rejects.toThrow();
    }
    expect(functionCalls).toEqual([]);
  });

  it("requires deployment to finish before changing domains", async () => {
    const tables = domainTables();
    tables.site.data.status = "deploying";
    const { supabase, functionCalls } = createSupabaseMock(tables);

    await expect(addDomain(supabase, "site-1", "example.com"))
      .rejects.toThrow("after this site finishes deploying");
    expect(functionCalls).toEqual([]);
  });
});

describe("issueSsl", () => {
  it("includes the site ID required by the hardened SSL endpoint", async () => {
    const { supabase, functionCalls } = createSupabaseMock({
      site: { data: { id: "site-1", status: "deployed" }, error: null },
    });

    await issueSsl(supabase, "site-1", "HTTPS://Example.COM./", false);

    expect(functionCalls).toEqual([
      {
        name: "issue-ssl",
        body: { siteId: "site-1", domain: "example.com", includeSecondary: false },
      },
    ]);
  });
});

describe("setMountPath", () => {
  it("supports an external SaaS domain without attaching it to the Studio CDN", async () => {
    const { supabase, functionCalls } = createSupabaseMock(domainTables(), (name) => {
      if (name === "connect-domain") {
        return { wordpress: { attempted: true, updated: true, warning: null } };
      }
      if (name === "refresh-edge-rules") {
        return { results: [{ siteId: "site-1", status: "success" }] };
      }
      if (name === "export-site") return { queued: true };
      return { ok: true };
    });

    await expect(setMountPath(supabase, "site-1", "example.com", "/docs/"))
      .resolves.toMatchObject({ domain: "example.com", mount_path: "/docs" });
    expect(functionCalls.map((call) => call.name)).toEqual([
      "connect-domain",
      "refresh-edge-rules",
      "export-site",
    ]);
  });
});

describe("transferDomain", () => {
  it("uses the authenticated domain transfer contract", async () => {
    const { supabase, functionCalls } = createSupabaseMock({
      site: { data: { id: "site-1", status: "deployed" }, error: null },
    }, { transferred: true });

    await transferDomain(supabase, "site-1", "site-2", "Example.COM");

    expect(functionCalls).toEqual([
      {
        name: "domain-actions",
        body: {
          action: "transfer",
          source_site_id: "site-1",
          site_id: "site-2",
          hostname: "example.com",
        },
      },
      {
        name: "export-site",
        body: { site_id: "site-2", type: "export" },
      },
    ]);
  });

  it("rejects a no-op transfer", async () => {
    const { supabase, functionCalls } = createSupabaseMock({});

    await expect(transferDomain(supabase, "site-1", "site-1", "example.com"))
      .rejects.toThrow("must be different");
    expect(functionCalls).toEqual([]);
  });

  it("rejects managed hostnames before reading either site", async () => {
    const { supabase, functionCalls, calls } = createSupabaseMock({});

    await expect(
      transferDomain(supabase, "site-1", "site-2", "demo.onstatic.studio"),
    ).rejects.toThrow("Only custom domains");
    expect(functionCalls).toEqual([]);
    expect(calls).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { FunctionsHttpError } from "@supabase/supabase-js";
import {
  addDomain,
  ensureWordPressReadyForDomain,
  issueSsl,
  removeDomain,
  setMountPath,
  transferDomain,
} from "./domains.js";
import { createSupabaseMock } from "./test-utils.js";

const onlineRuntime = {
  desired_state: "on",
  observed_state: "on",
  transitioning: false,
  job: null,
};

function domainTables() {
  return {
    site: {
      data: {
        id: "site-1",
        url: "https://demo.onstatic.studio",
        status: "deployed",
        pull_zone_id: "501",
        managed_url: "https://demo.onstatic.studio",
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
  it("uses lifecycle readiness, automatic SSL, registry, refresh, and export contracts", async () => {
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
      if (name === "platform-site-lifecycle") {
        return { ok: true, site: onlineRuntime };
      }
      if (name === "issue-ssl") return { message: "Certificate requested." };
      if (name === "refresh-edge-rules") {
        return { results: [{ siteId: "site-1", status: "success" }] };
      }
      if (name === "export-site") return { data: { message: "Export started." } };
      return { ok: true };
    });

    await expect(addDomain(supabase, "site-1", "Example.COM")).resolves.toMatchObject({
      domain: "example.com",
      warnings: ["The www hostname could not be added."],
      sslWarning: null,
      registry: { registered: true },
    });

    expect(functionCalls).toEqual([
      {
        name: "domain-actions",
        body: { action: "lookup", site_id: "site-1", hostname: "example.com" },
      },
      {
        name: "platform-site-lifecycle",
        body: { site_id: "site-1", action: "status" },
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
        name: "issue-ssl",
        body: {
          siteId: "site-1",
          domain: "example.com",
          includeSecondary: true,
        },
      },
      {
        name: "refresh-edge-rules",
        body: { siteId: "site-1", importExistingRedirects: true },
      },
      {
        name: "export-site",
        body: { site_id: "site-1", type: "export" },
      },
      {
        name: "domain-actions",
        body: { action: "register", site_id: "site-1", hostname: "example.com" },
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
      if (name === "platform-site-lifecycle") {
        return { ok: true, site: onlineRuntime };
      }
      return { ok: true };
    });

    await expect(addDomain(supabase, "site-1", "example.com")).rejects.toThrow(
      "The existing public URL and export were left unchanged",
    );
    expect(functionCalls.map((call) => call.name)).toEqual([
      "domain-actions",
      "platform-site-lifecycle",
      "connect-domain",
    ]);
    expect(calls.some((call) => call.table === "site" && call.method === "update")).toBe(false);
  });

  it("fails closed when connect-domain omits WordPress confirmation", async () => {
    const { supabase, functionCalls } = createSupabaseMock(domainTables(), (name, body) => {
      if (name === "domain-actions") {
        return (body as { action?: string }).action === "lookup"
          ? { conflict: null }
          : { registered: true };
      }
      if (name === "platform-site-lifecycle") {
        return { ok: true, site: onlineRuntime };
      }
      if (name === "connect-domain") return { primary: { added: true } };
      return { ok: true };
    });

    await expect(addDomain(supabase, "site-1", "example.com"))
      .rejects.toThrow("WordPress did not confirm the domain update");
    expect(functionCalls.map((call) => call.name)).toEqual([
      "domain-actions",
      "platform-site-lifecycle",
      "connect-domain",
    ]);
  });

  it("keeps a completed connection and reports automatic SSL failure as a warning", async () => {
    const { supabase, functionCalls } = createSupabaseMock(domainTables(), (name, body) => {
      if (name === "domain-actions") {
        return (body as { action?: string }).action === "lookup"
          ? { conflict: null }
          : { registered: true };
      }
      if (name === "platform-site-lifecycle") {
        return { ok: true, site: onlineRuntime };
      }
      if (name === "connect-domain") {
        return { wordpress: { attempted: true, updated: true, warning: null } };
      }
      if (name === "issue-ssl") {
        return { error: "SSL failed", details: "DNS is not ready" };
      }
      if (name === "refresh-edge-rules") {
        return { results: [{ siteId: "site-1", status: "success" }] };
      }
      if (name === "export-site") return { queued: true };
      return { ok: true };
    });

    await expect(addDomain(supabase, "site-1", "example.com")).resolves.toMatchObject({
      domain: "example.com",
      sslWarning: "its SSL certificate could not be issued automatically: DNS is not ready",
      warnings: ["its SSL certificate could not be issued automatically: DNS is not ready"],
    });
    expect(functionCalls.map((call) => call.name)).toEqual([
      "domain-actions",
      "platform-site-lifecycle",
      "connect-domain",
      "issue-ssl",
      "refresh-edge-rules",
      "export-site",
      "domain-actions",
    ]);
  });

  it("prepares WordPress and exports without attaching, registering, or securing the hostname", async () => {
    const { supabase, calls, functionCalls } = createSupabaseMock(domainTables(), (name, body) => {
      if (name === "domain-actions") {
        return (body as { action?: string }).action === "lookup"
          ? { conflict: null }
          : { registered: true };
      }
      if (name === "platform-site-lifecycle") {
        return { ok: true, site: onlineRuntime };
      }
      if (name === "connect-domain") {
        return { wordpress: { attempted: true, updated: true, warning: null } };
      }
      if (name === "export-site") return { queued: true };
      return { ok: true };
    });

    await expect(addDomain(supabase, "site-1", "example.com", { prepareOnly: true }))
      .resolves.toMatchObject({
        domain: "example.com",
        prepared: true,
        sslWarning: null,
        export: { queued: true },
      });

    expect(functionCalls).toEqual([
      {
        name: "domain-actions",
        body: { action: "lookup", site_id: "site-1", hostname: "example.com" },
      },
      {
        name: "platform-site-lifecycle",
        body: { site_id: "site-1", action: "status" },
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
          updateOnly: true,
        },
      },
      {
        name: "export-site",
        body: { site_id: "site-1", type: "export" },
      },
    ]);
    expect(calls).toContainEqual({
      table: "site",
      method: "update",
      args: [{ url: "https://example.com" }],
    });
  });

  it("suggests prepare-only when the CDN reports that DNS is not ready", async () => {
    const { supabase, functionCalls } = createSupabaseMock(domainTables(), (name, body) => {
      if (name === "domain-actions") {
        return (body as { action?: string }).action === "lookup"
          ? { conflict: null }
          : { registered: true };
      }
      if (name === "platform-site-lifecycle") {
        return { ok: true, site: onlineRuntime };
      }
      return { ok: true };
    });
    const invoke = supabase.functions.invoke.bind(supabase.functions);
    supabase.functions.invoke = async (name: string, options: { body?: unknown } = {}) => {
      if (name !== "connect-domain") return invoke(name, options);
      functionCalls.push({ name, body: options.body ?? {} });
      return {
        data: null,
        error: new FunctionsHttpError(new Response(JSON.stringify({
          error: "Failed to add hostname to BunnyCDN",
          details: "The domain example.com cannot be registered yet.",
          can_prepare_without_dns: true,
        }), {
          status: 409,
          headers: { "content-type": "application/json" },
        })),
      };
    };

    await expect(addDomain(supabase, "site-1", "example.com")).rejects.toMatchObject({
      message: expect.stringContaining("Run the command again with --prepare-only"),
      status: 409,
      canPrepareWithoutDns: true,
    });
  });

  it("treats the site's generated white-label alias as managed when adding a domain", async () => {
    const tables: any = domainTables();
    tables.site.data.url = "https://ab1234567890123.ls-static.studio";
    tables.site.data.provisioning_id = "ab1234567890123";
    tables.site.data.wordpress_base_domain = "ls-static.studio";
    tables.site_meta.data.admin_url =
      "https://wp-ab1234567890123.ls-static.studio/wp-admin";
    const { supabase, calls } = createSupabaseMock(tables, (name, body) => {
      if (name === "domain-actions") {
        return (body as { action?: string }).action === "lookup"
          ? { conflict: null }
          : { registered: true };
      }
      if (name === "platform-site-lifecycle") {
        return { ok: true, site: onlineRuntime };
      }
      if (name === "connect-domain") {
        return { wordpress: { attempted: true, updated: true, warning: null } };
      }
      if (name === "refresh-edge-rules") {
        return { results: [{ siteId: "site-1", status: "success" }] };
      }
      return { ok: true };
    });

    await addDomain(supabase, "site-1", "example.com");

    expect(calls).toContainEqual({
      table: "site",
      method: "update",
      args: [{ url: "https://example.com" }],
    });
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

  it("refuses to remove the site's generated white-label hostname", async () => {
    const tables: any = domainTables();
    tables.site.data.provisioning_id = "ab1234567890123";
    tables.site.data.wordpress_base_domain = "ls-static.studio";
    tables.site_meta.data.admin_url =
      "https://wp-ab1234567890123.ls-static.studio/wp-admin";
    const { supabase, functionCalls } = createSupabaseMock(tables);

    await expect(
      removeDomain(supabase, "site-1", "ab1234567890123.ls-static.studio"),
    ).rejects.toThrow("cannot be removed");
    expect(functionCalls).toEqual([]);
  });

  it("prefers the branded static hostname when removing a primary custom domain", async () => {
    const tables: any = domainTables();
    tables.site.data.url = "https://example.com";
    tables.site.data.provisioning_id = "ab1234567890123";
    tables.site.data.wordpress_base_domain = "ls-static.studio";
    tables.site_meta.data.admin_url =
      "https://wp-ab1234567890123.ls-static.studio/wp-admin";
    const branded = "ab1234567890123.ls-static.studio";
    const { supabase, calls, functionCalls } = createSupabaseMock(tables, (name) => {
      if (name === "get-hostnames") {
        return {
          hostnames: [
            "example.com",
            "www.example.com",
            "ab1234567890123.onstatic.studio",
            branded,
          ],
        };
      }
      if (name === "remove-domain") {
        return { removal: { removed: true, warning: null } };
      }
      if (name === "refresh-edge-rules") {
        return { results: [{ siteId: "site-1", status: "success" }] };
      }
      return { ok: true };
    });

    await expect(removeDomain(supabase, "site-1", "example.com"))
      .resolves.toMatchObject({ primary: branded });

    const removals = functionCalls.filter((call) => call.name === "remove-domain");
    expect(removals).toHaveLength(2);
    expect(removals.map((call) => (call.body as { oldUrl?: string }).oldUrl))
      .toEqual([`https://${branded}`, `https://${branded}`]);
    expect(calls).toContainEqual({
      table: "site",
      method: "update",
      args: [{ url: `https://${branded}` }],
    });
  });

  it("keeps WordPress on the surviving primary when removing a secondary domain", async () => {
    const tables: any = domainTables();
    tables.site.data.url = "https://primary.example.com";
    const { supabase, calls, functionCalls } = createSupabaseMock(
      tables,
      (name) => {
        if (name === "get-hostnames") {
          return {
            hostnames: [
              "demo.onstatic.studio",
              "primary.example.com",
              "secondary.example.com",
            ],
          };
        }
        if (name === "remove-domain") {
          return { removal: { removed: true, warning: null } };
        }
        if (name === "refresh-edge-rules") {
          return { results: [{ siteId: "site-1", status: "success" }] };
        }
        return { ok: true };
      },
    );

    await expect(removeDomain(supabase, "site-1", "secondary.example.com"))
      .resolves.toMatchObject({ primary: "primary.example.com" });

    const removal = functionCalls.find((call) => call.name === "remove-domain");
    expect(removal?.body).toMatchObject({
      domain: "secondary.example.com",
      oldUrl: "https://primary.example.com",
    });
    expect(calls).not.toContainEqual({
      table: "site",
      method: "update",
      args: [{ url: "https://primary.example.com" }],
    });
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

describe("ensureWordPressReadyForDomain", () => {
  it("starts a paused runtime and polls until WordPress is online", async () => {
    const offlineRuntime = {
      desired_state: "ready_off",
      observed_state: "ready_off",
      transitioning: false,
      job: null,
    };
    const startingRuntime = {
      desired_state: "on",
      observed_state: "ready_off",
      transitioning: true,
      job: { status: "queued" },
    };
    let lifecycleRequest = 0;
    const { supabase, functionCalls } = createSupabaseMock({}, () => {
      lifecycleRequest += 1;
      return {
        ok: true,
        site: [offlineRuntime, startingRuntime, onlineRuntime][lifecycleRequest - 1],
      };
    });

    await expect(ensureWordPressReadyForDomain(supabase, "42", {
      pollIntervalMs: 1,
      timeoutMs: 5,
      sleep: async () => undefined,
    })).resolves.toEqual(onlineRuntime);

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
        name: "platform-site-lifecycle",
        body: { site_id: "42", action: "status" },
      },
    ]);
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

    await expect(transferDomain(supabase, "site-1", "site-2", "Example.COM"))
      .resolves.toMatchObject({ transferred: true, sslWarning: null });

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
        name: "issue-ssl",
        body: {
          siteId: "site-2",
          domain: "example.com",
          includeSecondary: true,
        },
      },
      {
        name: "export-site",
        body: { site_id: "site-2", type: "export" },
      },
    ]);
  });

  it("does not roll back a transfer when automatic SSL issuance fails", async () => {
    const { supabase, functionCalls } = createSupabaseMock({
      site: { data: { id: "site-1", status: "deployed" }, error: null },
    }, (name) => {
      if (name === "domain-actions") return { transferred: true };
      if (name === "issue-ssl") {
        return { error: "SSL failed", details: "DNS is not ready" };
      }
      return { queued: true };
    });

    await expect(transferDomain(supabase, "site-1", "site-2", "example.com"))
      .resolves.toMatchObject({
        transferred: true,
        sslWarning: "its SSL certificate could not be issued automatically: DNS is not ready",
        warnings: ["its SSL certificate could not be issued automatically: DNS is not ready"],
      });
    expect(functionCalls.map((call) => call.name)).toEqual([
      "domain-actions",
      "issue-ssl",
      "export-site",
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

  it("rejects a generated white-label hostname after loading site identity", async () => {
    const { supabase, functionCalls } = createSupabaseMock({
      site: {
        data: {
          id: "site-1",
          status: "deployed",
          provisioning_id: "ab1234567890123",
          wordpress_base_domain: "ls-static.studio",
        },
        error: null,
      },
    });

    await expect(transferDomain(
      supabase,
      "site-1",
      "site-2",
      "ab1234567890123.ls-static.studio",
    )).rejects.toThrow("Only custom domains");
    expect(functionCalls).toEqual([]);
  });
});

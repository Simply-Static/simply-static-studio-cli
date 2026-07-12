import { describe, expect, it } from "vitest";
import {
  connectEnvironmentDomain,
  createEnvironment,
  deleteEnvironment,
  disableEnvironments,
  issueEnvironmentSsl,
  listEnvironmentHostnames,
  parentSubdomainFromAdminUrl,
  removeEnvironmentDomains,
  resolveEnvironment,
} from "./environments.js";
import { createSupabaseMock } from "./test-utils.js";

function environmentDomainTables(overrides: {
  site?: Record<string, unknown>;
  environment?: Record<string, unknown>;
} = {}) {
  return {
    site: {
      data: {
        id: "site-1",
        status: "deployed",
        bedrock: false,
        ...overrides.site,
      },
      error: null,
    },
    site_meta: {
      data: {
        site_id: "site-1",
        admin_url: "https://wp-demo.onstatic.studio/wp-admin",
        secret_key: "site-secret",
      },
      error: null,
    },
    site_environment: {
      data: [{
        id: "env-1",
        site_id: "site-1",
        name: "staging",
        title: "Staging",
        url: "https://demo-staging.onstatic.studio",
        pull_zone_id: "701",
        ...overrides.environment,
      }],
      error: null,
    },
  };
}

describe("parentSubdomainFromAdminUrl", () => {
  it("extracts parent subdomains from supported WordPress host styles", () => {
    expect(parentSubdomainFromAdminUrl("https://wp-demo.onstatic.studio/wp-admin")).toBe("demo");
    expect(parentSubdomainFromAdminUrl("https://wp.demo.onstatic.studio/wp-admin")).toBe("demo");
    expect(parentSubdomainFromAdminUrl("https://demo.example.test/wp-admin")).toBe("demo");
  });
});

describe("createEnvironment", () => {
  it("invokes create-environment with the parent subdomain and secret", async () => {
    const { supabase, functionCalls } = createSupabaseMock({
      site_meta: {
        data: {
          site_id: "site-1",
          admin_url: "https://wp-demo.onstatic.studio/wp-admin",
          secret_key: "secret",
        },
        error: null,
      },
    });

    await createEnvironment(supabase, "site-1", "Staging");

    expect(functionCalls).toEqual([
      {
        name: "create-environment",
        body: {
          site_id: "site-1",
          parent_subdomain: "demo",
          title: "Staging",
          secret_key: "secret",
        },
      },
    ]);
  });

  it("fails before invoking the backend when required site metadata is missing", async () => {
    const { supabase, functionCalls } = createSupabaseMock({
      site_meta: {
        data: { site_id: "site-1", admin_url: "https://wp-demo.onstatic.studio/wp-admin" },
        error: null,
      },
    });

    await expect(createEnvironment(supabase, "site-1", "Staging")).rejects.toThrow(
      "missing admin_url or secret_key",
    );
    expect(functionCalls).toEqual([]);
  });
});

describe("deleteEnvironment", () => {
  it("includes site_id in the hardened delete payload", async () => {
    const { supabase, functionCalls } = createSupabaseMock({
      site_meta: {
        data: {
          site_id: "site-1",
          admin_url: "https://wp-demo.onstatic.studio/wp-admin",
          secret_key: "secret",
        },
        error: null,
      },
    });

    await deleteEnvironment(supabase, "site-1", "QA Review");

    expect(functionCalls).toEqual([
      {
        name: "delete-environment",
        body: {
          site_id: "site-1",
          parent_subdomain: "demo",
          name: "qa-review",
          secret_key: "secret",
        },
      },
    ]);
  });
});

describe("disableEnvironments", () => {
  it("includes site_id for every child deletion and the final integration disable", async () => {
    const { supabase, functionCalls } = createSupabaseMock({
      site: { data: { id: "site-1" }, error: null },
      site_meta: {
        data: {
          site_id: "site-1",
          admin_url: "https://wp-demo.onstatic.studio/wp-admin",
          secret_key: "secret",
        },
        error: null,
      },
      addon: { data: { id: "addon-1", environments: true }, error: null },
      site_environment: {
        data: [{ name: "staging" }, { name: "qa" }],
        error: null,
      },
    });

    await disableEnvironments(supabase, "site-1");

    expect(functionCalls).toEqual([
      {
        name: "delete-environment",
        body: {
          site_id: "site-1",
          parent_subdomain: "demo",
          name: "staging",
          secret_key: "secret",
        },
      },
      {
        name: "delete-environment",
        body: {
          site_id: "site-1",
          parent_subdomain: "demo",
          name: "qa",
          secret_key: "secret",
          disable_integration: true,
        },
      },
    ]);
  });
});

describe("resolveEnvironment", () => {
  it("resolves an environment under its parent site by ID, name, or title", async () => {
    const { supabase } = createSupabaseMock(environmentDomainTables());

    await expect(resolveEnvironment(supabase, "site-1", "env-1")).resolves.toMatchObject({ id: "env-1" });
    await expect(resolveEnvironment(supabase, "site-1", "staging")).resolves.toMatchObject({ id: "env-1" });
    await expect(resolveEnvironment(supabase, "site-1", "Staging")).resolves.toMatchObject({ id: "env-1" });
  });

  it("fails clearly when the environment is not assigned to the site", async () => {
    const { supabase } = createSupabaseMock({
      site_environment: { data: [], error: null },
    });

    await expect(resolveEnvironment(supabase, "site-1", "missing")).rejects.toThrow(
      "Environment missing was not found for site site-1",
    );
  });
});

describe("listEnvironmentHostnames", () => {
  it("loads hostnames from the environment pull zone and separates custom domains", async () => {
    const { supabase, functionCalls } = createSupabaseMock(
      environmentDomainTables(),
      { hostnames: ["demo-staging.onstatic.studio", "preview.example.com"] },
    );

    await expect(listEnvironmentHostnames(supabase, "site-1", "Staging")).resolves.toMatchObject({
      managedHostname: "demo-staging.onstatic.studio",
      hostnames: ["demo-staging.onstatic.studio", "preview.example.com"],
      customHostnames: ["preview.example.com"],
    });
    expect(functionCalls).toEqual([
      { name: "get-hostnames", body: { pullZoneId: "701" } },
    ]);
  });

  it("recognizes numbered Static Studio cluster hostnames as managed", async () => {
    const { supabase } = createSupabaseMock(
      environmentDomainTables({
        environment: { url: "https://demo-staging.static1.studio" },
      }),
      { hostnames: ["demo-staging.static1.studio", "preview.example.com"] },
    );

    await expect(listEnvironmentHostnames(supabase, "site-1", "staging")).resolves.toMatchObject({
      managedHostname: "demo-staging.static1.studio",
      hostnames: ["demo-staging.static1.studio", "preview.example.com"],
      customHostnames: ["preview.example.com"],
    });
  });

  it("blocks domain operations until the parent site is deployed", async () => {
    const { supabase, functionCalls } = createSupabaseMock(
      environmentDomainTables({ site: { status: "deploying" } }),
    );

    await expect(listEnvironmentHostnames(supabase, "site-1", "staging")).rejects.toThrow(
      "after the parent site finishes deploying",
    );
    expect(functionCalls).toEqual([]);
  });

  it("requires both an environment pull zone and a managed Studio fallback", async () => {
    const withoutZone = createSupabaseMock(
      environmentDomainTables({ environment: { pull_zone_id: null } }),
    );
    await expect(listEnvironmentHostnames(withoutZone.supabase, "site-1", "staging")).rejects.toThrow(
      "missing a CDN pull zone",
    );

    const withoutFallback = createSupabaseMock(
      environmentDomainTables({ environment: { url: "https://preview.example.com" } }),
    );
    await expect(listEnvironmentHostnames(withoutFallback.supabase, "site-1", "staging")).rejects.toThrow(
      "determine the environment Studio hostname",
    );
  });
});

describe("connectEnvironmentDomain", () => {
  it("replaces the current custom domain and surfaces WordPress and edge-rule warnings", async () => {
    let hostnameReads = 0;
    const { supabase, functionCalls } = createSupabaseMock(environmentDomainTables(), (name) => {
      if (name === "get-hostnames") {
        hostnameReads += 1;
        return hostnameReads === 1
          ? { hostnames: ["demo-staging.onstatic.studio", "old.example.com"] }
          : { hostnames: ["demo-staging.onstatic.studio", "new.example.com"] };
      }
      if (name === "remove-domain") return { removal: { removed: true, warning: null } };
      if (name === "connect-domain") {
        return { wordpress: { warning: "WordPress could not switch immediately." } };
      }
      if (name === "create-edge-rules") {
        return {
          warning: {
            message: "Some default edge rules could not be created.",
            rules: [{ details: "Trailing slash rule failed." }],
          },
        };
      }
      return { ok: true };
    });

    await expect(
      connectEnvironmentDomain(supabase, "site-1", "Staging", "NEW.Example.com"),
    ).resolves.toMatchObject({
      domain: "new.example.com",
      removed: ["old.example.com"],
      customHostnames: ["new.example.com"],
      warnings: [
        "WordPress could not switch immediately.",
        "Some default edge rules could not be created.",
        "Trailing slash rule failed.",
      ],
    });

    expect(functionCalls).toEqual([
      { name: "get-hostnames", body: { pullZoneId: "701" } },
      {
        name: "remove-domain",
        body: {
          pullZoneId: "701",
          domain: "old.example.com",
          siteId: "site-1",
          environmentName: "staging",
        },
      },
      {
        name: "connect-domain",
        body: {
          pullZoneId: "701",
          domain: "new.example.com",
          includeSecondary: false,
          siteId: "site-1",
          environmentName: "staging",
          secret_key: "site-secret",
          site_url: "https://wp-demo.onstatic.studio",
          bedrock: false,
        },
      },
      {
        name: "create-edge-rules",
        body: {
          pullZoneId: "701",
          subdomain: "demo-staging",
          tld: "onstatic.studio",
          newDomain: "new.example.com",
        },
      },
      { name: "get-hostnames", body: { pullZoneId: "701" } },
    ]);
  });

  it("requires remove-domain to confirm nested removal.removed before replacing", async () => {
    const { supabase, functionCalls } = createSupabaseMock(environmentDomainTables(), (name) => {
      if (name === "get-hostnames") {
        return { hostnames: ["demo-staging.onstatic.studio", "old.example.com"] };
      }
      if (name === "remove-domain") {
        return { removal: { removed: false, warning: "Bunny kept the old hostname." } };
      }
      return { ok: true };
    });

    await expect(
      connectEnvironmentDomain(supabase, "site-1", "staging", "new.example.com"),
    ).rejects.toThrow("Bunny kept the old hostname.");
    expect(functionCalls.map((call) => call.name)).toEqual(["get-hostnames", "remove-domain"]);
  });

  it("rejects unsafe and managed custom hostnames before invoking domain functions", async () => {
    const { supabase, functionCalls } = createSupabaseMock(environmentDomainTables());

    await expect(
      connectEnvironmentDomain(supabase, "site-1", "staging", "example.com/path"),
    ).rejects.toThrow("without credentials, a port, a path, a query, or a fragment");
    await expect(
      connectEnvironmentDomain(supabase, "site-1", "staging", "example.com:8443"),
    ).rejects.toThrow("without credentials, a port, a path, a query, or a fragment");
    await expect(
      connectEnvironmentDomain(supabase, "site-1", "staging", "other.onstatic.studio"),
    ).rejects.toThrow("cannot use a managed Studio hostname");
    expect(functionCalls).toEqual([]);
  });

  it("surfaces edge-rule failures instead of returning a partial success", async () => {
    let hostnameReads = 0;
    const { supabase } = createSupabaseMock(environmentDomainTables(), (name) => {
      if (name === "get-hostnames") {
        hostnameReads += 1;
        return { hostnames: ["demo-staging.onstatic.studio"] };
      }
      if (name === "connect-domain") return { wordpress: { warning: null } };
      if (name === "create-edge-rules") return { error: "Environment edge rules failed." };
      return { ok: true };
    });

    await expect(
      connectEnvironmentDomain(supabase, "site-1", "staging", "new.example.com"),
    ).rejects.toThrow("Environment edge rules failed.");
    expect(hostnameReads).toBe(1);
  });
});

describe("removeEnvironmentDomains", () => {
  it("removes every custom hostname, restores WordPress to the managed fallback, and resets edge rules", async () => {
    let hostnameReads = 0;
    const { supabase, functionCalls } = createSupabaseMock(environmentDomainTables(), (name, body) => {
      if (name === "get-hostnames") {
        hostnameReads += 1;
        return hostnameReads === 1
          ? { hostnames: ["demo-staging.onstatic.studio", "one.example.com", "two.example.com"] }
          : { hostnames: ["demo-staging.onstatic.studio"] };
      }
      if (name === "remove-domain") return { removal: { removed: true } };
      if (name === "connect-domain") {
        expect(body).toMatchObject({ updateOnly: true });
        return { wordpress: { warning: "WordPress fallback queued." } };
      }
      if (name === "create-edge-rules") return { message: "Rules reset." };
      return { ok: true };
    });

    await expect(removeEnvironmentDomains(supabase, "site-1", "env-1")).resolves.toMatchObject({
      removed: ["one.example.com", "two.example.com"],
      managedHostname: "demo-staging.onstatic.studio",
      customHostnames: [],
      warnings: ["WordPress fallback queued."],
    });

    expect(functionCalls).toEqual([
      { name: "get-hostnames", body: { pullZoneId: "701" } },
      {
        name: "remove-domain",
        body: {
          pullZoneId: "701",
          domain: "one.example.com",
          siteId: "site-1",
          environmentName: "staging",
        },
      },
      {
        name: "remove-domain",
        body: {
          pullZoneId: "701",
          domain: "two.example.com",
          siteId: "site-1",
          environmentName: "staging",
        },
      },
      {
        name: "connect-domain",
        body: {
          pullZoneId: "701",
          domain: "demo-staging.onstatic.studio",
          updateOnly: true,
          includeSecondary: false,
          siteId: "site-1",
          environmentName: "staging",
          secret_key: "site-secret",
          site_url: "https://wp-demo.onstatic.studio",
          bedrock: false,
        },
      },
      {
        name: "create-edge-rules",
        body: {
          pullZoneId: "701",
          subdomain: "demo-staging",
          tld: "onstatic.studio",
        },
      },
      { name: "get-hostnames", body: { pullZoneId: "701" } },
    ]);
  });
});

describe("issueEnvironmentSsl", () => {
  it("verifies environment ownership and requests SSL without a secondary hostname", async () => {
    const { supabase, functionCalls } = createSupabaseMock(environmentDomainTables(), (name) =>
      name === "get-hostnames"
        ? { hostnames: ["demo-staging.onstatic.studio", "preview.example.com"] }
        : { message: "SSL requested." },
    );

    await issueEnvironmentSsl(supabase, "site-1", "staging", "Preview.Example.com");

    expect(functionCalls).toEqual([
      { name: "get-hostnames", body: { pullZoneId: "701" } },
      {
        name: "issue-ssl",
        body: { domain: "preview.example.com", includeSecondary: false, siteId: "site-1" },
      },
    ]);
  });

  it("does not issue SSL for a hostname outside the environment pull zone", async () => {
    const { supabase, functionCalls } = createSupabaseMock(
      environmentDomainTables(),
      { hostnames: ["demo-staging.onstatic.studio"] },
    );

    await expect(
      issueEnvironmentSsl(supabase, "site-1", "staging", "other.example.com"),
    ).rejects.toThrow("is not connected to this environment's CDN zone");
    expect(functionCalls.map((call) => call.name)).toEqual(["get-hostnames"]);
  });
});

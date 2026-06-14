import { describe, expect, it } from "vitest";
import { DEFAULT_TLD } from "./constants.js";
import { CliError } from "./errors.js";
import {
  basicAuthCredentialsFromMeta,
  generateSiteSeed,
  getMagicLoginLink,
  listSites,
  sitePushModeToExportType,
} from "./sites.js";
import { createSupabaseMock } from "./test-utils.js";

describe("generateSiteSeed", () => {
  it("derives default URLs from the subdomain and TLD", () => {
    const seed = generateSiteSeed({
      name: "Example",
      subdomain: "demo",
      tld: DEFAULT_TLD,
    });

    expect(seed).toEqual({
      name: "Example",
      subdomain: "demo",
      tld: "onstatic.studio",
      url: "https://demo.onstatic.studio",
      adminUrl: "https://wp-demo.onstatic.studio/wp-admin",
    });
  });

  it("preserves explicit URLs", () => {
    const seed = generateSiteSeed({
      name: "Example",
      subdomain: "demo",
      tld: "example.test",
      url: "https://custom.example",
      adminUrl: "https://wp.custom.example/wp-admin",
    });

    expect(seed.url).toBe("https://custom.example");
    expect(seed.adminUrl).toBe("https://wp.custom.example/wp-admin");
  });
});

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
});

describe("listSites validation", () => {
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

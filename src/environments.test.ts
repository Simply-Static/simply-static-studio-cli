import { describe, expect, it } from "vitest";
import { createEnvironment, parentSubdomainFromAdminUrl } from "./environments.js";
import { createSupabaseMock } from "./test-utils.js";

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
          parent_subdomain: "demo",
          title: "Staging",
          secret_key: "secret",
        },
      },
    ]);
  });
});

import { describe, expect, it } from "vitest";
import { DEFAULT_TLD } from "./constants.js";
import { CliError } from "./errors.js";
import { generateSiteSeed, sitePushModeToExportType } from "./sites.js";

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

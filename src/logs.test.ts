import { afterEach, describe, expect, it, vi } from "vitest";
import { getDebugLog, wpBaseUrlFromAdminUrl } from "./logs.js";
import { createSupabaseMock } from "./test-utils.js";

describe("wpBaseUrlFromAdminUrl", () => {
  it("removes regular and Bedrock wp-admin paths", () => {
    expect(wpBaseUrlFromAdminUrl("https://wp-demo.onstatic.studio/wp-admin").toString()).toBe(
      "https://wp-demo.onstatic.studio/",
    );
    expect(wpBaseUrlFromAdminUrl("https://wp-demo.onstatic.studio/wp/wp-admin").toString()).toBe(
      "https://wp-demo.onstatic.studio/wp",
    );
  });
});

describe("getDebugLog", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches the WordPress debug log with the site secret and filters output", async () => {
    const { supabase } = createSupabaseMock({
      site_meta: {
        data: {
          site_id: "site-1",
          admin_url: "http://127.0.0.1/wp-admin",
          secret_key: "secret-value",
        },
        error: null,
      },
    });
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ "X-Secret-Key": "secret-value" });
      return new Response(
        JSON.stringify({
          data: "Info: boot\nPHP Warning: cache\nPHP Error: failed\nDebug: done",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await getDebugLog(supabase, "site-1", {
      allowInsecureHttp: true,
      allowPrivateNetwork: true,
      level: "error",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.endpoint).toBe("http://127.0.0.1/wp-json/static-studio/v1/debug-log");
    expect(result.log).toBe("PHP Error: failed");
    expect(result.totalLines).toBe(4);
    expect(result.returnedLines).toBe(1);
  });
});

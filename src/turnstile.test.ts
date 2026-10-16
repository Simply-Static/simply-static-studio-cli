import { describe, expect, it } from "vitest";
import {
  createTurnstileChallengeHtml,
  DEFAULT_TURNSTILE_SITE_KEY,
  normalizeTurnstileToken,
  parseTurnstileCompletionBody,
  requestTurnstileToken,
} from "./turnstile.js";

describe("Turnstile login challenge", () => {
  it("builds a local page with the Studio widget and scoped action", () => {
    const html = createTurnstileChallengeHtml({
      siteKey: DEFAULT_TURNSTILE_SITE_KEY,
      action: "studio_login",
      completionPath: `/${"a".repeat(48)}/complete`,
      scriptNonce: "abcdefghijklmnop",
    });

    expect(html).toContain(DEFAULT_TURNSTILE_SITE_KEY);
    expect(html).toContain("studio_login");
    expect(html).toContain("https://challenges.cloudflare.com/turnstile/v0/api.js");
    expect(html).toMatch(/api\.js[^>]* defer>/);
    expect(html).not.toMatch(/api\.js[^>]* async/);
    expect(html).toContain(`/${"a".repeat(48)}/complete`);
  });

  it("accepts only a bounded opaque completion token", () => {
    expect(normalizeTurnstileToken("  token-value-123  ")).toBe("token-value-123");
    expect(parseTurnstileCompletionBody('{"token":"token-value-123"}')).toBe(
      "token-value-123",
    );
    expect(() => parseTurnstileCompletionBody('{"token":"short"}')).toThrow(/invalid security token/i);
    expect(() => normalizeTurnstileToken("a".repeat(2_049))).toThrow(
      /invalid security token/i,
    );
    expect(() => parseTurnstileCompletionBody('{"token":"token-value-123","extra":true}'))
      .toThrow(/completion request is invalid/i);
  });

  it("serves the challenge only on loopback and returns its token", async () => {
    let resolveUrl!: (url: string) => void;
    const urlPromise = new Promise<string>((resolve) => {
      resolveUrl = resolve;
    });
    const tokenPromise = requestTurnstileToken({
      openBrowser: false,
      timeoutMs: 2_000,
      status(message) {
        const match = message.match(/http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{48}/);
        if (match) resolveUrl(match[0]);
      },
    });

    const url = await urlPromise;
    const page = await fetch(url);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain(
      "https://challenges.cloudflare.com",
    );
    expect(page.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(await page.text()).toContain("Static Studio security check");

    const completed = await fetch(`${url}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "verified-turnstile-token" }),
    });
    expect(completed.status).toBe(200);
    await expect(tokenPromise).resolves.toBe("verified-turnstile-token");
  });
});

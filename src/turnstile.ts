import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { CliError } from "./errors.js";

export const DEFAULT_TURNSTILE_SITE_KEY = "0x4AAAAAAFDTFaIAkEQqcB4n";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000;
const MAX_COMPLETION_BODY_BYTES = 8 * 1024;
const TURNSTILE_SCRIPT_URL =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onTurnstileLoad";

export function normalizeTurnstileToken(value: unknown): string {
  const token = String(value || "").trim();
  if (
    token.length < 10 ||
    token.length > 2_048 ||
    /[\u0000-\u0020\u007f]/.test(token)
  ) {
    throw new CliError("Cloudflare Turnstile returned an invalid security token.");
  }
  return token;
}

function assertSiteKey(value: string): string {
  const siteKey = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(siteKey)) {
    throw new CliError("STATIC_STUDIO_TURNSTILE_SITE_KEY is invalid.");
  }
  return siteKey;
}

function assertAction(value: string): string {
  const action = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(action)) {
    throw new CliError("Turnstile action is invalid.");
  }
  return action;
}

function htmlJson(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

export function createTurnstileChallengeHtml(options: {
  siteKey: string;
  action: string;
  completionPath: string;
  scriptNonce: string;
}): string {
  const siteKey = assertSiteKey(options.siteKey);
  const action = assertAction(options.action);
  const completionPath = String(options.completionPath || "");
  if (!/^\/[a-f0-9]{48}\/complete$/.test(completionPath)) {
    throw new CliError("Turnstile completion path is invalid.");
  }
  const nonce = String(options.scriptNonce || "");
  if (!/^[A-Za-z0-9+/=_-]{16,128}$/.test(nonce)) {
    throw new CliError("Turnstile page nonce is invalid.");
  }

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>Static Studio security check</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #111827; color: #f9fafb; }
    main { width: min(28rem, calc(100vw - 2rem)); padding: 2rem; border: 1px solid #374151; border-radius: 1rem; background: #1f2937; box-shadow: 0 1rem 3rem #0006; }
    h1 { margin: 0 0 .75rem; font-size: 1.35rem; }
    p { margin: 0 0 1.5rem; color: #d1d5db; line-height: 1.5; }
    #status { margin: 1rem 0 0; font-size: .9rem; }
  </style>
  <script nonce="${nonce}">
    const completionPath = ${htmlJson(completionPath)};
    const showStatus = (message) => { document.getElementById('status').textContent = message; };
    const complete = async (token) => {
      try {
        const response = await fetch(completionPath, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({token}),
        });
        if (!response.ok) throw new Error('The CLI rejected the security check.');
        showStatus('Security check complete. You can close this window.');
        setTimeout(() => window.close(), 600);
      } catch (error) {
        showStatus(error && error.message ? error.message : 'Could not return the security check to the CLI.');
      }
    };
    window.onTurnstileLoad = () => {
      window.turnstile.render('#turnstile', {
        sitekey: ${htmlJson(siteKey)},
        action: ${htmlJson(action)},
        theme: 'dark',
        size: 'flexible',
        appearance: 'interaction-only',
        callback: complete,
        'expired-callback': () => showStatus('The security check expired. Please try again.'),
        'error-callback': () => showStatus('The security check could not be completed. Please try again.'),
      });
    };
  </script>
  <script nonce="${nonce}" src="${TURNSTILE_SCRIPT_URL}" defer></script>
</head>
<body>
  <main>
    <h1>Static Studio security check</h1>
    <p>Complete the Cloudflare check to continue signing in from the CLI.</p>
    <div id="turnstile"></div>
    <p id="status" role="status" aria-live="polite">Waiting for verification…</p>
  </main>
</body>
</html>`;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_COMPLETION_BODY_BYTES) {
      throw new CliError("Turnstile completion request is too large.");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function parseTurnstileCompletionBody(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new CliError("Turnstile completion request is invalid.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError("Turnstile completion request is invalid.");
  }
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !("token" in record)) {
    throw new CliError("Turnstile completion request is invalid.");
  }
  return normalizeTurnstileToken(record.token);
}

function writeResponse(
  response: ServerResponse,
  status: number,
  body: string,
  contentType = "application/json; charset=utf-8",
  scriptNonce?: string,
): void {
  const headers: Record<string, string> = {
    "Cache-Control": "no-store",
    "Content-Type": contentType,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
  if (scriptNonce) {
    headers["Content-Security-Policy"] = [
      "default-src 'none'",
      `script-src 'nonce-${scriptNonce}' https://challenges.cloudflare.com`,
      "frame-src https://challenges.cloudflare.com",
      "connect-src 'self' https://challenges.cloudflare.com",
      "style-src 'unsafe-inline'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join("; ");
  }
  response.writeHead(status, headers);
  response.end(body);
}

async function openUrl(url: string): Promise<void> {
  const command = process.platform === "darwin"
    ? { file: "open", args: [url] }
    : process.platform === "win32"
    ? { file: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] }
    : { file: "xdg-open", args: [url] };

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.file, command.args, {
      detached: true,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

export async function requestTurnstileToken(options: {
  siteKey?: string;
  action?: string;
  openBrowser?: boolean;
  timeoutMs?: number;
  status?: (message: string) => void;
} = {}): Promise<string> {
  const siteKey = assertSiteKey(
    options.siteKey ||
      process.env.STATIC_STUDIO_TURNSTILE_SITE_KEY ||
      DEFAULT_TURNSTILE_SITE_KEY,
  );
  const action = assertAction(options.action || "studio_login");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 10 * 60 * 1_000) {
    throw new CliError("Turnstile timeout is invalid.");
  }
  const status = options.status || ((message: string) => process.stderr.write(`${message}\n`));
  const pathNonce = randomBytes(24).toString("hex");
  const scriptNonce = randomBytes(18).toString("base64");
  const challengePath = `/${pathNonce}`;
  const completionPath = `${challengePath}/complete`;
  let resolveToken!: (token: string) => void;
  let rejectToken!: (error: Error) => void;
  const tokenPromise = new Promise<string>((resolve, reject) => {
    resolveToken = resolve;
    rejectToken = reject;
  });

  const server = createServer((request, response) => {
    void (async () => {
      const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
      if (request.method === "GET" && pathname === challengePath) {
        writeResponse(
          response,
          200,
          createTurnstileChallengeHtml({
            siteKey,
            action,
            completionPath,
            scriptNonce,
          }),
          "text/html; charset=utf-8",
          scriptNonce,
        );
        return;
      }
      if (request.method === "POST" && pathname === completionPath) {
        try {
          if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
            throw new CliError("Turnstile completion request must be JSON.");
          }
          const token = parseTurnstileCompletionBody(await readBody(request));
          writeResponse(response, 200, JSON.stringify({ ok: true }));
          resolveToken(token);
        } catch (error) {
          writeResponse(
            response,
            error instanceof CliError && error.message.includes("too large") ? 413 : 400,
            JSON.stringify({ error: "Invalid security-check response." }),
          );
        }
        return;
      }
      if (request.method === "GET" && pathname === "/favicon.ico") {
        writeResponse(response, 204, "", "text/plain; charset=utf-8");
        return;
      }
      writeResponse(response, 404, JSON.stringify({ error: "Not found" }));
    })().catch(() => {
      if (!response.headersSent) {
        writeResponse(response, 500, JSON.stringify({ error: "Security check failed." }));
      } else {
        response.end();
      }
    });
  });
  const handleServerError = (error: Error) => {
    rejectToken(new CliError(`Could not run the local Turnstile callback: ${error.message}`));
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", onError);
        resolve();
      });
    });
    server.on("error", handleServerError);
    const address = server.address() as AddressInfo | null;
    if (!address || typeof address.port !== "number") {
      throw new CliError("Could not determine the local Turnstile callback address.");
    }
    const url = `http://127.0.0.1:${address.port}${challengePath}`;
    let opened = false;
    if (options.openBrowser !== false) {
      try {
        await openUrl(url);
        opened = true;
      } catch {
        opened = false;
      }
    }
    status(opened
      ? `Complete the Static Studio security check in your browser. If it did not open, use:\n${url}`
      : `Open this URL to complete the Static Studio security check:\n${url}`);

    const timeout = setTimeout(() => {
      rejectToken(new CliError("The Static Studio security check timed out. Run login again."));
    }, timeoutMs);
    try {
      return await tokenPromise;
    } finally {
      clearTimeout(timeout);
    }
  } finally {
    server.off("error", handleServerError);
    await closeServer(server);
  }
}

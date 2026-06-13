import { lookup } from "node:dns/promises";
import { writeFile } from "node:fs/promises";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CliError } from "./errors.js";
import { getSiteMeta } from "./sites.js";
import { assertSafeId, parsePositiveInteger, requireAllowedValue } from "./validation.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const LOG_LEVELS = ["all", "error", "warning", "notice", "info"] as const;

export type DebugLogLevel = (typeof LOG_LEVELS)[number];

export interface DebugLogOptions {
  tail?: number;
  level?: string;
  search?: string;
  newestFirst?: boolean;
  outputFile?: string;
  overwriteOutput?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
  allowInsecureHttp?: boolean;
  allowPrivateNetwork?: boolean;
}

export interface DebugLogResult {
  siteId: string;
  endpoint: string;
  bytes: number;
  totalLines: number;
  returnedLines: number;
  truncated: boolean;
  log: string;
}

export function wpBaseUrlFromAdminUrl(adminUrl: string): URL {
  const url = new URL(adminUrl);
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/wp\/wp-admin\/?$/i, "/wp").replace(/\/wp-admin\/?$/i, "");
  if (!url.pathname) url.pathname = "/";
  return url;
}

function debugLogEndpoint(adminUrl: string): URL {
  const url = wpBaseUrlFromAdminUrl(adminUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/wp-json/static-studio/v1/debug-log`;
  return url;
}

function isPrivateIPv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a = 0, b = 0] = parts;
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    a === 0
  );
}

function isPrivateIPv6(address: string): boolean {
  const normalized = address.toLowerCase();
  return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
}

async function assertSafeFetchUrl(url: URL, options: DebugLogOptions): Promise<void> {
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new CliError("Debug log URL must use HTTP or HTTPS.");
  }
  if (url.protocol === "http:" && !options.allowInsecureHttp) {
    throw new CliError("Refusing to fetch debug logs over HTTP. Use --allow-insecure-http only for trusted local testing.");
  }

  if (options.allowPrivateNetwork) return;

  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new CliError("Refusing to fetch debug logs from a local hostname.");
  }

  const addresses = await lookup(hostname, { all: true });
  if (
    addresses.some((entry) =>
      entry.family === 4 ? isPrivateIPv4(entry.address) : isPrivateIPv6(entry.address),
    )
  ) {
    throw new CliError("Refusing to fetch debug logs from a private network address.");
  }
}

function logLevel(line: string): Exclude<DebugLogLevel, "all"> | "default" {
  const lower = line.toLowerCase();
  if (lower.includes("fatal error") || lower.includes("php fatal") || lower.includes("error:") || lower.includes("php error")) {
    return "error";
  }
  if (lower.includes("warning") || lower.includes("php warning")) {
    return "warning";
  }
  if (lower.includes("notice") || lower.includes("php notice") || lower.includes("deprecated")) {
    return "notice";
  }
  if (lower.includes("info") || lower.includes("debug")) {
    return "info";
  }
  return "default";
}

function normalizeLogPayload(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    for (const key of ["data", "log", "content"]) {
      const value = record[key];
      if (typeof value === "string") return value;
      if (Array.isArray(value)) return value.map(String).join("\n");
    }
  }
  return JSON.stringify(payload, null, 2);
}

async function readResponseWithLimit(response: Response, maxBytes: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new CliError(`Debug log response is too large. Maximum allowed size is ${maxBytes} bytes.`);
  }

  if (!response.body) {
    const text = await response.text();
    return { text, bytes: Buffer.byteLength(text), truncated: false };
  }

  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const reader = response.body.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new CliError(`Debug log response is too large. Maximum allowed size is ${maxBytes} bytes.`);
    }
    chunks.push(value);
  }

  return {
    text: Buffer.concat(chunks).toString("utf8"),
    bytes,
    truncated: false,
  };
}

function processLog(log: string, options: DebugLogOptions): { log: string; totalLines: number; returnedLines: number } {
  const level = requireAllowedValue((options.level || "all").toLowerCase(), LOG_LEVELS, "Log level");
  const search = options.search?.trim().toLowerCase();
  let lines = log.split("\n");
  const totalLines = lines.length;

  if (level !== "all") {
    lines = lines.filter((line) => logLevel(line) === level);
  }
  if (search) {
    lines = lines.filter((line) => line.toLowerCase().includes(search));
  }
  if (options.newestFirst) {
    lines.reverse();
  }
  if (options.tail !== undefined) {
    const tail = parsePositiveInteger(options.tail, "tail", { min: 1, max: 10_000 });
    lines = lines.slice(-tail);
  }

  return {
    log: lines.join("\n"),
    totalLines,
    returnedLines: lines.length,
  };
}

export async function getDebugLog(
  supabase: SupabaseClient,
  siteId: string,
  options: DebugLogOptions = {},
): Promise<DebugLogResult> {
  const safeSiteId = assertSafeId(siteId, "siteId");
  const meta = await getSiteMeta(supabase, safeSiteId);
  if (!meta.admin_url || !meta.secret_key) {
    throw new CliError("Site metadata is missing admin_url or secret_key.");
  }

  const endpoint = debugLogEndpoint(meta.admin_url);
  await assertSafeFetchUrl(endpoint, options);

  const timeoutMs = parsePositiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeout", {
    min: 1_000,
    max: 120_000,
  });
  const maxBytes = parsePositiveInteger(options.maxBytes ?? DEFAULT_MAX_BYTES, "max bytes", {
    min: 1_024,
    max: 20 * 1024 * 1024,
  });

  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      "X-Secret-Key": meta.secret_key,
      Accept: "application/json, text/plain;q=0.9, */*;q=0.8",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new CliError(`Failed to fetch debug log: ${response.status} ${response.statusText}`);
  }

  const raw = await readResponseWithLimit(response, maxBytes);
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json") ? JSON.parse(raw.text) : raw.text;
  const processed = processLog(normalizeLogPayload(payload), options);

  const result = {
    siteId: safeSiteId,
    endpoint: endpoint.toString(),
    bytes: raw.bytes,
    totalLines: processed.totalLines,
    returnedLines: processed.returnedLines,
    truncated: raw.truncated,
    log: processed.log,
  };

  if (options.outputFile) {
    try {
      await writeFile(options.outputFile, `${result.log}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: options.overwriteOutput ? "w" : "wx",
      });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
        throw new CliError("Output file already exists. Use --overwrite to replace it.");
      }
      throw error;
    }
  }

  return result;
}

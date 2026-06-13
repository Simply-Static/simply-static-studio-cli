import { stat } from "node:fs/promises";
import { CliError } from "./errors.js";

const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

export function assertSafeId(value: string, label = "ID"): string {
  const clean = String(value || "").trim();
  if (!SAFE_ID_RE.test(clean)) {
    throw new CliError(`${label} must contain only letters, numbers, underscores, and hyphens.`);
  }
  return clean;
}

export function parsePositiveInteger(
  value: unknown,
  label: string,
  options: { min?: number; max?: number } = {},
): number {
  const min = options.min ?? 1;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new CliError(`${label} must be an integer between ${min} and ${max}.`);
  }
  return number;
}

export function sanitizeSearchTerm(value: string | undefined, label = "search"): string | undefined {
  if (value === undefined) return undefined;
  const clean = value.trim();
  if (!clean) return undefined;
  if (clean.length > 120) {
    throw new CliError(`${label} must be 120 characters or fewer.`);
  }
  if (CONTROL_CHARS_RE.test(clean) || /[(),]/.test(clean)) {
    throw new CliError(`${label} contains unsupported characters.`);
  }
  return clean;
}

export function requireAllowedValue<T extends string>(
  value: string,
  allowed: readonly T[],
  label: string,
): T {
  if (!allowed.includes(value as T)) {
    throw new CliError(`${label} must be one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

export function normalizeEmail(value: string): string {
  const email = String(value || "").trim().toLowerCase();
  if (email.length > 254 || CONTROL_CHARS_RE.test(email) || !EMAIL_RE.test(email)) {
    throw new CliError(`Invalid email address: ${value}`);
  }
  return email;
}

export function normalizeEmailList(values: string[], options: { max?: number } = {}): string[] {
  const max = options.max ?? 100;
  const seen = new Set<string>();
  for (const value of values) {
    const email = normalizeEmail(value);
    seen.add(email);
  }
  if (seen.size === 0) {
    throw new CliError("Provide at least one email address.");
  }
  if (seen.size > max) {
    throw new CliError(`Email list cannot contain more than ${max} unique addresses.`);
  }
  return [...seen];
}

export function normalizeHexColor(value: string): string {
  const color = String(value || "").trim();
  if (!HEX_COLOR_RE.test(color)) {
    throw new CliError("Color must be a six-digit hex value, for example #3858E9.");
  }
  return color.toUpperCase();
}

export function normalizeTagName(value: string): string {
  const name = String(value || "").trim();
  if (!name || name.length > 80 || CONTROL_CHARS_RE.test(name)) {
    throw new CliError("Tag name must be between 1 and 80 printable characters.");
  }
  return name;
}

export function normalizeEnvironmentTitle(value: string): string {
  const title = String(value || "").trim();
  if (!title || title.length > 64 || CONTROL_CHARS_RE.test(title)) {
    throw new CliError("Environment name must be between 1 and 64 printable characters.");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(title)) {
    throw new CliError("Environment name may only contain letters, numbers, spaces, dots, underscores, and hyphens.");
  }
  const slug = environmentSlug(title);
  if (!slug) {
    throw new CliError("Environment name must include at least one letter or number.");
  }
  if (slug === "production") {
    throw new CliError("The production environment name is reserved.");
  }
  return title;
}

export function environmentSlug(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export async function assertReadableFileWithinLimit(
  filePath: string,
  maxBytes: number,
): Promise<void> {
  const info = await stat(filePath);
  if (!info.isFile()) {
    throw new CliError(`${filePath} is not a file.`);
  }
  if (info.size > maxBytes) {
    throw new CliError(`${filePath} is too large. Maximum allowed size is ${maxBytes} bytes.`);
  }
}

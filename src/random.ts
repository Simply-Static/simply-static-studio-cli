import { createHash, randomBytes } from "node:crypto";

const ALPHA_LOWER = "abcdefghijklmnopqrstuvwxyz";
const ALPHANUMERIC_LOWER = "abcdefghijklmnopqrstuvwxyz0123456789";
const PASSWORD_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*";

export function randomFromCharset(length: number, charset: string): string {
  const bytes = randomBytes(length);
  return Array.from(bytes, (byte) => charset[byte % charset.length]).join("");
}

export function randomAlpha(length: number): string {
  return randomFromCharset(length, ALPHA_LOWER);
}

export function randomAlphanumeric(length: number): string {
  return randomFromCharset(length, ALPHANUMERIC_LOWER);
}

export function randomPassword(length = 16): string {
  return randomFromCharset(length, PASSWORD_CHARS);
}

export function randomUsername(length = 10): string {
  return randomAlpha(1) + randomAlphanumeric(length - 1);
}

export function randomDomainWord(): string {
  const length = 6 + ((randomBytes(1)[0] ?? 0) % 5);
  return randomAlpha(length);
}

export function md5(value: string): string {
  return createHash("md5").update(value).digest("hex");
}

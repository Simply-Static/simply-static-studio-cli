import { describe, expect, it } from "vitest";
import { CliError } from "./errors.js";
import {
  normalizeEmailList,
  normalizeEnvironmentTitle,
  normalizeHexColor,
  parsePositiveInteger,
  sanitizeSearchTerm,
} from "./validation.js";

describe("validation helpers", () => {
  it("parses bounded positive integers", () => {
    expect(parsePositiveInteger("10", "limit", { min: 1, max: 20 })).toBe(10);
    expect(() => parsePositiveInteger("0", "limit", { min: 1 })).toThrow(CliError);
    expect(() => parsePositiveInteger("abc", "limit")).toThrow(CliError);
  });

  it("normalizes and deduplicates email lists", () => {
    expect(normalizeEmailList(["USER@example.com", "user@example.com"])).toEqual(["user@example.com"]);
    expect(() => normalizeEmailList(["not-an-email"])).toThrow(CliError);
  });

  it("keeps PostgREST search terms in a safe subset", () => {
    expect(sanitizeSearchTerm(" Demo ")).toBe("Demo");
    expect(() => sanitizeSearchTerm("demo),id.eq.1")).toThrow(CliError);
  });

  it("validates environment names and colors", () => {
    expect(normalizeEnvironmentTitle("Staging 1")).toBe("Staging 1");
    expect(() => normalizeEnvironmentTitle("production")).toThrow(CliError);
    expect(normalizeHexColor("#3858e9")).toBe("#3858E9");
    expect(() => normalizeHexColor("blue")).toThrow(CliError);
  });
});

import { inspect } from "node:util";
import type { CliOutputOptions } from "./types.js";

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function printValue(value: unknown, options: CliOutputOptions = {}): void {
  if (options.json) {
    printJson(value);
    return;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      process.stdout.write("No results.\n");
      return;
    }
    console.table(value);
    return;
  }

  if (typeof value === "string") {
    process.stdout.write(`${value}\n`);
    return;
  }

  process.stdout.write(
    `${inspect(value, { colors: process.stdout.isTTY, depth: 8, compact: false })}\n`,
  );
}

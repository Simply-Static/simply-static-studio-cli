import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { CliError } from "./errors.js";
import { getMigrationObjectInfo } from "./upload.js";

describe("getMigrationObjectInfo", () => {
  it("creates the expected storage object for backup ZIPs", () => {
    const filePath = join(tmpdir(), `demo-studio-backup-${Date.now()}.zip`);
    writeFileSync(filePath, "zip");

    expect(getMigrationObjectInfo(filePath, "abc123")).toMatchObject({
      bucket: "site_migrations",
      key: "public/site-migration-abc123.zip",
      contentType: "application/zip",
      size: 3,
    });
  });

  it("rejects arbitrary ZIP names by default", () => {
    const filePath = join(tmpdir(), `demo-${Date.now()}.zip`);
    writeFileSync(filePath, "zip");

    expect(() => getMigrationObjectInfo(filePath, "abc123")).toThrow(CliError);
  });
});

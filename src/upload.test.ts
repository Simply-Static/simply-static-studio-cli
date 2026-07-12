import {
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliError } from "./errors.js";
import { getMigrationObjectInfo, uploadMigrationFile } from "./upload.js";

const PART_SIZE = 25 * 1024 * 1024;

type InvokeBody = Record<string, any>;

function protocolClient(
  handler: (body: InvokeBody) => unknown | Promise<unknown>,
): { supabase: any; bodies: InvokeBody[] } {
  const bodies: InvokeBody[] = [];
  return {
    bodies,
    supabase: {
      functions: {
        async invoke(name: string, options: { body?: InvokeBody } = {}) {
          expect(name).toBe("get-upload-credentials");
          const body = options.body || {};
          bodies.push(body);
          return { data: await handler(body), error: null };
        },
      },
    },
  };
}

describe("migration uploads", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "static-studio-upload-"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  function file(name: string, size: number): string {
    const path = join(directory, name);
    const descriptor = openSync(path, "w");
    closeSync(descriptor);
    truncateSync(path, size);
    return path;
  }

  describe("getMigrationObjectInfo", () => {
    it("creates the expected storage object for supported archives", () => {
      const zip = file("demo-studio-backup-1.zip", 3);
      const tgz = file("demo.tgz", 7);

      expect(getMigrationObjectInfo(zip, "abc123")).toEqual({
        bucket: "site_migrations",
        key: "public/site-migration-abc123.zip",
        contentType: "application/zip",
        size: 3,
      });
      expect(getMigrationObjectInfo(tgz, "demo-site")).toEqual({
        bucket: "site_migrations",
        key: "public/site-migration-demo-site.tar.gz",
        contentType: "application/gzip",
        size: 7,
      });
    });

    it("validates filenames, subdomains, and non-empty files", () => {
      const arbitraryZip = file("demo.zip", 3);
      const emptyZip = file("empty-studio-backup-1.zip", 0);

      expect(() => getMigrationObjectInfo(arbitraryZip, "abc123")).toThrow(CliError);
      expect(() => getMigrationObjectInfo(arbitraryZip, "abc123", true)).not.toThrow();
      expect(() => getMigrationObjectInfo(arbitraryZip, "UPPER", true)).toThrow(/subdomain/i);
      expect(() => getMigrationObjectInfo(emptyZip, "abc123")).toThrow(/empty/i);
    });
  });

  it("uploads signed parts with bounded concurrency and completes with sorted ETags", async () => {
    const filePath = file("demo-studio-backup-1.zip", PART_SIZE + 3);
    const progress: Array<{ loaded: number; total?: number }> = [];
    let activeUploads = 0;
    let maxActiveUploads = 0;
    const uploaded: Array<{ partNumber: number; bytes: number }> = [];
    let releaseUploads!: () => void;
    const bothUploadsStarted = new Promise<void>((resolve) => {
      releaseUploads = resolve;
    });

    const { supabase, bodies } = protocolClient((body) => {
      if (body.action === "init") return { token: "upload-token", partCount: 2 };
      if (body.action === "sign_parts") {
        return {
          urls: body.partNumbers.map((partNumber: number) => ({
            partNumber,
            url: `https://uploads.example.test/${partNumber}`,
          })),
        };
      }
      if (body.action === "complete") return { ok: true, key: body.key };
      if (body.action === "abort") return { ok: true };
      throw new Error(`Unexpected action: ${body.action}`);
    });

    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      activeUploads += 1;
      maxActiveUploads = Math.max(maxActiveUploads, activeUploads);
      if (activeUploads === 2) releaseUploads();
      await bothUploadsStarted;
      const partNumber = Number(new URL(String(input)).pathname.slice(1));
      uploaded.push({
        partNumber,
        bytes: (init?.body as Buffer).byteLength,
      });
      activeUploads -= 1;
      return new Response(null, {
        status: 200,
        headers: { etag: `"etag-${partNumber}"` },
      });
    });

    await expect(
      uploadMigrationFile(supabase, {
        filePath,
        subdomain: "abc123",
        onProgress: (value) => progress.push(value),
      }),
    ).resolves.toEqual({
      bucket: "site_migrations",
      key: "public/site-migration-abc123.zip",
      size: PART_SIZE + 3,
    });

    expect(bodies[0]).toEqual({
      action: "init",
      bucket: "site_migrations",
      key: "public/site-migration-abc123.zip",
      contentType: "application/zip",
      fileSize: PART_SIZE + 3,
      partSize: PART_SIZE,
    });
    expect(bodies[1]).toEqual({
      action: "sign_parts",
      token: "upload-token",
      partNumbers: [1, 2],
    });
    expect(bodies[1]?.partNumbers.length).toBeLessThanOrEqual(10);
    expect(bodies[2]).toEqual({
      action: "complete",
      token: "upload-token",
      parts: [
        { partNumber: 1, etag: '"etag-1"' },
        { partNumber: 2, etag: '"etag-2"' },
      ],
    });
    expect(uploaded.sort((a, b) => a.partNumber - b.partNumber)).toEqual([
      { partNumber: 1, bytes: PART_SIZE },
      { partNumber: 2, bytes: 3 },
    ]);
    expect(maxActiveUploads).toBe(2);
    expect(progress).toHaveLength(2);
    expect(progress.at(-1)).toEqual({ loaded: PART_SIZE + 3, total: PART_SIZE + 3 });
  });

  it("retries a failed part without double-counting progress", async () => {
    const filePath = join(directory, "retry-studio-backup-1.zip");
    writeFileSync(filePath, "zip");
    let fetchAttempts = 0;
    const progress: number[] = [];
    const { supabase, bodies } = protocolClient((body) => {
      if (body.action === "init") return { token: "retry-token", partCount: 1 };
      if (body.action === "sign_parts") {
        return { urls: [{ partNumber: 1, url: "https://uploads.example.test/1" }] };
      }
      if (body.action === "complete") return { ok: true };
      if (body.action === "abort") return { ok: true };
      throw new Error(`Unexpected action: ${body.action}`);
    });

    vi.stubGlobal("fetch", async () => {
      fetchAttempts += 1;
      return fetchAttempts === 1
        ? new Response("temporary", { status: 503 })
        : new Response(null, { status: 200, headers: { etag: "retry-etag" } });
    });

    await uploadMigrationFile(supabase, {
      filePath,
      subdomain: "retry",
      onProgress: ({ loaded }) => progress.push(loaded),
    });

    expect(fetchAttempts).toBe(2);
    expect(progress).toEqual([3]);
    expect(bodies.map((body) => body.action)).toEqual(["init", "sign_parts", "complete"]);
  });

  it("best-effort aborts when completion fails", async () => {
    const filePath = join(directory, "abort-studio-backup-1.zip");
    writeFileSync(filePath, "zip");
    const { supabase, bodies } = protocolClient((body) => {
      if (body.action === "init") return { token: "abort-token", partCount: 1 };
      if (body.action === "sign_parts") {
        return { urls: [{ partNumber: 1, url: "https://uploads.example.test/1" }] };
      }
      if (body.action === "complete") return { error: "Could not complete upload" };
      if (body.action === "abort") return { ok: true };
      throw new Error(`Unexpected action: ${body.action}`);
    });
    vi.stubGlobal("fetch", async () =>
      new Response(null, { status: 200, headers: { etag: "abort-etag" } })
    );

    await expect(
      uploadMigrationFile(supabase, { filePath, subdomain: "abort" }),
    ).rejects.toThrow("Could not complete upload");
    expect(bodies.map((body) => body.action)).toEqual([
      "init",
      "sign_parts",
      "complete",
      "abort",
    ]);
  });

  it("rejects non-HTTPS signed upload URLs and aborts", async () => {
    const filePath = join(directory, "secure-studio-backup-1.zip");
    writeFileSync(filePath, "zip");
    const { supabase, bodies } = protocolClient((body) => {
      if (body.action === "init") return { token: "secure-token", partCount: 1 };
      if (body.action === "sign_parts") {
        return { urls: [{ partNumber: 1, url: "http://uploads.example.test/1" }] };
      }
      if (body.action === "abort") return { ok: true };
      throw new Error(`Unexpected action: ${body.action}`);
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(uploadMigrationFile(supabase, { filePath, subdomain: "secure" }))
      .rejects.toThrow("invalid signed part data");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(bodies.map((body) => body.action)).toEqual(["init", "sign_parts", "abort"]);
  });
});

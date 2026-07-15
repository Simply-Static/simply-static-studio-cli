import { basename } from "node:path";
import { statSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CliError } from "./errors.js";
import { invokeFunction } from "./supabase.js";

const MAX_UPLOAD_SIZE = 10 * 1024 * 1024 * 1024;
const DEFAULT_PART_SIZE = 25 * 1024 * 1024;
const UPLOAD_CONCURRENCY = 2;
const SIGN_BATCH_SIZE = 10;
const MAX_UPLOAD_ATTEMPTS = 5;
const RETRY_DELAY_MS = 200;
const SUBDOMAIN_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

type MigrationObjectInfo = {
  bucket: string;
  key: string;
  contentType: string;
  size: number;
};

type SignedPart = {
  partNumber: number;
  url: string;
};

type CompletedPart = {
  partNumber: number;
  etag: string;
};

export interface UploadMigrationOptions {
  filePath: string;
  subdomain?: string;
  newSite?: boolean;
  allowAnyZipName?: boolean;
  onProgress?: (progress: { loaded: number; total?: number }) => void;
}

export function getMigrationObjectInfo(
  filePath: string,
  subdomain: string,
  allowAnyZipName = false,
): MigrationObjectInfo {
  const cleanSubdomain = String(subdomain || "").trim();
  if (!SUBDOMAIN_RE.test(cleanSubdomain)) {
    throw new CliError(
      "Migration subdomain must be 1-63 lowercase letters, numbers, or hyphens and start with a letter or number.",
    );
  }

  const fileName = basename(filePath).toLowerCase();
  const isTarGz = fileName.endsWith(".tar.gz") || fileName.endsWith(".tgz");
  const isZip = fileName.endsWith(".zip");
  if (!isTarGz && !isZip) {
    throw new CliError("Migration files must end in .zip, .tar.gz, or .tgz.");
  }
  if (isZip && !allowAnyZipName && !fileName.includes("studio-backup-")) {
    throw new CliError(
      "ZIP migration files must be exported by Static Studio Backup and Migrate and include `studio-backup-` in the filename.",
    );
  }

  let info;
  try {
    info = statSync(filePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`Could not read migration file: ${message}`);
  }
  if (!info.isFile()) {
    throw new CliError("The selected migration path must be a file.");
  }
  if (info.size <= 0) {
    throw new CliError("The selected migration file is empty.");
  }
  if (info.size > MAX_UPLOAD_SIZE) {
    throw new CliError("The selected file exceeds the 10 GB migration upload limit.");
  }

  const extension = isTarGz ? ".tar.gz" : ".zip";
  return {
    bucket: "site_migrations",
    key: `public/site-migration-${cleanSubdomain}${extension}`,
    contentType: isTarGz ? "application/gzip" : "application/zip",
    size: info.size,
  };
}

async function invokeUploadAction<T>(
  supabase: SupabaseClient,
  body: Record<string, unknown>,
): Promise<T> {
  return invokeFunction<T>(supabase, "get-upload-credentials", body);
}

async function readPart(
  file: FileHandle,
  partNumber: number,
  fileSize: number,
): Promise<Buffer> {
  const position = (partNumber - 1) * DEFAULT_PART_SIZE;
  const length = Math.min(DEFAULT_PART_SIZE, fileSize - position);
  if (length <= 0) {
    throw new CliError(`Upload part ${partNumber} is outside the migration file.`);
  }

  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await file.read(
      buffer,
      offset,
      length - offset,
      position + offset,
    );
    if (bytesRead === 0) {
      throw new CliError("The migration file changed while it was being uploaded.");
    }
    offset += bytesRead;
  }
  return buffer;
}

function retryDelay(attempt: number): Promise<void> {
  const delay = Math.min(RETRY_DELAY_MS * 2 ** Math.max(0, attempt - 1), 2_000);
  return new Promise((resolve) => setTimeout(resolve, delay));
}

async function uploadPart(
  file: FileHandle,
  signedPart: SignedPart,
  fileSize: number,
): Promise<CompletedPart> {
  const body = await readPart(file, signedPart.partNumber, fileSize);
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(signedPart.url, {
        method: "PUT",
        body,
        redirect: "error",
      });
      if (!response.ok) {
        const details = (await response.text().catch(() => "")).slice(0, 300);
        throw new Error(
          `HTTP ${response.status}${details ? `: ${details}` : ""}`,
        );
      }

      const etag = response.headers.get("etag")?.trim();
      if (!etag) {
        throw new Error("storage did not return an ETag");
      }
      return { partNumber: signedPart.partNumber, etag };
    } catch (error) {
      lastError = error;
      if (attempt < MAX_UPLOAD_ATTEMPTS) {
        await retryDelay(attempt);
      }
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new CliError(
    `Upload part ${signedPart.partNumber} failed after ${MAX_UPLOAD_ATTEMPTS} attempts: ${message}`,
  );
}

function validateSignedParts(
  value: unknown,
  requestedPartNumbers: number[],
): SignedPart[] {
  if (!Array.isArray(value) || value.length !== requestedPartNumbers.length) {
    throw new CliError("Could not sign all multipart upload chunks.");
  }

  const requested = new Set(requestedPartNumbers);
  const seen = new Set<number>();
  const parts = value.map((entry) => {
    const record = entry as { partNumber?: unknown; url?: unknown };
    const partNumber = Number(record?.partNumber);
    const url = typeof record?.url === "string" ? record.url : "";
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new CliError("Upload service returned an invalid signed URL.");
    }
    if (
      !Number.isInteger(partNumber) ||
      !requested.has(partNumber) ||
      seen.has(partNumber) ||
      parsedUrl.protocol !== "https:"
    ) {
      throw new CliError("Upload service returned invalid signed part data.");
    }
    seen.add(partNumber);
    // Preserve the signed URL byte-for-byte; re-serializing it can invalidate
    // provider signatures even when the parsed URL is semantically equivalent.
    return { partNumber, url };
  });

  return parts.sort((a, b) => a.partNumber - b.partNumber);
}

async function uploadSignedBatch(
  file: FileHandle,
  signedParts: SignedPart[],
  fileSize: number,
  onPartComplete: (part: CompletedPart) => void,
): Promise<void> {
  let cursor = 0;
  let failed = false;
  let firstError: unknown;

  const workers = Array.from(
    { length: Math.min(UPLOAD_CONCURRENCY, signedParts.length) },
    async () => {
      while (!failed) {
        const index = cursor;
        cursor += 1;
        const signedPart = signedParts[index];
        if (!signedPart) return;

        try {
          onPartComplete(await uploadPart(file, signedPart, fileSize));
        } catch (error) {
          if (!failed) firstError = error;
          failed = true;
        }
      }
    },
  );

  await Promise.all(workers);
  if (failed) throw firstError;
}

export async function uploadMigrationFile(
  supabase: SupabaseClient,
  options: UploadMigrationOptions,
): Promise<{
  bucket: string;
  key: string;
  size: number;
  migrationToken?: string;
  siteIdentifier?: string;
}> {
  const object = getMigrationObjectInfo(
    options.filePath,
    options.newSite ? "pending" : String(options.subdomain || ""),
    options.allowAnyZipName,
  );
  const partCount = Math.ceil(object.size / DEFAULT_PART_SIZE);
  let uploadToken: string | undefined;
  let file: FileHandle | undefined;

  try {
    file = await open(options.filePath, "r");
    const openedInfo = await file.stat();
    if (!openedInfo.isFile() || openedInfo.size !== object.size) {
      throw new CliError("The migration file changed before the upload started.");
    }

    const initialized = await invokeUploadAction<{
      token?: unknown;
      partCount?: unknown;
      key?: unknown;
      siteIdentifier?: unknown;
    }>(supabase, {
      action: "init",
      bucket: object.bucket,
      key: object.key,
      contentType: object.contentType,
      fileSize: object.size,
      partSize: DEFAULT_PART_SIZE,
      ...(options.newSite ? { purpose: "new_site" } : {}),
    });

    if (typeof initialized?.token === "string" && initialized.token) {
      uploadToken = initialized.token;
    }
    if (!uploadToken || Number(initialized.partCount) !== partCount) {
      throw new CliError("Could not initialize multipart migration upload.");
    }
    const resolvedKey = typeof initialized.key === "string" ? initialized.key : object.key;
    if (!/^public\/site-migration-[a-z0-9][a-z0-9-]{0,62}\.(?:zip|tar\.gz)$/.test(resolvedKey)) {
      throw new CliError("Upload service returned an invalid migration object key.");
    }
    const siteIdentifier = typeof initialized.siteIdentifier === "string"
      ? initialized.siteIdentifier
      : undefined;
    if (options.newSite && !/^[a-z]{2}[a-z0-9]{13}$/.test(siteIdentifier || "")) {
      throw new CliError("Upload service did not return a valid site identifier.");
    }

    const completedParts: CompletedPart[] = [];
    let loaded = 0;
    for (let first = 1; first <= partCount; first += SIGN_BATCH_SIZE) {
      const requestedPartNumbers = Array.from(
        { length: Math.min(SIGN_BATCH_SIZE, partCount - first + 1) },
        (_, index) => first + index,
      );
      const signed = await invokeUploadAction<{ urls?: unknown }>(supabase, {
        action: "sign_parts",
        token: uploadToken,
        partNumbers: requestedPartNumbers,
      });
      const signedParts = validateSignedParts(signed?.urls, requestedPartNumbers);

      await uploadSignedBatch(file, signedParts, object.size, (completed) => {
        completedParts.push(completed);
        const start = (completed.partNumber - 1) * DEFAULT_PART_SIZE;
        loaded += Math.min(DEFAULT_PART_SIZE, object.size - start);
        try {
          options.onProgress?.({ loaded, total: object.size });
        } catch {
          // Progress reporting must never interrupt an otherwise valid upload.
        }
      });
    }

    completedParts.sort((a, b) => a.partNumber - b.partNumber);
    const completed = await invokeUploadAction<{
      ok?: unknown;
      key?: unknown;
      migrationToken?: unknown;
      siteIdentifier?: unknown;
    }>(supabase, {
      action: "complete",
      token: uploadToken,
      parts: completedParts,
    });
    if (completed?.ok !== true) {
      throw new CliError("Storage did not confirm the completed migration upload.");
    }
    const completedKey = typeof completed.key === "string" ? completed.key : resolvedKey;
    if (completedKey !== resolvedKey) {
      throw new CliError("Upload service returned inconsistent migration object keys.");
    }
    const migrationToken = typeof completed.migrationToken === "string"
      ? completed.migrationToken
      : undefined;
    if (options.newSite && !migrationToken) {
      throw new CliError("Upload service did not return a signed site creation token.");
    }

    return {
      bucket: object.bucket,
      key: completedKey,
      size: object.size,
      ...(migrationToken ? { migrationToken } : {}),
      ...(siteIdentifier ? { siteIdentifier } : {}),
    };
  } catch (error) {
    if (uploadToken) {
      await invokeUploadAction(supabase, {
        action: "abort",
        token: uploadToken,
      }).catch(() => undefined);
    }
    throw error;
  } finally {
    await file?.close().catch(() => undefined);
  }
}

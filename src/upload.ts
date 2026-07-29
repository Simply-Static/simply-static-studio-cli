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
const PLATFORM_COMPLETION_ATTEMPTS = 8;
const PLATFORM_FINALIZATION_POLL_MS = 2_000;
const PLATFORM_FINALIZATION_POLLS = 300;
const PLATFORM_COMPLETION_FUNCTION = "complete-migration-upload";
const PLATFORM_MIGRATION_BUCKET = "platform_migrations";
const PLATFORM_STORAGE_ORIGIN =
  "https://yingqdimvkeqontaesxk.storage.supabase.co";
const SUBDOMAIN_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const PLATFORM_ARTIFACT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PLATFORM_ARTIFACT_KEY_RE =
  /^private\/platform-migrations\/([a-z]{2}[a-z0-9]{13})\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/source\.(?:zip|tar\.gz)$/;
const PLATFORM_COMPLETION_PATH_RE =
  /^\/storage\/v1\/s3\/platform_migrations\/private\/platform-migrations\/[a-z]{2}[a-z0-9]{13}\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/source\.(?:zip|tar\.gz)$/;

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
  functionName = "get-upload-credentials",
): Promise<T> {
  return invokeFunction<T>(supabase, functionName, body);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRetryablePlatformCompletionError(error: unknown): boolean {
  return error instanceof CliError &&
    error.deliveryAmbiguous === true &&
    error.code !== "platform_migration_artifact_key_conflict";
}

type PlatformCompletionRequest = {
  url: string;
  contentType: string;
  headers: {
    Authorization: string;
    "X-Amz-Content-Sha256": string;
    "X-Amz-Date": string;
  };
  body: string;
};

function validatePlatformCompletionRequest(
  value: unknown,
  artifactId: string,
): PlatformCompletionRequest {
  const result = value as {
    committed?: unknown;
    artifactId?: unknown;
    completionRequest?: {
      method?: unknown;
      url?: unknown;
      contentType?: unknown;
      headers?: Record<string, unknown>;
      body?: unknown;
      expiresAt?: unknown;
    };
  };
  const request = result?.completionRequest;
  const headers = request?.headers;
  let url: URL;
  try {
    url = new URL(String(request?.url || ""));
  } catch {
    throw new CliError(
      "Upload service returned an invalid Docker storage completion request.",
    );
  }
  const pathMatch = url.pathname.match(PLATFORM_COMPLETION_PATH_RE);
  const authorization = String(headers?.Authorization || "");
  const contentSha256 = String(headers?.["X-Amz-Content-Sha256"] || "");
  const signedDate = String(headers?.["X-Amz-Date"] || "");
  const body = typeof request?.body === "string" ? request.body : "";
  const expiresAt = Number(request?.expiresAt);
  const now = Math.floor(Date.now() / 1_000);
  if (
    result.committed !== false ||
    result.artifactId !== artifactId ||
    request?.method !== "POST" ||
    request?.contentType !== "application/xml" ||
    url.origin !== PLATFORM_STORAGE_ORIGIN ||
    Boolean(url.username || url.password || url.hash) ||
    pathMatch?.[1] !== artifactId ||
    !url.searchParams.get("uploadId") ||
    [...url.searchParams.keys()].some((key) => key !== "uploadId") ||
    !headers ||
    Object.keys(headers).length !== 3 ||
    !/^AWS4-HMAC-SHA256 Credential=[A-Za-z0-9_-]+\/[0-9]{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/
      .test(authorization) ||
    !/^[0-9a-f]{64}$/.test(contentSha256) ||
    !/^[0-9]{8}T[0-9]{6}Z$/.test(signedDate) ||
    !Number.isInteger(expiresAt) ||
    expiresAt <= now ||
    expiresAt > now + 15 * 60 ||
    body.length < 100 ||
    body.length > 256 * 1024 ||
    !body.startsWith('<?xml version="1.0" encoding="UTF-8"?>') ||
    !body.endsWith("</CompleteMultipartUpload>") ||
    /<!DOCTYPE|<!ENTITY/i.test(body)
  ) {
    throw new CliError(
      "Upload service returned an invalid Docker storage completion request.",
    );
  }
  return {
    url: url.toString(),
    contentType: request.contentType,
    headers: {
      Authorization: authorization,
      "X-Amz-Content-Sha256": contentSha256,
      "X-Amz-Date": signedDate,
    },
    body,
  };
}

async function dispatchPlatformCompletion(
  request: PlatformCompletionRequest,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(request.url, {
      method: "POST",
      headers: {
        "Content-Type": request.contentType,
        ...request.headers,
      },
      body: request.body,
      redirect: "error",
    });
  } catch (error) {
    throw new CliError(
      error instanceof Error
        ? `Docker storage completion was interrupted: ${error.message}`
        : "Docker storage completion was interrupted.",
      1,
      { deliveryAmbiguous: true },
    );
  }
  const responseBody = await response.text().catch(() => "");
  if (!response.ok) {
    const storageCode = responseBody.match(
      /<Code>([A-Za-z][A-Za-z0-9]{0,63})<\/Code>/,
    )?.[1];
    throw new CliError(
      `Docker storage completion returned HTTP ${response.status}${
        storageCode ? ` (${storageCode})` : ""
      }.`,
      1,
      { deliveryAmbiguous: true },
    );
  }
}

function committedPlatformCompletion(
  value: unknown,
  artifactId: string,
): Record<string, unknown> | null {
  const result = value as Record<string, unknown>;
  return result?.committed === true &&
      result.artifactId === artifactId &&
      ["pending", "finalizing", "ready", "failed"].includes(
        String(result.artifactStatus || ""),
      )
    ? result
    : null;
}

async function completePlatformUpload(
  supabase: SupabaseClient,
  artifactId: string,
): Promise<Record<string, unknown>> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= PLATFORM_COMPLETION_ATTEMPTS; attempt += 1) {
    try {
      let state = await invokeUploadAction<Record<string, unknown>>(
        supabase,
        { action: "complete_platform_direct", artifactId },
        PLATFORM_COMPLETION_FUNCTION,
      );
      const alreadyCommitted = committedPlatformCompletion(state, artifactId);
      if (alreadyCommitted) return alreadyCommitted;

      const request = validatePlatformCompletionRequest(state, artifactId);
      let storageError: unknown;
      try {
        await dispatchPlatformCompletion(request);
      } catch (error) {
        storageError = error;
      }

      state = await invokeUploadAction<Record<string, unknown>>(
        supabase,
        { action: "complete_platform_direct", artifactId },
        PLATFORM_COMPLETION_FUNCTION,
      );
      const committed = committedPlatformCompletion(state, artifactId);
      if (committed) return committed;
      validatePlatformCompletionRequest(state, artifactId);
      throw storageError ||
        new CliError("Docker storage completion is still pending.", 1, {
          deliveryAmbiguous: true,
        });
    } catch (error) {
      lastError = error;
      if (
        !isRetryablePlatformCompletionError(error) ||
        attempt === PLATFORM_COMPLETION_ATTEMPTS
      ) {
        throw error;
      }
      await wait(Math.min(1_000 * 2 ** (attempt - 1), 15_000));
    }
  }
  throw lastError || new CliError("Docker migration upload completion failed.");
}

async function waitForPlatformArtifact(
  supabase: SupabaseClient,
  artifactId: string,
): Promise<void> {
  for (let attempt = 0; attempt < PLATFORM_FINALIZATION_POLLS; attempt += 1) {
    if (attempt > 0) await wait(PLATFORM_FINALIZATION_POLL_MS);
    const state = await invokeUploadAction<{
      ready?: unknown;
      artifactId?: unknown;
      status?: unknown;
    }>(
      supabase,
      { action: "artifact_status", artifactId },
      PLATFORM_COMPLETION_FUNCTION,
    );
    if (state?.ready === true && state.artifactId === artifactId) return;
    if (!["pending", "finalizing"].includes(String(state?.status || ""))) {
      throw new CliError(
        "Docker migration artifact finalization returned an invalid state.",
      );
    }
  }
  throw new CliError(
    "Docker migration artifact finalization timed out. The uploaded artifact remains available to resume later.",
  );
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
  artifactId?: string;
  siteIdentifier?: string;
}> {
  const object = getMigrationObjectInfo(
    options.filePath,
    options.newSite ? "pending" : String(options.subdomain || ""),
    options.allowAnyZipName,
  );
  const partCount = Math.ceil(object.size / DEFAULT_PART_SIZE);
  let uploadToken: string | undefined;
  let platformCompletionDispatched = false;
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
      bucket?: unknown;
      key?: unknown;
      siteIdentifier?: unknown;
      artifactId?: unknown;
    }>(supabase, {
      action: "init",
      bucket: object.bucket,
      key: object.key,
      contentType: object.contentType,
      fileSize: object.size,
      partSize: DEFAULT_PART_SIZE,
      ...(options.newSite
        ? {
          purpose: "new_site",
          uploadProtocol: 3,
          platformCanary: true,
        }
        : {}),
    });

    if (typeof initialized?.token === "string" && initialized.token) {
      uploadToken = initialized.token;
    }
    if (!uploadToken || Number(initialized.partCount) !== partCount) {
      throw new CliError("Could not initialize multipart migration upload.");
    }
    const resolvedBucket = typeof initialized.bucket === "string"
      ? initialized.bucket
      : object.bucket;
    const resolvedKey = typeof initialized.key === "string"
      ? initialized.key
      : object.key;
    const siteIdentifier = typeof initialized.siteIdentifier === "string"
      ? initialized.siteIdentifier
      : undefined;
    const artifactId = typeof initialized.artifactId === "string"
      ? initialized.artifactId
      : undefined;
    if (options.newSite) {
      const keyMatch = resolvedKey.match(PLATFORM_ARTIFACT_KEY_RE);
      if (
        resolvedBucket !== PLATFORM_MIGRATION_BUCKET ||
        !/^[a-z]{2}[a-z0-9]{13}$/.test(siteIdentifier || "") ||
        !PLATFORM_ARTIFACT_ID_RE.test(artifactId || "") ||
        keyMatch?.[1] !== siteIdentifier ||
        keyMatch?.[2] !== artifactId
      ) {
        throw new CliError(
          "Upload service returned an invalid Docker migration artifact target.",
        );
      }
    } else if (
      resolvedBucket !== object.bucket ||
      !/^public\/site-migration-[a-z0-9][a-z0-9-]{0,62}\.(?:zip|tar\.gz)$/
        .test(resolvedKey)
    ) {
      throw new CliError("Upload service returned an invalid migration object key.");
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
    platformCompletionDispatched = options.newSite === true;
    const completed = options.newSite
      ? await completePlatformUpload(supabase, artifactId!)
      : await invokeUploadAction<Record<string, unknown>>(supabase, {
        action: "complete",
        token: uploadToken,
        parts: completedParts,
      });
    if (completed?.ok !== true) {
      throw new CliError("Storage did not confirm the completed migration upload.");
    }
    const completedBucket = typeof completed.bucket === "string"
      ? completed.bucket
      : resolvedBucket;
    const completedKey = typeof completed.key === "string"
      ? completed.key
      : resolvedKey;
    if (
      completedBucket !== resolvedBucket ||
      completedKey !== resolvedKey ||
      (options.newSite && completed.artifactId !== artifactId)
    ) {
      throw new CliError("Upload service returned inconsistent migration object keys.");
    }
    if (
      options.newSite &&
      String(completed.artifactStatus || "") !== "ready"
    ) {
      await waitForPlatformArtifact(supabase, artifactId!);
    }

    return {
      bucket: completedBucket,
      key: completedKey,
      size: object.size,
      ...(artifactId ? { artifactId } : {}),
      ...(siteIdentifier ? { siteIdentifier } : {}),
    };
  } catch (error) {
    if (uploadToken && !platformCompletionDispatched) {
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

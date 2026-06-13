import { createReadStream, statSync } from "node:fs";
import { basename } from "node:path";
import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CliError } from "./errors.js";
import { invokeFunction } from "./supabase.js";

const MAX_UPLOAD_SIZE = 10 * 1024 * 1024 * 1024;
const DEFAULT_PART_SIZE = 25 * 1024 * 1024;

export interface UploadMigrationOptions {
  filePath: string;
  subdomain: string;
  allowAnyZipName?: boolean;
  onProgress?: (progress: { loaded: number; total?: number }) => void;
}

export function getMigrationObjectInfo(filePath: string, subdomain: string, allowAnyZipName = false): {
  bucket: string;
  key: string;
  contentType: string;
  size: number;
} {
  const fileName = basename(filePath).toLowerCase();
  const isTarGz = fileName.endsWith(".tar.gz") || fileName.endsWith(".tgz");
  const isZip = fileName.endsWith(".zip");
  if (!isTarGz && !isZip) {
    throw new CliError("Migration files must end in .zip, .tar.gz, or .tgz.");
  }
  if (isZip && !allowAnyZipName && !fileName.includes("studio-backup-")) {
    throw new CliError("ZIP migration files must be exported by Static Studio Backup and Migrate and include `studio-backup-` in the filename.");
  }

  const { size } = statSync(filePath);
  if (size > MAX_UPLOAD_SIZE) {
    throw new CliError("The selected file exceeds the 10 GB migration upload limit.");
  }

  const extension = isTarGz ? ".tar.gz" : ".zip";
  return {
    bucket: "site_migrations",
    key: `public/site-migration-${subdomain}${extension}`,
    contentType: isTarGz ? "application/gzip" : "application/zip",
    size,
  };
}

export async function uploadMigrationFile(
  supabase: SupabaseClient,
  options: UploadMigrationOptions,
): Promise<{ bucket: string; key: string; size: number }> {
  const object = getMigrationObjectInfo(options.filePath, options.subdomain, options.allowAnyZipName);
  const creds = await invokeFunction<{
    accessKeyId?: string;
    secretAccessKey?: string;
    region?: string;
    endpoint?: string;
  }>(supabase, "get-upload-credentials");

  if (!creds.accessKeyId || !creds.secretAccessKey || !creds.endpoint) {
    throw new CliError("Upload credentials were incomplete.");
  }

  const client = new S3Client({
    region: creds.region || "us-east-1",
    endpoint: creds.endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
    },
    maxAttempts: 5,
    retryMode: "adaptive",
  });

  const uploader = new Upload({
    client,
    params: {
      Bucket: object.bucket,
      Key: object.key,
      ContentType: object.contentType,
      Body: createReadStream(options.filePath),
    },
    queueSize: 2,
    partSize: DEFAULT_PART_SIZE,
    leavePartsOnError: false,
  });

  if (options.onProgress) {
    uploader.on("httpUploadProgress", (progress) => {
      options.onProgress?.({
        loaded: progress.loaded || 0,
        ...(progress.total ? { total: progress.total } : {}),
      });
    });
  }

  await uploader.done();
  return {
    bucket: object.bucket,
    key: object.key,
    size: object.size,
  };
}

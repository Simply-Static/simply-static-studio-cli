#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Command } from "commander";
import { getAccountUsage } from "./account.js";
import { getSiteAlerts, saveSiteAlerts, sendTestSiteAlert } from "./alerts.js";
import { loginWithEmail, loginWithToken, logout } from "./auth.js";
import { getConfigPath } from "./config.js";
import {
  addDomain,
  getHostnames,
  issueSsl,
  removeDomain,
  setMountPath,
  setPrimaryDomain,
  transferDomain,
} from "./domains.js";
import {
  cancelExport,
  getMigrationLog,
  getRollbackStatus,
  listProductionSiteReleases,
  listRollbackSnapshots,
  startRollback,
} from "./deployments.js";
import {
  connectEnvironmentDomain,
  createEnvironment,
  deleteEnvironment,
  disableEnvironments,
  enableEnvironments,
  getEnvironmentStatus,
  issueEnvironmentSsl,
  listEnvironmentHostnames,
  removeEnvironmentDomains,
} from "./environments.js";
import { CliError, cliErrorExitCode, cliErrorJson, cliErrorMessage } from "./errors.js";
import {
  MAX_SEO_FILE_BYTES,
  applySeoFiles,
  checkSitemaps,
  deleteSeoFile,
  disableIndexNow,
  enableIndexNow,
  getHealthOverview,
  getIndexNowStatus,
  listSeoFiles,
  runHealthCheck,
  saveSeoFile,
  setIndexNowAutoSubmit,
  submitIndexNow,
} from "./health.js";
import { getDebugLog } from "./logs.js";
import { printValue } from "./output.js";
import { getSiteStatistics, listPerformanceReports, runPerformanceTest } from "./performance.js";
import { confirm } from "./prompt.js";
import {
  copyPlatformBackup,
  deleteSshKey,
  getPlatformBackup,
  getPlatformBackupDownload,
  getPlatformBackupPolicy,
  getSshInfo,
  listBackups,
  queueBackup,
  queueSshKey,
  retrySftpReconciliation,
  updatePlatformBackupPolicy,
} from "./queues.js";
import {
  createReportShare,
  deleteReportSchedule,
  disableReportSchedule,
  generateReportPdf,
  getReportById,
  getSignedReportPdfUrl,
  listReportSchedules,
  listReportShares,
  listReportsBySite,
  revokeReportShare,
  saveReportSchedule,
} from "./reports.js";
import {
  bulkCreateRedirects,
  createRedirect,
  deleteRedirect,
  listRedirects,
  refreshRedirectRules,
  setRedirectActive,
  updateRedirect,
} from "./redirects.js";
import {
  clearCache,
  createSite,
  createSiteWithMigration,
  deleteSite,
  getBasicAuthCredentials,
  getChangesCount,
  getMagicLoginLink,
  getPlatformSiteLifecycle,
  getSite,
  getSiteMigrationSubdomain,
  listSites,
  pushSite,
  redeploySite,
  retryFailedDeployment,
  siteSummaryRows,
  updateSite,
  updatePlatformRuntimePolicy,
  updatePlatformSiteLifecycle,
} from "./sites.js";
import { getAuthContext, invokeFunction } from "./supabase.js";
import { assignTagToSite, createTag, deleteTag, listSiteTags, listTags, removeTagFromSite, updateTag } from "./tags.js";
import { bulkInviteTeamMembers, listTeamMembers, parseEmailInputFile, removeTeamMember } from "./team.js";
import { uploadMigrationFile } from "./upload.js";
import { addExistingUser, inviteUser, listUsers, makeAdmin, removeUser } from "./users.js";
import {
  assertReadableFileWithinLimit,
  normalizeEmailList,
  normalizeMountPath,
  parsePositiveInteger,
  requireAllowedValue,
} from "./validation.js";
import type { CommandGlobals } from "./types.js";

const program = new Command();
const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version: string };
type ParsedOptions = Record<string, any>;

program
  .name("static-studio")
  .description("Static Studio hosting platform CLI")
  .version(packageJson.version)
  .option("--json", "print JSON output")
  .option("--profile <name>", "configuration profile", "default");

function globals(command: Command): CommandGlobals {
  return command.optsWithGlobals() as CommandGlobals;
}

async function withAuth<T>(
  command: Command,
  handler: (ctx: Awaited<ReturnType<typeof getAuthContext>>) => Promise<T>,
): Promise<T> {
  const opts = globals(command);
  return handler(await getAuthContext(opts.profile));
}

function print(command: Command, value: unknown): void {
  printValue(value, { json: Boolean(globals(command).json) });
}

function debugLogOptions(opts: ParsedOptions) {
  return {
    ...(opts.tail ? { tail: Number(opts.tail) } : {}),
    ...(opts.level ? { level: opts.level } : {}),
    ...(opts.search ? { search: opts.search } : {}),
    ...(opts.outputFile ? { outputFile: opts.outputFile } : {}),
    ...(opts.overwrite ? { overwriteOutput: true } : {}),
    ...(opts.timeout ? { timeoutMs: Number(opts.timeout) * 1000 } : {}),
    ...(opts.maxBytes ? { maxBytes: Number(opts.maxBytes) } : {}),
    ...(opts.newestFirst ? { newestFirst: true } : {}),
    ...(opts.allowInsecureHttp ? { allowInsecureHttp: true } : {}),
    ...(opts.allowPrivateNetwork ? { allowPrivateNetwork: true } : {}),
  };
}

function redirectUpdateOptions(opts: ParsedOptions): { fromPath?: string; toPath?: string; isActive?: boolean } {
  if (opts.active && opts.inactive) {
    throw new CliError("Use only one of --active or --inactive.");
  }

  return {
    ...(opts.fromPath !== undefined ? { fromPath: opts.fromPath } : {}),
    ...(opts.toPath !== undefined ? { toPath: opts.toPath } : {}),
    ...(opts.active ? { isActive: true } : {}),
    ...(opts.inactive ? { isActive: false } : {}),
  };
}

function parseToggle(value: string, label: string): boolean {
  const normalized = String(value || "").trim().toLowerCase();
  if (["on", "true", "yes", "1"].includes(normalized)) return true;
  if (["off", "false", "no", "0"].includes(normalized)) return false;
  throw new CliError(`${label} must be on or off.`);
}

function readSecretEnvironmentVariable(name: string, label: string): string {
  const variable = String(name || "").trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) {
    throw new CliError(`${label} environment variable name is invalid.`);
  }
  const value = process.env[variable];
  if (value === undefined || value === "") {
    throw new CliError(`${label} environment variable ${variable} is not set.`);
  }
  return value;
}

function printDebugLogResult(cmd: Command, result: Awaited<ReturnType<typeof getDebugLog>>, outputFile?: string): void {
  if (globals(cmd).json) {
    print(cmd, result);
    return;
  }
  if (outputFile) {
    const { log: _log, ...metadata } = result;
    print(cmd, { ...metadata, outputFile });
    return;
  }
  print(cmd, result.log);
}

async function collectTeamEmails(emails: string[] | undefined, file: string | undefined, maxEmails: number): Promise<string[]> {
  const fromArgs = emails && emails.length > 0 ? normalizeEmailList(emails, { max: maxEmails }) : [];
  const fromFile = file ? await parseEmailInputFile(file, maxEmails) : [];
  return normalizeEmailList([...fromArgs, ...fromFile], { max: maxEmails });
}

program
  .command("login")
  .description("sign in with an email OTP, Personal Access Token, or Supabase session token pair")
  .option("--email <email>", "email address for OTP login")
  .option("--otp <code>", "email OTP code; useful for non-interactive usage")
  .option("--token <token>", "Personal Access Token, or Supabase session access token when paired with --refresh-token")
  .option("--refresh-token <token>", "refresh token paired with a Supabase session access token")
  .option("--create-user", "allow Supabase Auth to create a user during OTP login")
  .action(async (localOpts: ParsedOptions, cmd: Command) => {
    const opts = { ...globals(cmd), ...localOpts } as CommandGlobals & {
      email?: string;
      otp?: string;
      token?: string;
      refreshToken?: string;
      createUser?: boolean;
    };
    const profile = opts.token
      ? await loginWithToken({
          token: opts.token,
          ...(opts.refreshToken ? { refreshToken: opts.refreshToken } : {}),
          ...(opts.profile ? { profile: opts.profile } : {}),
        })
      : await loginWithEmail({
          ...(opts.email ? { email: opts.email } : {}),
          ...(opts.otp ? { otp: opts.otp } : {}),
          ...(opts.createUser !== undefined ? { createUser: opts.createUser } : {}),
          ...(opts.profile ? { profile: opts.profile } : {}),
        });

    print(cmd, {
      message: "Logged in.",
      profile: opts.profile || "default",
      user: profile.user,
      configPath: getConfigPath(),
    });
  });

program
  .command("logout")
  .description("remove the saved local session")
  .action(async (_localOpts: ParsedOptions, cmd: Command) => {
    const opts = globals(cmd);
    const removed = await logout(opts.profile);
    print(cmd, {
      message: removed ? "Logged out." : "No saved session found.",
      profile: opts.profile,
    });
  });

program
  .command("whoami")
  .description("show the authenticated Static Studio user")
  .action(async (_localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ user, profile }) => {
      print(cmd, {
        id: user.id,
        email: user.email,
        expiresAt: profile?.expiresAt,
      });
    });
  });

program
  .command("status")
  .description("check platform status integrations")
  .action(async (_localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      const bunny = await invokeFunction(supabase, "check-bunny-status");
      print(cmd, bunny);
    });
  });

const sites = program.command("sites").description("manage hosted sites");

sites
  .command("list")
  .description("list sites visible to the authenticated user")
  .option("--page <number>", "page number", "1")
  .option("--page-size <number>", "rows per page", "20")
  .option("--search <term>", "filter by name or URL")
  .option("--sort <field>", "sort field", "created_at")
  .option("--asc", "sort ascending")
  .action(async (localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase, user }) => {
      const result = await listSites(supabase, user, {
        page: Number(localOpts.page),
        pageSize: Number(localOpts.pageSize),
        search: localOpts.search,
        sort: localOpts.sort,
        ascending: Boolean(localOpts.asc),
      });
      print(cmd, globals(cmd).json ? result : siteSummaryRows(result.data));
    });
  });

sites
  .command("get <siteId>")
  .description("show a single site record")
  .action(async (siteId: string, _localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await getSite(supabase, siteId));
    });
  });

sites
  .command("basic-auth <siteId>")
  .description("show Basic Auth credentials for a site")
  .option("--email <email>", "site_meta email to use instead of the authenticated user")
  .action(async (siteId: string, opts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase, user }) => {
      print(cmd, await getBasicAuthCredentials(supabase, siteId, opts.email || user.email || undefined));
    });
  });

sites
  .command("magic-login <siteId>")
  .description("generate a short-lived WordPress magic login link")
  .option("--email <email>", "site_meta email to use instead of the authenticated user")
  .action(async (siteId: string, opts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase, user }) => {
      const result = await getMagicLoginLink(supabase, siteId, opts.email || user.email || undefined);
      print(cmd, globals(cmd).json ? result : result.url);
    });
  });

sites
  .command("debug-log <siteId>")
  .description("fetch the WordPress debug log for a site")
  .option("--tail <lines>", "return only the last N lines")
  .option("--level <level>", "filter by level: all, error, warning, notice, info", "all")
  .option("--search <term>", "return only lines containing this text")
  .option("--newest-first", "reverse log lines before printing")
  .option("--output-file <path>", "write log text to a local file with 0600 permissions")
  .option("--overwrite", "replace --output-file if it already exists")
  .option("--timeout <seconds>", "network timeout in seconds", "30")
  .option("--max-bytes <bytes>", "maximum response size", String(5 * 1024 * 1024))
  .option("--allow-insecure-http", "allow fetching logs over HTTP")
  .option("--allow-private-network", "allow fetching logs from local or private network hosts")
  .action(async (siteId: string, opts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      const result = await getDebugLog(supabase, siteId, debugLogOptions(opts));
      printDebugLogResult(cmd, result, opts.outputFile);
    });
  });

sites
  .command("create")
  .description("create and queue a new Static Studio site")
  .option("--name <name>", "site display name")
  .option("--mount-path <path>", "serve the static site below this URL path")
  .option("--php-version <version>", "PHP version", "8.3")
  .option("--migration-file <path>", "upload a migration archive before queueing the site")
  .option("--migration-artifact-id <id>", "resume creation from a finalized Docker migration artifact")
  .option("--allow-any-zip-name", "skip Static Studio backup ZIP filename check")
  .action(async (opts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase, user }) => {
      if (opts.migrationFile && opts.migrationArtifactId) {
        throw new CliError(
          "Choose either --migration-file or --migration-artifact-id, not both.",
        );
      }
      const phpVersion = requireAllowedValue(
        String(opts.phpVersion || "8.3"),
        ["8.2", "8.3", "8.4"] as const,
        "PHP version",
      );
      const mountPath = normalizeMountPath(opts.mountPath);
      const createOptions = {
        name: opts.name,
        email: user.email || "",
        userId: user.id,
        phpVersion,
        mountPath,
        ...(opts.migrationArtifactId
          ? { migrationArtifactId: opts.migrationArtifactId }
          : {}),
      };

      if (!opts.migrationFile) {
        print(cmd, await createSite(supabase, createOptions));
        return;
      }

      process.stderr.write("Uploading migration file...\n");
      const result = await createSiteWithMigration(supabase, {
        ...createOptions,
        migrationFile: opts.migrationFile,
        allowAnyZipName: Boolean(opts.allowAnyZipName),
        onUploadProgress: ({ loaded, total }) => {
          if (!process.stderr.isTTY || !total) return;
          const pct = Math.min(100, Math.round((loaded / total) * 100));
          process.stderr.write(`\rUpload ${pct}%`);
        },
      });
      if (process.stderr.isTTY) process.stderr.write("\n");
      print(cmd, result);
    });
  });

sites
  .command("update <siteId>")
  .description("update site metadata")
  .option("--name <name>", "new name")
  .option("--notes <notes>", "new notes")
  .option("--status <status>", "new status")
  .action(async (siteId: string, opts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await updateSite(supabase, siteId, opts));
    });
  });

sites
  .command("delete <siteId>")
  .description("queue site deletion")
  .option("-y, --yes", "skip confirmation")
  .action(async (siteId: string, opts: ParsedOptions, cmd: Command) => {
    if (!opts.yes && !(await confirm(`Queue deletion for site ${siteId}?`))) {
      throw new CliError("Cancelled.", 0);
    }
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await deleteSite(supabase, siteId));
    });
  });

sites
  .command("push")
  .description("push a static site")
  .argument("<siteId>", "site ID")
  .argument("[mode]", "push mode: full or changes", "full")
  .action(async (siteId: string, mode: string, _localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await pushSite(supabase, siteId, mode));
    });
  });

sites
  .command("redeploy <siteId>")
  .description("redeploy an existing site")
  .requiredOption("--migration-file <path>", "upload a replacement migration archive before redeploying")
  .option("--allow-any-zip-name", "skip Static Studio backup ZIP filename check")
  .action(async (siteId: string, opts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      let upload: unknown = null;
      if (opts.migrationFile) {
        const subdomain = await getSiteMigrationSubdomain(supabase, siteId);
        process.stderr.write(`Uploading migration file to ${subdomain}...\n`);
        upload = await uploadMigrationFile(supabase, {
          filePath: opts.migrationFile,
          subdomain,
          allowAnyZipName: Boolean(opts.allowAnyZipName),
          onProgress: ({ loaded, total }) => {
            if (!process.stderr.isTTY || !total) return;
            const pct = Math.min(100, Math.round((loaded / total) * 100));
            process.stderr.write(`\rUpload ${pct}%`);
          },
        });
        if (process.stderr.isTTY) process.stderr.write("\n");
      }

      print(cmd, {
        redeploy: await redeploySite(supabase, siteId),
        upload,
      });
    });
  });

sites
  .command("retry <siteId>")
  .description("retry a failed deployment")
  .action(async (siteId: string, _localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await retryFailedDeployment(supabase, siteId));
    });
  });

sites
  .command("runtime-status <siteId>")
  .description("show Docker runtime state and recent lifecycle diagnostics")
  .action(async (siteId: string, _localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await getPlatformSiteLifecycle(supabase, siteId));
    });
  });

for (const action of ["start", "stop"] as const) {
  sites
    .command(`${action} <siteId>`)
    .description(`${action} a Docker WordPress runtime`)
    .action(async (siteId: string, _localOpts: ParsedOptions, cmd: Command) => {
      await withAuth(cmd, async ({ supabase }) => {
        print(cmd, await updatePlatformSiteLifecycle(supabase, siteId, action));
      });
    });
}

sites
  .command("runtime-policy <siteId> <state>")
  .description("set Docker WordPress runtime policy to always-on or timed")
  .action(async (siteId: string, state: string, _localOpts: ParsedOptions, cmd: Command) => {
    const normalized = String(state || "").trim().toLowerCase();
    if (!["always-on", "timed"].includes(normalized)) {
      throw new CliError("Runtime policy must be `always-on` or `timed`.");
    }
    await withAuth(cmd, async ({ supabase }) => {
      print(
        cmd,
        await updatePlatformRuntimePolicy(
          supabase,
          siteId,
          normalized === "always-on",
        ),
      );
    });
  });

sites
  .command("changes <siteId>")
  .description("show pending WordPress change count")
  .action(async (siteId: string, _localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, { siteId, changes: await getChangesCount(supabase, siteId) });
    });
  });

sites
  .command("clear-cache <siteId>")
  .description("clear CDN cache for a site")
  .action(async (siteId: string, _localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await clearCache(supabase, siteId));
    });
  });

sites
  .command("cancel-export <siteId>")
  .description("cancel the site's active static export")
  .option("-y, --yes", "skip confirmation")
  .action(async (siteId: string, opts: ParsedOptions, cmd: Command) => {
    if (!opts.yes && !(await confirm(`Cancel the active export for site ${siteId}?`))) {
      throw new CliError("Cancelled.", 0);
    }
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await cancelExport(supabase, siteId));
    });
  });

sites
  .command("migration-log <siteId>")
  .description("show the site's migration log")
  .action(async (siteId: string, _localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      const result = await getMigrationLog(supabase, siteId);
      print(cmd, globals(cmd).json ? result : result.content);
    });
  });

sites
  .command("releases <siteId>")
  .description("list recent production releases")
  .option("--limit <number>", "number of releases", "10")
  .action(async (siteId: string, opts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await listProductionSiteReleases(supabase, siteId, Number(opts.limit)));
    });
  });

sites
  .command("rollback-status <siteId>")
  .description("show rollback availability and state")
  .action(async (siteId: string, _localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await getRollbackStatus(supabase, siteId));
    });
  });

sites
  .command("rollback-snapshots <siteId>")
  .description("list available rollback snapshots")
  .action(async (siteId: string, _localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await listRollbackSnapshots(supabase, siteId));
    });
  });

sites
  .command("rollback <siteId> <snapshotId>")
  .description("restore a static export snapshot")
  .option("-y, --yes", "skip confirmation")
  .action(async (siteId: string, snapshotId: string, opts: ParsedOptions, cmd: Command) => {
    if (!opts.yes && !(await confirm(`Roll back site ${siteId} to snapshot ${snapshotId}?`))) {
      throw new CliError("Cancelled.", 0);
    }
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await startRollback(supabase, siteId, snapshotId));
    });
  });

const domains = program.command("domains").description("manage domains and SSL");

domains
  .command("list <siteId>")
  .description("list CDN hostnames for a site")
  .action(async (siteId: string, _localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      const site = await getSite(supabase, siteId);
      if (!site.pull_zone_id) throw new CliError("Site does not have a pull_zone_id yet.");
      print(cmd, await getHostnames(supabase, String(site.pull_zone_id)));
    });
  });

domains
  .command("add <siteId> <domain>")
  .description("add a custom domain and start an export")
  .action(async (siteId: string, domain: string, _localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await addDomain(supabase, siteId, domain));
    });
  });

domains
  .command("primary <siteId> <domain>")
  .description("set the primary custom domain and start an export")
  .action(async (siteId: string, domain: string, _localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await setPrimaryDomain(supabase, siteId, domain));
    });
  });

domains
  .command("remove <siteId> <domain>")
  .description("remove a custom domain")
  .action(async (siteId: string, domain: string, _localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await removeDomain(supabase, siteId, domain));
    });
  });

domains
  .command("mount <siteId> <domain> [path]")
  .description("set or clear the site's public mount path")
  .action(async (siteId: string, domain: string, path: string | undefined, _localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await setMountPath(supabase, siteId, domain, path || ""));
    });
  });

domains
  .command("issue-ssl <siteOrDomain> [domain]")
  .description("request SSL issuance for a domain")
  .option("--site-id <siteId>", "site ID for the legacy single-domain syntax")
  .action(async (siteOrDomain: string, domain: string | undefined, opts: ParsedOptions, cmd: Command) => {
    const siteId = domain ? siteOrDomain : opts.siteId;
    const hostname = domain || siteOrDomain;
    if (!siteId) {
      throw new CliError("A site ID is required. Use `domains issue-ssl <siteId> <domain>`.");
    }
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await issueSsl(supabase, siteId, hostname));
    });
  });

domains
  .command("transfer <sourceSiteId> <targetSiteId> <domain>")
  .description("move a custom domain between sites you administer")
  .option("-y, --yes", "skip confirmation")
  .action(async (
    sourceSiteId: string,
    targetSiteId: string,
    domain: string,
    opts: ParsedOptions,
    cmd: Command,
  ) => {
    if (
      !opts.yes &&
      !(await confirm(`Move ${domain} from site ${sourceSiteId} to site ${targetSiteId}?`))
    ) {
      throw new CliError("Cancelled.", 0);
    }
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await transferDomain(supabase, sourceSiteId, targetSiteId, domain));
    });
  });

const account = program.command("account").description("show account usage and subscription data");

account
  .command("usage")
  .description("show account storage, bandwidth, and site counts")
  .option("--account-id <id>", "account owner ID; defaults to the authenticated user")
  .option("--include-subscription", "include latest subscription row")
  .action(async (opts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase, user }) => {
      print(cmd, await getAccountUsage(supabase, opts.accountId || user.id, {
        includeSubscription: Boolean(opts.includeSubscription),
      }));
    });
  });

const health = program.command("health").description("inspect and run Site Health checks");

health
  .command("overview <siteId>")
  .description("show health, deploy, issue, and release data for a site")
  .option("--issue-limit <number>", "maximum open issues", "20")
  .option("--result-limit <number>", "maximum recent check results", "50")
  .option("--release-limit <number>", "maximum recent releases", "20")
  .action(async (siteId: string, opts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await getHealthOverview(supabase, siteId, {
        issueLimit: Number(opts.issueLimit),
        resultLimit: Number(opts.resultLimit),
        releaseLimit: Number(opts.releaseLimit),
      }));
    });
  });

health
  .command("run <siteIds...>")
  .description("run health checks for one or more sites")
  .option("--checks <types...>", "specific checks to run")
  .action(async (siteIds: string[], opts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await runHealthCheck(supabase, siteIds, opts.checks));
    });
  });

const alerts = program.command("alerts").description("manage Site Health alerts");

alerts
  .command("status <siteId>")
  .description("show alert settings, conditions, incidents, and events")
  .action(async (siteId: string, _localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await getSiteAlerts(supabase, siteId));
    });
  });

alerts
  .command("save <siteId>")
  .description("save Site Health alert settings")
  .requiredOption("--enabled <state>", "turn alerts on or off")
  .option("--recipients <emails...>", "alert recipient email addresses")
  .option("--uptime <state>", "turn uptime alerts on or off")
  .option("--uptime-threshold <minutes>", "downtime threshold in minutes", "10")
  .option("--performance <state>", "turn performance alerts on or off")
  .option("--performance-threshold <score>", "minimum PageSpeed score", "70")
  .option("--seo-critical <state>", "turn critical SEO alerts on or off")
  .option("--notify-on-recovery <state>", "turn recovery notices on or off")
  .action(async (siteId: string, opts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await saveSiteAlerts(supabase, siteId, {
        enabled: parseToggle(opts.enabled, "enabled"),
        recipients: opts.recipients || [],
        ...(opts.uptime === undefined ? {} : { uptimeEnabled: parseToggle(opts.uptime, "uptime") }),
        uptimeThresholdMinutes: Number(opts.uptimeThreshold),
        ...(opts.performance === undefined
          ? {}
          : { performanceEnabled: parseToggle(opts.performance, "performance") }),
        performanceThreshold: Number(opts.performanceThreshold),
        ...(opts.seoCritical === undefined
          ? {}
          : { seoCriticalEnabled: parseToggle(opts.seoCritical, "seo-critical") }),
        ...(opts.notifyOnRecovery === undefined
          ? {}
          : { notifyOnRecovery: parseToggle(opts.notifyOnRecovery, "notify-on-recovery") }),
      }));
    });
  });

alerts
  .command("test <siteId> <recipients...>")
  .description("send a test Site Health alert")
  .action(async (siteId: string, recipients: string[], _localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await sendTestSiteAlert(supabase, siteId, recipients));
    });
  });

const seo = program.command("seo").description("manage root-level SEO files");

seo
  .command("list <siteId>")
  .description("list managed SEO files")
  .action(async (siteId: string, _localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await listSeoFiles(supabase, siteId));
    });
  });

seo
  .command("save <siteId> <path>")
  .description("create or update a root-level SEO file")
  .option("--content <text>", "file content")
  .option("--file <path>", "read content from a local file")
  .option("--kind <kind>", "SEO file kind")
  .option("--mime-type <type>", "file MIME type")
  .action(async (siteId: string, path: string, opts: ParsedOptions, cmd: Command) => {
    if ((opts.content === undefined) === (opts.file === undefined)) {
      throw new CliError("Provide exactly one of --content or --file.");
    }
    let content = String(opts.content ?? "");
    if (opts.file) {
      await assertReadableFileWithinLimit(opts.file, MAX_SEO_FILE_BYTES);
      content = await readFile(opts.file, "utf8");
    }
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await saveSeoFile(supabase, siteId, {
        path,
        content,
        ...(opts.kind ? { fileKind: opts.kind } : {}),
        ...(opts.mimeType ? { mimeType: opts.mimeType } : {}),
      }));
    });
  });

seo
  .command("delete <siteId> <path>")
  .description("delete a managed SEO file")
  .option("-y, --yes", "skip confirmation")
  .action(async (siteId: string, path: string, opts: ParsedOptions, cmd: Command) => {
    if (!opts.yes && !(await confirm(`Delete SEO file ${path} from site ${siteId}?`))) {
      throw new CliError("Cancelled.", 0);
    }
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await deleteSeoFile(supabase, siteId, path));
    });
  });

seo
  .command("apply <siteId>")
  .description("push all managed SEO files to the site's static storage")
  .action(async (siteId: string, _localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await applySeoFiles(supabase, siteId));
    });
  });

seo
  .command("check-sitemaps <siteId>")
  .description("check common sitemap files on the public site")
  .action(async (siteId: string, _localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await checkSitemaps(supabase, siteId));
    });
  });

const indexNow = program.command("indexnow").description("manage IndexNow submissions");

indexNow
  .command("status <siteId>")
  .description("show IndexNow settings and submission state")
  .action(async (siteId: string, _localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await getIndexNowStatus(supabase, siteId));
    });
  });

indexNow
  .command("enable <siteId>")
  .description("enable IndexNow for a site")
  .action(async (siteId: string, _localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await enableIndexNow(supabase, siteId));
    });
  });

indexNow
  .command("disable <siteId>")
  .description("disable IndexNow for a site")
  .action(async (siteId: string, _localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await disableIndexNow(supabase, siteId));
    });
  });

indexNow
  .command("auto-submit <siteId> <state>")
  .description("turn automatic post-release submission on or off")
  .action(async (siteId: string, state: string, _localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await setIndexNowAutoSubmit(supabase, siteId, parseToggle(state, "state")));
    });
  });

indexNow
  .command("submit <siteId>")
  .description("submit the latest or a selected release to IndexNow")
  .option("--release-id <id>", "release ID to submit")
  .action(async (siteId: string, opts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await submitIndexNow(supabase, siteId, {
        ...(opts.releaseId ? { releaseId: opts.releaseId } : {}),
      }));
    });
  });

const reports = program.command("reports").description("inspect and share Agency reports");

reports
  .command("list <siteId>")
  .description("list reports for a site")
  .option("--limit <number>", "number of reports", "20")
  .action(async (siteId: string, opts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await listReportsBySite(supabase, siteId, Number(opts.limit)));
    });
  });

reports
  .command("get <reportId>")
  .description("show a stored report")
  .action(async (reportId: string, _localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await getReportById(supabase, reportId));
    });
  });

reports
  .command("generate-pdf <reportId>")
  .description("generate and store a report PDF")
  .action(async (reportId: string, _localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await generateReportPdf(supabase, reportId));
    });
  });

reports
  .command("pdf-url <reportId>")
  .description("create a short-lived signed URL for a report PDF")
  .action(async (reportId: string, _localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      const url = await getSignedReportPdfUrl(supabase, reportId);
      print(cmd, globals(cmd).json ? { url } : url);
    });
  });

reports
  .command("shares <reportId>")
  .description("list client share links for a report")
  .action(async (reportId: string, _localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await listReportShares(supabase, reportId));
    });
  });

reports
  .command("share <reportId>")
  .description("create a client share link")
  .option("--recipient <email>", "recipient email")
  .option("--password-env <variable>", "read the optional share password from an environment variable")
  .option("--expires-at <timestamp>", "future expiration time")
  .action(async (reportId: string, opts: ParsedOptions, cmd: Command) => {
    const password = opts.passwordEnv
      ? readSecretEnvironmentVariable(opts.passwordEnv, "Report password")
      : undefined;
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await createReportShare(supabase, reportId, {
        ...(opts.recipient ? { recipientEmail: opts.recipient } : {}),
        ...(password ? { password } : {}),
        ...(opts.expiresAt ? { expiresAt: opts.expiresAt } : {}),
      }));
    });
  });

reports
  .command("revoke-share <reportId> <shareId>")
  .description("revoke a client share link")
  .option("-y, --yes", "skip confirmation")
  .action(async (reportId: string, shareId: string, opts: ParsedOptions, cmd: Command) => {
    if (!opts.yes && !(await confirm(`Revoke report share ${shareId}?`))) {
      throw new CliError("Cancelled.", 0);
    }
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await revokeReportShare(supabase, reportId, shareId));
    });
  });

reports
  .command("schedules [siteId]")
  .description("list report schedules")
  .action(async (siteId: string | undefined, _localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await listReportSchedules(supabase, siteId));
    });
  });

reports
  .command("schedule <cadence> <siteIds...>")
  .description("create or update a weekly or monthly report schedule")
  .option("--schedule-id <id>", "existing schedule UUID")
  .option("--name <name>", "schedule name")
  .option("--auto-share <state>", "turn automatic client sharing on or off")
  .option("--recipient <email>", "automatic-share recipient")
  .action(async (cadence: string, siteIds: string[], opts: ParsedOptions, cmd: Command) => {
    const autoShare = opts.autoShare === undefined
      ? undefined
      : parseToggle(opts.autoShare, "auto-share");
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await saveReportSchedule(supabase, siteIds, cadence, {
        ...(opts.scheduleId ? { scheduleId: opts.scheduleId } : {}),
        ...(opts.name ? { name: opts.name } : {}),
        ...(autoShare === undefined ? {} : { autoShare }),
        ...(opts.recipient ? { recipientEmail: opts.recipient } : {}),
      }));
    });
  });

reports
  .command("disable-schedule <scheduleId>")
  .description("disable a report schedule")
  .action(async (scheduleId: string, _localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await disableReportSchedule(supabase, scheduleId));
    });
  });

reports
  .command("delete-schedule <scheduleId>")
  .description("delete a report schedule")
  .option("-y, --yes", "skip confirmation")
  .action(async (scheduleId: string, opts: ParsedOptions, cmd: Command) => {
    if (!opts.yes && !(await confirm(`Delete report schedule ${scheduleId}?`))) {
      throw new CliError("Cancelled.", 0);
    }
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await deleteReportSchedule(supabase, scheduleId));
    });
  });

const performance = program.command("performance").description("run and inspect performance data");

performance
  .command("run <siteId>")
  .description("run a PageSpeed and global TTFB performance test")
  .option("--force", "ignore cached PageSpeed report")
  .option("--url <url>", "deprecated; must match the stored site URL")
  .action(async (siteId: string, opts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await runPerformanceTest(supabase, siteId, {
        ...(opts.url ? { url: opts.url } : {}),
        force: Boolean(opts.force),
      }));
    });
  });

performance
  .command("stats <siteId>")
  .description("get CDN bandwidth, storage, cache, and response-time statistics")
  .action(async (siteId: string, _localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await getSiteStatistics(supabase, siteId));
    });
  });

performance
  .command("get <siteId>")
  .description("run a performance test and fetch CDN statistics")
  .option("--force", "ignore cached PageSpeed report")
  .option("--url <url>", "deprecated; must match the stored site URL")
  .action(async (siteId: string, opts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      const [pagespeed, statistics] = await Promise.all([
        runPerformanceTest(supabase, siteId, {
          ...(opts.url ? { url: opts.url } : {}),
          force: Boolean(opts.force),
        }),
        getSiteStatistics(supabase, siteId),
      ]);
      print(cmd, { pagespeed, statistics });
    });
  });

performance
  .command("reports <siteId>")
  .description("list cached PageSpeed reports")
  .option("--limit <number>", "number of reports", "10")
  .action(async (siteId: string, opts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await listPerformanceReports(supabase, siteId, parsePositiveInteger(opts.limit, "limit", { min: 1, max: 100 })));
    });
  });

const logs = program.command("logs").description("fetch site logs");

logs
  .command("get <siteId>")
  .description("fetch the WordPress debug log for a site")
  .option("--tail <lines>", "return only the last N lines")
  .option("--level <level>", "filter by level: all, error, warning, notice, info", "all")
  .option("--search <term>", "return only lines containing this text")
  .option("--newest-first", "reverse log lines before printing")
  .option("--output-file <path>", "write log text to a local file with 0600 permissions")
  .option("--overwrite", "replace --output-file if it already exists")
  .option("--timeout <seconds>", "network timeout in seconds", "30")
  .option("--max-bytes <bytes>", "maximum response size", String(5 * 1024 * 1024))
  .option("--allow-insecure-http", "allow fetching logs over HTTP")
  .option("--allow-private-network", "allow fetching logs from local or private network hosts")
  .action(async (siteId: string, opts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      const result = await getDebugLog(supabase, siteId, debugLogOptions(opts));
      printDebugLogResult(cmd, result, opts.outputFile);
    });
  });

const environments = program.command("environments").description("manage site environments");

environments
  .command("list <siteId>")
  .description("list environments and add-on status")
  .action(async (siteId: string, _localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await getEnvironmentStatus(supabase, siteId));
    });
  });

environments
  .command("enable <siteId>")
  .description("enable environment management for a site")
  .action(async (siteId: string, _localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await enableEnvironments(supabase, siteId));
    });
  });

environments
  .command("create <siteId> <name>")
  .description("create a child environment")
  .action(async (siteId: string, name: string, _localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await createEnvironment(supabase, siteId, name));
    });
  });

environments
  .command("delete <siteId> <name>")
  .description("delete a child environment")
  .option("-y, --yes", "skip confirmation")
  .action(async (siteId: string, name: string, opts: ParsedOptions, cmd: Command) => {
    if (!opts.yes && !(await confirm(`Delete environment ${name} for site ${siteId}?`))) {
      throw new CliError("Cancelled.", 0);
    }
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await deleteEnvironment(supabase, siteId, name));
    });
  });

environments
  .command("disable <siteId>")
  .description("disable environments and remove child environments")
  .option("-y, --yes", "skip confirmation")
  .action(async (siteId: string, opts: ParsedOptions, cmd: Command) => {
    if (!opts.yes && !(await confirm(`Disable environments for site ${siteId}? This deletes child environments.`))) {
      throw new CliError("Cancelled.", 0);
    }
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await disableEnvironments(supabase, siteId));
    });
  });

environments
  .command("domain-list <siteId> <environment>")
  .description("list managed and custom hostnames for an environment")
  .action(async (siteId: string, environment: string, _localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await listEnvironmentHostnames(supabase, siteId, environment));
    });
  });

environments
  .command("domain-connect <siteId> <environment> <domain>")
  .description("connect or replace an environment custom domain")
  .action(async (
    siteId: string,
    environment: string,
    domain: string,
    _localOpts: ParsedOptions,
    cmd: Command,
  ) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await connectEnvironmentDomain(supabase, siteId, environment, domain));
    });
  });

environments
  .command("domain-remove <siteId> <environment>")
  .description("remove all custom domains from an environment")
  .option("-y, --yes", "skip confirmation")
  .action(async (siteId: string, environment: string, opts: ParsedOptions, cmd: Command) => {
    if (!opts.yes && !(await confirm(`Remove all custom domains from environment ${environment}?`))) {
      throw new CliError("Cancelled.", 0);
    }
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await removeEnvironmentDomains(supabase, siteId, environment));
    });
  });

environments
  .command("domain-ssl <siteId> <environment> <domain>")
  .description("request SSL for an environment hostname")
  .action(async (
    siteId: string,
    environment: string,
    domain: string,
    _localOpts: ParsedOptions,
    cmd: Command,
  ) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await issueEnvironmentSsl(supabase, siteId, environment, domain));
    });
  });

const tags = program.command("tags").description("manage account tags and site tag assignments");

tags
  .command("list")
  .description("list account tags")
  .option("--account-id <id>", "account owner ID; defaults to the authenticated user")
  .action(async (opts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase, user }) => {
      print(cmd, await listTags(supabase, opts.accountId || user.id));
    });
  });

tags
  .command("site <siteId>")
  .description("list tags assigned to a site")
  .action(async (siteId: string, _localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await listSiteTags(supabase, siteId));
    });
  });

tags
  .command("create <name>")
  .description("create an account tag")
  .option("--color <hex>", "tag color", "#3858E9")
  .option("--account-id <id>", "account owner ID; defaults to the authenticated user")
  .action(async (name: string, opts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase, user }) => {
      print(cmd, await createTag(supabase, opts.accountId || user.id, name, opts.color));
    });
  });

tags
  .command("update <tagId>")
  .description("update a tag name or color")
  .option("--name <name>", "new tag name")
  .option("--color <hex>", "new tag color")
  .action(async (tagId: string, opts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await updateTag(supabase, tagId, opts));
    });
  });

tags
  .command("delete <tagId>")
  .description("delete a tag")
  .option("-y, --yes", "skip confirmation")
  .action(async (tagId: string, opts: ParsedOptions, cmd: Command) => {
    if (!opts.yes && !(await confirm(`Delete tag ${tagId}?`))) {
      throw new CliError("Cancelled.", 0);
    }
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await deleteTag(supabase, tagId));
    });
  });

tags
  .command("assign <siteId> <tagId>")
  .description("assign a tag to a site")
  .action(async (siteId: string, tagId: string, _localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await assignTagToSite(supabase, siteId, tagId));
    });
  });

tags
  .command("remove <siteId> <tagId>")
  .description("remove a tag from a site")
  .action(async (siteId: string, tagId: string, _localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await removeTagFromSite(supabase, siteId, tagId));
    });
  });

const backups = program.command("backups").description("manage site backups");

backups
  .command("list <siteId>")
  .description("list cached backups")
  .option("--refresh", "queue a backup sync before listing")
  .action(async (siteId: string, opts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await listBackups(supabase, siteId, Boolean(opts.refresh)));
    });
  });

for (const action of ["create", "sync"] as const) {
  backups
    .command(`${action} <siteId>`)
    .description(`${action === "create" ? "queue backup creation" : "queue backup sync"}`)
    .action(async (siteId: string, _localOpts: ParsedOptions, cmd: Command) => {
      await withAuth(cmd, async ({ supabase, user }) => {
        print(cmd, await queueBackup(supabase, action, siteId, { userId: user.id }));
      });
    });
}

for (const action of ["restore", "delete"] as const) {
  backups
    .command(`${action} <siteId>`)
    .description(`queue backup ${action}`)
    .option("--backup-id <id>", "backup ID")
    .option("--date <date>", "backup date_string")
    .option("-y, --yes", "skip confirmation")
    .action(async (siteId: string, opts: ParsedOptions, cmd: Command) => {
      if (
        !opts.yes &&
        !(await confirm(
          action === "restore"
            ? `Restore backup ${opts.backupId || opts.date || ""} to site ${siteId}?`
            : `Delete backup ${opts.backupId || opts.date || ""} from site ${siteId}?`,
        ))
      ) {
        throw new CliError("Cancelled.", 0);
      }
      await withAuth(cmd, async ({ supabase, user }) => {
        print(cmd, await queueBackup(supabase, action, siteId, {
          ...opts,
          userId: user.id,
        }));
      });
    });
}

backups
  .command("get <siteId> <backupId>")
  .description("show Docker backup artifact status")
  .action(async (siteId: string, backupId: string, _localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await getPlatformBackup(supabase, siteId, backupId));
    });
  });

backups
  .command("download <siteId> <backupId>")
  .description("create a short-lived Docker backup download URL")
  .action(async (siteId: string, backupId: string, _localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      const result = await getPlatformBackupDownload(supabase, siteId, backupId) as {
        url?: string;
      };
      if (!result.url) {
        throw new CliError("The platform did not return a backup download URL.");
      }
      print(cmd, globals(cmd).json ? result : result.url);
    });
  });

backups
  .command("copy <siteId> <backupId> <targetSiteId>")
  .description("copy a ready Docker backup into another Docker site")
  .option("-y, --yes", "skip confirmation")
  .action(async (
    siteId: string,
    backupId: string,
    targetSiteId: string,
    opts: ParsedOptions,
    cmd: Command,
  ) => {
    if (
      !opts.yes &&
      !(await confirm(`Replace Docker site ${targetSiteId} from backup ${backupId}?`))
    ) {
      throw new CliError("Cancelled.", 0);
    }
    await withAuth(cmd, async ({ supabase }) => {
      print(
        cmd,
        await copyPlatformBackup(supabase, siteId, backupId, targetSiteId),
      );
    });
  });

backups
  .command("policy <siteId> [cadence]")
  .description("show or update Docker automated backup cadence")
  .action(async (
    siteId: string,
    cadence: string | undefined,
    _localOpts: ParsedOptions,
    cmd: Command,
  ) => {
    await withAuth(cmd, async ({ supabase }) => {
      if (!cadence) {
        print(cmd, await getPlatformBackupPolicy(supabase, siteId));
        return;
      }
      const normalized = requireAllowedValue(
        cadence,
        ["daily", "weekly"] as const,
        "Backup cadence",
      );
      print(cmd, await updatePlatformBackupPolicy(supabase, siteId, normalized));
    });
  });

const redirects = program.command("redirects").description("manage CDN redirects");

redirects
  .command("list <siteId>")
  .description("list redirect rules")
  .option("--pull-zone-id <id>", "override pull zone ID")
  .action(async (siteId: string, opts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await listRedirects(supabase, siteId, opts.pullZoneId));
    });
  });

redirects
  .command("create <siteId> <fromPath> <toPath>")
  .description("create a 301 redirect")
  .option("--pull-zone-id <id>", "override pull zone ID")
  .option("--domain <domain>", "override redirect domain")
  .action(async (siteId: string, fromPath: string, toPath: string, opts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await createRedirect(supabase, siteId, fromPath, toPath, opts));
    });
  });

redirects
  .command("update <siteId> <redirectId>")
  .alias("edit")
  .description("update a DB-backed redirect")
  .option("--from-path <path>", "new source path")
  .option("--to-path <path>", "new target path")
  .option("--active", "enable the redirect")
  .option("--inactive", "disable the redirect")
  .action(async (siteId: string, redirectId: string, opts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await updateRedirect(supabase, siteId, redirectId, redirectUpdateOptions(opts)));
    });
  });

redirects
  .command("enable <siteId> <redirectId>")
  .description("enable a DB-backed redirect")
  .action(async (siteId: string, redirectId: string, _localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await setRedirectActive(supabase, siteId, redirectId, true));
    });
  });

redirects
  .command("disable <siteId> <redirectId>")
  .description("disable a DB-backed redirect")
  .action(async (siteId: string, redirectId: string, _localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await setRedirectActive(supabase, siteId, redirectId, false));
    });
  });

redirects
  .command("delete <siteId> <redirectId>")
  .description("delete a DB-backed redirect or disable a legacy edge rule")
  .option("--pull-zone-id <id>", "override pull zone ID")
  .option("--db", "treat redirectId as a DB redirect ID")
  .option("--edge-rule", "treat redirectId as a legacy CDN edge rule ID")
  .action(async (siteId: string, redirectId: string, opts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await deleteRedirect(supabase, siteId, redirectId, opts));
    });
  });

redirects
  .command("refresh <siteId>")
  .description("refresh redirect edge rules from stored redirects")
  .option("--skip-import-existing", "do not import existing Studio-owned CDN redirects before refresh")
  .action(async (siteId: string, opts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(
        cmd,
        await refreshRedirectRules(supabase, siteId, {
          importExistingRedirects: !opts.skipImportExisting,
        }),
      );
    });
  });

redirects
  .command("bulk-create <siteId> <file>")
  .description("create redirects from a JSON array file")
  .option("--pull-zone-id <id>", "override pull zone ID")
  .option("--domain <domain>", "override redirect domain")
  .action(async (siteId: string, file: string, opts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await bulkCreateRedirects(supabase, siteId, file, opts));
    });
  });

const users = program.command("users").description("manage site users");

users
  .command("list <siteId>")
  .description("list users on a site")
  .action(async (siteId: string, _localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await listUsers(supabase, siteId));
    });
  });

users
  .command("invite <siteId> <email>")
  .description("invite a user to a site")
  .option("--role <role>", "WordPress role", "administrator")
  .option("--owner-account-id <id>", "account owner ID for team access")
  .action(async (siteId: string, email: string, opts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await inviteUser(supabase, siteId, email, opts.role, opts.ownerAccountId));
    });
  });

users
  .command("add <siteId> <email>")
  .description("add an existing Static Studio user to a site")
  .option("--user-id <id>", "known Supabase user ID")
  .option("--role <role>", "WordPress role", "administrator")
  .option("--owner-account-id <id>", "account owner ID for team access")
  .action(async (siteId: string, email: string, opts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(
        cmd,
        await addExistingUser(
          supabase,
          siteId,
          email,
          opts.role,
          opts.userId,
          opts.ownerAccountId,
        ),
      );
    });
  });

users
  .command("remove <siteId> <user>")
  .description("remove a user from a site")
  .option("--email <email>", "user email; only needed when <user> is a user ID that cannot be resolved")
  .action(async (siteId: string, user: string, opts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await removeUser(supabase, siteId, user, opts.email));
    });
  });

users
  .command("make-admin <siteId> <user>")
  .description("make a site user the admin")
  .action(async (siteId: string, user: string, _localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await makeAdmin(supabase, siteId, user));
    });
  });

users
  .command("set-admin <siteId> <user>")
  .description("make a site user the admin")
  .action(async (siteId: string, user: string, _localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await makeAdmin(supabase, siteId, user));
    });
  });

const team = program.command("team").description("manage account team members");

team
  .command("list")
  .description("list account team members")
  .option("--account-id <id>", "account owner ID; defaults to the authenticated user")
  .action(async (opts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase, user }) => {
      print(cmd, await listTeamMembers(supabase, opts.accountId || user.id));
    });
  });

team
  .command("invite [emails...]")
  .description("bulk add existing Studio users, optionally inviting missing users to owned sites")
  .option("--file <path>", "JSON, CSV, or newline-separated email list")
  .option("--role <role>", "WordPress role for site access", "editor")
  .option("--invite-missing", "send invites to emails that are not existing Studio users")
  .option("--max-emails <number>", "maximum unique emails to process", "100")
  .option("--account-id <id>", "account owner ID; defaults to the authenticated user")
  .action(async (emails: string[] | undefined, opts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase, user }) => {
      const maxEmails = parsePositiveInteger(opts.maxEmails, "max emails", { min: 1, max: 100 });
      const collectedEmails = await collectTeamEmails(emails, opts.file, maxEmails);
      print(cmd, await bulkInviteTeamMembers(supabase, opts.accountId || user.id, collectedEmails, {
        role: opts.role,
        inviteMissing: Boolean(opts.inviteMissing),
        maxEmails,
      }));
    });
  });

team
  .command("bulk-invite <file>")
  .description("bulk add or invite team members from a JSON, CSV, or newline-separated email file")
  .option("--role <role>", "WordPress role for site access", "editor")
  .option("--invite-missing", "send invites to emails that are not existing Studio users")
  .option("--max-emails <number>", "maximum unique emails to process", "100")
  .option("--account-id <id>", "account owner ID; defaults to the authenticated user")
  .action(async (file: string, opts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase, user }) => {
      const maxEmails = parsePositiveInteger(opts.maxEmails, "max emails", { min: 1, max: 100 });
      const emails = await parseEmailInputFile(file, maxEmails);
      print(cmd, await bulkInviteTeamMembers(supabase, opts.accountId || user.id, emails, {
        role: opts.role,
        inviteMissing: Boolean(opts.inviteMissing),
        maxEmails,
      }));
    });
  });

team
  .command("remove <memberId>")
  .description("remove a member from the account team and owned sites")
  .option("--email <email>", "member email; looked up by ID if omitted")
  .option("--account-id <id>", "account owner ID; defaults to the authenticated user")
  .option("-y, --yes", "skip confirmation")
  .action(async (memberId: string, opts: ParsedOptions, cmd: Command) => {
    if (!opts.yes && !(await confirm(`Remove team member ${memberId} from the account and owned sites?`))) {
      throw new CliError("Cancelled.", 0);
    }
    await withAuth(cmd, async ({ supabase, user }) => {
      print(cmd, await removeTeamMember(supabase, opts.accountId || user.id, memberId, opts.email));
    });
  });

const ssh = program.command("ssh").description("manage SSH/SFTP keys");

ssh
  .command("list [siteId]")
  .description("list SSH/SFTP keys, associations, and optional site connection state")
  .action(async (siteId: string | undefined, _localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase, user }) => {
      print(cmd, await getSshInfo(supabase, user.id, siteId));
    });
  });

ssh
  .command("add <siteId>")
  .description("queue a new SSH key and attach it to a site")
  .option("--key <publicKey>", "public key text")
  .option("--key-file <path>", "file containing the public key")
  .action(async (siteId: string, opts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase, user }) => {
      let publicKey = opts.key;
      if (!publicKey && opts.keyFile) {
        publicKey = (await readFile(opts.keyFile, "utf8")).trim();
      }
      if (!publicKey) throw new CliError("Provide --key or --key-file.");
      print(cmd, await queueSshKey(supabase, "add-ssh-key", siteId, user.id, { publicKey }));
    });
  });

ssh
  .command("connect <siteId> <keyId>")
  .description("queue attaching an existing SSH key to a site")
  .action(async (siteId: string, keyId: string, _localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase, user }) => {
      print(cmd, await queueSshKey(supabase, "add-ssh-key-to-site", siteId, user.id, { keyId }));
    });
  });

ssh
  .command("disconnect <siteId> <keyId>")
  .description("queue removing an SSH key from a site")
  .action(async (siteId: string, keyId: string, _localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase, user }) => {
      print(cmd, await queueSshKey(supabase, "remove-ssh-key-to-site", siteId, user.id, { keyId }));
    });
  });

ssh
  .command("delete <keyId>")
  .description("soft-delete a saved SSH key")
  .action(async (keyId: string, _localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase, user }) => {
      print(cmd, await deleteSshKey(supabase, user.id, keyId));
    });
  });

ssh
  .command("retry <siteId>")
  .description("retry Docker SFTP account reconciliation")
  .action(async (siteId: string, _localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase, user }) => {
      print(cmd, await retrySftpReconciliation(supabase, siteId, user.id));
    });
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const wantsJson = Boolean(program.opts().json);

  if (error instanceof CliError && error.exitCode === 0) {
    process.stderr.write(
      wantsJson ? `${JSON.stringify(cliErrorJson(error), null, 2)}\n` : `${error.message}\n`,
    );
    process.exit(0);
  }

  if (wantsJson) {
    process.stderr.write(`${JSON.stringify(cliErrorJson(error), null, 2)}\n`);
  } else {
    process.stderr.write(`Error: ${cliErrorMessage(error)}\n`);
  }
  process.exit(cliErrorExitCode(error));
});

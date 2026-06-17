#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Command } from "commander";
import { getAccountUsage } from "./account.js";
import { loginWithEmail, loginWithToken, logout } from "./auth.js";
import { getConfigPath } from "./config.js";
import { addDomain, getHostnames, issueSsl, removeDomain, setPrimaryDomain } from "./domains.js";
import {
  createEnvironment,
  deleteEnvironment,
  disableEnvironments,
  enableEnvironments,
  getEnvironmentStatus,
} from "./environments.js";
import { CliError, cliErrorExitCode, cliErrorJson, cliErrorMessage } from "./errors.js";
import { getDebugLog } from "./logs.js";
import { printValue } from "./output.js";
import { getSiteStatistics, listPerformanceReports, runPerformanceTest } from "./performance.js";
import { confirm } from "./prompt.js";
import { deleteSshKey, getSshInfo, listBackups, queueBackup, queueSshKey } from "./queues.js";
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
  deleteSite,
  generateSiteSeed,
  getBasicAuthCredentials,
  getChangesCount,
  getMagicLoginLink,
  getSite,
  getSiteMigrationSubdomain,
  listSites,
  pushSite,
  redeploySite,
  retryFailedDeployment,
  siteSummaryRows,
  updateSite,
} from "./sites.js";
import { getAuthContext, invokeFunction } from "./supabase.js";
import { assignTagToSite, createTag, deleteTag, listSiteTags, listTags, removeTagFromSite, updateTag } from "./tags.js";
import { bulkInviteTeamMembers, listTeamMembers, parseEmailInputFile, removeTeamMember } from "./team.js";
import { uploadMigrationFile } from "./upload.js";
import { addExistingUser, inviteUser, listUsers, makeAdmin, removeUser } from "./users.js";
import { normalizeEmailList, parsePositiveInteger } from "./validation.js";
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
  .option("--subdomain <subdomain>", "system-domain subdomain")
  .option("--tld <tld>", "system-domain TLD", "onstatic.studio")
  .option("--url <url>", "public site URL")
  .option("--admin-url <url>", "WordPress admin URL")
  .option("--bedrock", "create a Bedrock WordPress site")
  .option("--php-version <version>", "PHP version", "8.3")
  .option("--migration-file <path>", "upload a migration archive before queueing the site")
  .option("--allow-any-zip-name", "skip Static Studio backup ZIP filename check")
  .action(async (opts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase, user }) => {
      const seed = generateSiteSeed({
        name: opts.name,
        subdomain: opts.subdomain,
        tld: opts.tld,
        url: opts.url,
        adminUrl: opts.adminUrl,
      });

      let upload: unknown = null;
      if (opts.migrationFile) {
        process.stderr.write(`Uploading migration file to ${seed.subdomain}...\n`);
        upload = await uploadMigrationFile(supabase, {
          filePath: opts.migrationFile,
          subdomain: seed.subdomain,
          allowAnyZipName: Boolean(opts.allowAnyZipName),
          onProgress: ({ loaded, total }) => {
            if (!process.stderr.isTTY || !total) return;
            const pct = Math.min(100, Math.round((loaded / total) * 100));
            process.stderr.write(`\rUpload ${pct}%`);
          },
        });
        if (process.stderr.isTTY) process.stderr.write("\n");
      }

      const result = await createSite(supabase, {
        ...seed,
        email: user.email || "",
        userId: user.id,
        bedrock: Boolean(opts.bedrock),
        hasMigration: Boolean(opts.migrationFile),
        phpVersion: opts.phpVersion,
      });

      print(cmd, { ...result, upload });
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
  .command("issue-ssl <domain>")
  .description("request SSL issuance for a domain")
  .action(async (domain: string, _localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await issueSsl(supabase, domain));
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

const performance = program.command("performance").description("run and inspect performance data");

performance
  .command("run <siteId>")
  .description("run a PageSpeed and global TTFB performance test")
  .option("--force", "ignore cached PageSpeed report")
  .option("--url <url>", "test a URL instead of the stored site URL")
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
  .option("--url <url>", "test a URL instead of the stored site URL")
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
      await withAuth(cmd, async ({ supabase }) => {
        print(cmd, await queueBackup(supabase, action, siteId));
      });
    });
}

for (const action of ["restore", "delete"] as const) {
  backups
    .command(`${action} <siteId>`)
    .description(`queue backup ${action}`)
    .option("--backup-id <id>", "backup ID")
    .option("--date <date>", "backup date_string")
    .action(async (siteId: string, opts: ParsedOptions, cmd: Command) => {
      await withAuth(cmd, async ({ supabase }) => {
        print(cmd, await queueBackup(supabase, action, siteId, opts));
      });
    });
}

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
  .command("list")
  .description("list SSH keys and site associations")
  .action(async (_localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase, user }) => {
      print(cmd, await getSshInfo(supabase, user.id));
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

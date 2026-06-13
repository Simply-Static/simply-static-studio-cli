#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Command } from "commander";
import { loginWithEmail, loginWithToken, logout } from "./auth.js";
import { getConfigPath } from "./config.js";
import { addDomain, getHostnames, issueSsl, removeDomain, setPrimaryDomain } from "./domains.js";
import { CliError } from "./errors.js";
import { printValue } from "./output.js";
import { confirm } from "./prompt.js";
import { deleteSshKey, getSshInfo, listBackups, queueBackup, queueSshKey } from "./queues.js";
import { bulkCreateRedirects, createRedirect, deleteRedirect, listRedirects } from "./redirects.js";
import {
  clearCache,
  createSite,
  deleteSite,
  exportSite,
  generateSiteSeed,
  getChangesCount,
  getSite,
  getSiteMeta,
  getSiteMigrationSubdomain,
  listSites,
  redeploySite,
  retryFailedDeployment,
  siteSummaryRows,
  updateSite,
} from "./sites.js";
import { getAuthContext, invokeFunction } from "./supabase.js";
import { uploadMigrationFile } from "./upload.js";
import { addExistingUser, inviteUser, listUsers, makeAdmin, removeUser } from "./users.js";
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

program
  .command("login")
  .description("sign in with an email OTP or a platform access token")
  .option("--email <email>", "email address for OTP login")
  .option("--otp <code>", "email OTP code; useful for non-interactive usage")
  .option("--token <token>", "access token to store instead of starting OTP login")
  .option("--refresh-token <token>", "refresh token paired with --token")
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
  .command("credentials <siteId>")
  .description("show WordPress/admin credentials stored for the current user")
  .action(async (siteId: string, _localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase, user }) => {
      print(cmd, await getSiteMeta(supabase, siteId, user.email || undefined));
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
  .command("export <siteId>")
  .description("start a static export")
  .option("--type <type>", "export type: export or update", "export")
  .action(async (siteId: string, opts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      const type = opts.type === "update" ? "update" : "export";
      print(cmd, await exportSite(supabase, siteId, type));
    });
  });

sites
  .command("redeploy <siteId>")
  .description("redeploy an existing site")
  .option("--migration-file <path>", "upload a replacement migration archive before redeploying")
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
  .command("delete <siteId> <ruleId>")
  .description("disable a redirect edge rule")
  .option("--pull-zone-id <id>", "override pull zone ID")
  .action(async (siteId: string, ruleId: string, opts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await deleteRedirect(supabase, siteId, ruleId, opts.pullZoneId));
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
  .command("remove <siteId> <userId>")
  .description("remove a user from a site")
  .requiredOption("--email <email>", "user email")
  .action(async (siteId: string, userId: string, opts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await removeUser(supabase, siteId, userId, opts.email));
    });
  });

users
  .command("make-admin <siteId> <userId>")
  .description("make a site user the admin")
  .action(async (siteId: string, userId: string, _localOpts: ParsedOptions, cmd: Command) => {
    await withAuth(cmd, async ({ supabase }) => {
      print(cmd, await makeAdmin(supabase, siteId, userId));
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
  if (error instanceof CliError && error.exitCode === 0) {
    process.stderr.write(`${error.message}\n`);
    process.exit(0);
  }

  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exit(error instanceof CliError ? error.exitCode : 1);
});

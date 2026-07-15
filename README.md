# Static Studio CLI

Command-line interface for Static Studio hosting workflows. The package is intended for humans and coding agents such as Codex or Claude Code that need a narrow, scriptable interface to the Static Studio platform.

This documentation covers release `0.1.5`.

## Install

```bash
npm install -g @simply-static/static-studio
static-studio --help
```

During local development:

```bash
npm install
npm run build
node dist/cli.js --help
```

## Authentication

Interactive email OTP login:

```bash
static-studio login --email person@example.com
```

Personal Access Token login for CI or agents:

```bash
static-studio login --token "$STATIC_STUDIO_ACCESS_TOKEN"
```

Generate Personal Access Tokens in the Static Studio app under **Account -> Access Token**. Token issuance and exchange require an active subscription with quota greater than zero. Trial status alone does not categorically exclude an account; the subscription and quota checks are authoritative.

You can also skip local config entirely:

```bash
STATIC_STUDIO_ACCESS_TOKEN=... static-studio --json sites list
```

Sessions are stored in `~/.static-studio/config.json` with `0600` permissions. Use `--profile <name>` to keep separate accounts.

## Core Commands

```bash
static-studio whoami
static-studio status

static-studio sites list
static-studio sites get <siteId>
static-studio sites basic-auth <siteId>
static-studio sites magic-login <siteId>
static-studio sites debug-log <siteId> --tail 200
static-studio sites create --name Demo --mount-path /blog
static-studio sites create --name Import --migration-file ./site-studio-backup.zip
static-studio sites push <siteId> full
static-studio sites push <siteId> changes
static-studio sites redeploy <siteId> --migration-file ./site-studio-backup.zip
static-studio sites cancel-export <siteId> --yes
static-studio sites migration-log <siteId>
static-studio sites releases <siteId>
static-studio sites rollback-status <siteId>
static-studio sites rollback-snapshots <siteId>
static-studio sites rollback <siteId> <snapshotId> --yes
static-studio sites delete <siteId> --yes

static-studio domains list <siteId>
static-studio domains add <siteId> example.com
static-studio domains primary <siteId> example.com
static-studio domains mount <siteId> example.com /docs
static-studio domains issue-ssl <siteId> example.com
static-studio domains transfer <sourceSiteId> <targetSiteId> example.com --yes
static-studio domains remove <siteId> example.com

static-studio health overview <siteId>
static-studio health run <siteId> --checks uptime ssl sitemap

static-studio alerts status <siteId>
static-studio alerts save <siteId> --enabled on --recipients alerts@example.com
static-studio alerts test <siteId> alerts@example.com

static-studio seo list <siteId>
static-studio seo save <siteId> robots.txt --file ./robots.txt
static-studio seo check-sitemaps <siteId>

static-studio indexnow status <siteId>
static-studio indexnow enable <siteId>
static-studio indexnow auto-submit <siteId> on
static-studio indexnow submit <siteId>

static-studio reports list <siteId>
static-studio reports get <reportId>
static-studio reports generate-pdf <reportId>
static-studio reports pdf-url <reportId>
static-studio reports shares <reportId>
static-studio reports share <reportId> --recipient client@example.com --password-env REPORT_SHARE_PASSWORD
static-studio reports revoke-share <reportId> <shareId> --yes
static-studio reports schedules <siteId>
static-studio reports schedule monthly <siteId> --name "Monthly report"
static-studio reports disable-schedule <scheduleId>
static-studio reports delete-schedule <scheduleId> --yes

static-studio backups list <siteId> --refresh
static-studio backups create <siteId>
static-studio backups restore <siteId> --backup-id <backupId>

static-studio redirects create <siteId> /old /new
static-studio redirects update <siteId> <redirectId> --from-path /old --to-path /new
static-studio redirects disable <siteId> <redirectId>
static-studio redirects enable <siteId> <redirectId>
static-studio redirects bulk-create <siteId> redirects.json

static-studio users list <siteId>
static-studio users invite <siteId> person@example.com --role administrator
static-studio users add <siteId> person@example.com --role editor
static-studio users remove <siteId> person@example.com
static-studio users set-admin <siteId> person@example.com
static-studio team list
static-studio team invite person@example.com teammate@example.com --role editor --invite-missing
static-studio team bulk-invite emails.txt --role editor --invite-missing

static-studio account usage --include-subscription

static-studio performance run <siteId> --force
static-studio performance stats <siteId>
static-studio performance get <siteId>
static-studio performance reports <siteId>

static-studio logs get <siteId> --tail 200 --level error

static-studio environments list <siteId>
static-studio environments enable <siteId>
static-studio environments create <siteId> staging
static-studio environments delete <siteId> staging --yes
static-studio environments disable <siteId> --yes
static-studio environments domain-list <siteId> staging
static-studio environments domain-connect <siteId> staging staging.example.com
static-studio environments domain-ssl <siteId> staging staging.example.com
static-studio environments domain-remove <siteId> staging --yes

static-studio tags list
static-studio tags create Client --color '#3858E9'
static-studio tags assign <siteId> <tagId>
static-studio tags remove <siteId> <tagId>

static-studio ssh add <siteId> --key-file ~/.ssh/id_ed25519.pub
```

New sites use managed Studio URLs and server-generated WordPress, Basic Auth, and secret credentials. Migration archives are uploaded with presigned multipart requests in 25 MiB parts, up to the 10 GB limit.

The `--url` option on `performance run` and `performance get` is deprecated. If supplied for compatibility, it must resolve to the site's stored URL.

WordPress role options support `administrator`, `editor`, `author`, and `contributor`; `subscriber` is not supported.

Reports and configurable Site Health alerts require the corresponding Agency entitlements. Lagos enforces these entitlements and site access for every operation.

## Documentation

Detailed CLI documentation lives in [`docs/`](docs/README.md):

- [`docs/authentication-and-configuration.md`](docs/authentication-and-configuration.md)
- [`docs/command-reference.md`](docs/command-reference.md)
- [`docs/input-formats-and-limits.md`](docs/input-formats-and-limits.md)
- [`docs/workflows.md`](docs/workflows.md)

## Development

```bash
npm run typecheck
npm test
npm run build
npm audit
```

The CLI is implemented in TypeScript, bundles to ESM with `tsup`, and exports a reusable client/workflow layer from `src/index.ts`.

CI runs type checking, tests, build, and `npm audit --audit-level=high` on every push and pull request.

## Publishing

This package is scoped and intended to be public on npm. Before publishing, make sure the npm account has publish access to the `@simply-static` organization.

```bash
npm login
npm ci
npm run typecheck
npm test
npm run build
npm audit --audit-level=high
npm pack --dry-run
npm publish --access public
```

The package version and changelog must already be updated before this checklist. Use `npm version patch` when starting the next release, not after a version has been prepared.

# Static Studio CLI

Command-line interface for Static Studio hosting workflows. The package is intended for humans and coding agents such as Codex or Claude Code that need a narrow, scriptable interface to the Static Studio platform.

## Install

```bash
npm install -g @simply-static/studio-cli
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

Token login for CI or agents:

```bash
static-studio login --token "$STATIC_STUDIO_ACCESS_TOKEN"
```

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
static-studio sites create --name Demo --subdomain demo123
static-studio sites create --name Import --migration-file ./site-studio-backup.zip
static-studio sites export <siteId>
static-studio sites redeploy <siteId>
static-studio sites redeploy <siteId> --migration-file ./site-studio-backup.zip
static-studio sites delete <siteId> --yes

static-studio domains list <siteId>
static-studio domains add <siteId> example.com
static-studio domains primary <siteId> example.com
static-studio domains remove <siteId> example.com

static-studio backups list <siteId> --refresh
static-studio backups create <siteId>
static-studio backups restore <siteId> --backup-id <backupId>

static-studio redirects create <siteId> /old /new
static-studio redirects bulk-create <siteId> redirects.json

static-studio users invite <siteId> person@example.com --role administrator
static-studio ssh add <siteId> --key-file ~/.ssh/id_ed25519.pub
```

## Development

```bash
npm run typecheck
npm test
npm run build
npm audit
```

The CLI is implemented in TypeScript, bundles to ESM with `tsup`, and exports a reusable client/workflow layer from `src/index.ts`.

## Publishing

This package is scoped and intended to be public on npm. Before publishing, make sure the npm account has publish access to the `@simply-static` organization.

```bash
npm login
npm version patch
npm publish --access public
```

Use `npm pack --dry-run` to inspect exactly which files will be published.

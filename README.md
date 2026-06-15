# Static Studio CLI

Command-line interface for Static Studio hosting workflows. The package is intended for humans and coding agents such as Codex or Claude Code that need a narrow, scriptable interface to the Static Studio platform.

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
static-studio sites basic-auth <siteId>
static-studio sites magic-login <siteId>
static-studio sites debug-log <siteId> --tail 200
static-studio sites create --name Demo --subdomain demo123
static-studio sites create --name Import --migration-file ./site-studio-backup.zip
static-studio sites push <siteId> full
static-studio sites push <siteId> changes
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

static-studio tags list
static-studio tags create Client --color '#3858E9'
static-studio tags assign <siteId> <tagId>
static-studio tags remove <siteId> <tagId>

static-studio ssh add <siteId> --key-file ~/.ssh/id_ed25519.pub
```

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
npm version patch
npm publish --access public
```

Use `npm pack --dry-run` to inspect exactly which files will be published.

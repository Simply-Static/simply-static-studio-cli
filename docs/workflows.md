# Workflows

These examples show common CLI workflows. Add `--json` to any command when scripting or when another program will parse the output.

## Authenticate

Interactive email OTP:

```bash
static-studio login --email person@example.com
static-studio whoami
```

CI or agent usage:

```bash
STATIC_STUDIO_ACCESS_TOKEN=... static-studio --json sites list
```

Multiple accounts:

```bash
static-studio --profile client-a login --email admin@client-a.test
static-studio --profile client-b login --email admin@client-b.test
static-studio --profile client-a sites list
```

## Create a Site

Create a generated site:

```bash
static-studio sites create --name "Demo"
```

Create a specific system-domain site:

```bash
static-studio sites create \
  --name "Demo" \
  --subdomain demo123 \
  --tld onstatic.studio \
  --php-version 8.3
```

Create from a migration archive:

```bash
static-studio sites create \
  --name "Imported Site" \
  --subdomain imported-site \
  --migration-file ./studio-backup-imported-site.zip
```

The create response includes the site record, queue result, generated WordPress credentials, generated Basic Auth credentials, and optional upload metadata.

## Operate a Site

Inspect site details:

```bash
static-studio sites list --search demo
static-studio sites get <siteId>
static-studio sites basic-auth <siteId>
static-studio sites magic-login <siteId>
```

Push changes:

```bash
static-studio sites push <siteId> full
static-studio sites push <siteId> changes
```

Recover or maintain:

```bash
static-studio sites retry <siteId>
static-studio sites changes <siteId>
static-studio sites clear-cache <siteId>
static-studio sites delete <siteId> --yes
```

Redeploy from a replacement migration archive:

```bash
static-studio sites redeploy <siteId> --migration-file ./studio-backup-site.zip
```

## Domains and SSL

```bash
static-studio domains list <siteId>
static-studio domains add <siteId> example.com
static-studio domains primary <siteId> example.com
static-studio domains issue-ssl example.com
static-studio domains remove <siteId> old.example.com
```

Adding or changing the primary domain starts an export.

## Backups

```bash
static-studio backups list <siteId> --refresh
static-studio backups create <siteId>
static-studio backups sync <siteId>
static-studio backups restore <siteId> --backup-id <backupId>
static-studio backups delete <siteId> --date 2026-06-14
```

Restore and delete accept either `--backup-id` or `--date`.

## Redirects

Create one redirect:

```bash
static-studio redirects create <siteId> /old-page /new-page
```

Create redirects from a file:

```bash
static-studio redirects bulk-create <siteId> redirects.json
```

List and remove redirect rules:

```bash
static-studio redirects list <siteId>
static-studio redirects delete <siteId> <ruleId>
```

## Users and Team Members

Site user operations:

```bash
static-studio users list <siteId>
static-studio users invite <siteId> person@example.com --role administrator
static-studio users add <siteId> existing@example.com --role editor
static-studio users set-admin <siteId> existing@example.com
static-studio users remove <siteId> existing@example.com
```

Account team operations:

```bash
static-studio team list
static-studio team invite person@example.com teammate@example.com --role editor --invite-missing
static-studio team bulk-invite emails.txt --role editor --invite-missing
static-studio team remove <memberId> --yes
```

Team invite commands add existing Static Studio users to the account team, grant access to owned sites, and optionally send site invites for missing users.

## Performance

Run a PageSpeed/global TTFB test:

```bash
static-studio performance run <siteId> --force
```

Fetch CDN statistics:

```bash
static-studio performance stats <siteId>
```

Fetch both:

```bash
static-studio performance get <siteId> --url https://example.com/
```

List cached reports:

```bash
static-studio performance reports <siteId> --limit 20
```

## Logs

Fetch recent errors:

```bash
static-studio logs get <siteId> --tail 200 --level error
```

Search logs:

```bash
static-studio logs get <siteId> --search "fatal error" --newest-first
```

Write logs to a file:

```bash
static-studio logs get <siteId> --tail 1000 --output-file ./debug.log
```

The command refuses local/private targets and HTTP by default. Use the explicit allow flags only for trusted local testing.

## Environments

```bash
static-studio environments list <siteId>
static-studio environments enable <siteId>
static-studio environments create <siteId> staging
static-studio environments delete <siteId> staging --yes
static-studio environments disable <siteId> --yes
```

Disabling environments deletes child environments and removes the add-on flag.

## Tags

```bash
static-studio tags list
static-studio tags create Client --color '#3858E9'
static-studio tags assign <siteId> <tagId>
static-studio tags site <siteId>
static-studio tags update <tagId> --name "Important Client" --color '#008A20'
static-studio tags remove <siteId> <tagId>
static-studio tags delete <tagId> --yes
```

## SSH/SFTP Keys

```bash
static-studio ssh list
static-studio ssh add <siteId> --key-file ~/.ssh/id_ed25519.pub
static-studio ssh connect <siteId> <keyId>
static-studio ssh disconnect <siteId> <keyId>
static-studio ssh delete <keyId>
```

`ssh add` queues both key creation and attachment to the target site.

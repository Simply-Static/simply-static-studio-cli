# Workflows

These examples show common CLI workflows. Add `--json` to any command when scripting or when another program will parse the output.

## Authenticate

Interactive email OTP:

```bash
static-studio login --email person@example.com
static-studio whoami
```

The CLI prints a local Cloudflare Turnstile challenge URL and attempts to open
it before requesting the email code. Use `--no-browser` to skip automatic
launch, or `--captcha-token <token>` when a trusted integration already has a
short-lived Turnstile token.

CI or agent usage:

```bash
STATIC_STUDIO_ACCESS_TOKEN=... static-studio --json sites list
```

Generate the token in Static Studio under **Account -> Access Token**. Token issuance and exchange require an active subscription with quota greater than zero; trial status alone does not exclude an otherwise eligible account. Pass a Personal Access Token without a refresh token.

Personal Access Token and saved Supabase session login do not use the
Turnstile browser flow.

Multiple accounts:

```bash
static-studio --profile client-a login --email admin@client-a.test
static-studio --profile client-b login --email admin@client-b.test
static-studio --profile client-a sites list
```

## Create a Site

Create from a migration archive:

```bash
static-studio sites create \
  --name "Imported Site" \
  --mount-path /blog \
  --php-version 8.3 \
  --migration-file ./studio-backup-imported-site.zip
```

If the upload finalized but site creation could not be confirmed, first check `sites list`, then reuse the reported artifact without uploading again:

```bash
static-studio sites create \
  --name "Imported Site" \
  --migration-artifact-id <artifact-id>
```

Studio has temporarily disabled empty-site creation for abuse control, so one
of `--migration-file` or `--migration-artifact-id` is required.

Studio assigns the Docker provider and generates an opaque, immutable identity for each new site. That identity is shared by the managed static hostname and provisioning resources, and is never derived from the editable site name. The site-record service normally queues provisioning and returns its job in the create response; the CLI uses the dedicated queue endpoint only as a fallback. Add a custom domain after provisioning; the managed hostname remains connected as the fallback. The create response includes the site record, platform queue result, approved Basic Auth/helper credentials, and optional private artifact metadata. Use `sites magic-login` instead of a WordPress administrator password. Migration files use private multipart upload in 25 MiB parts, direct signed completion, and server-side finalization, and may be up to 10 GB.

Supported PHP versions are `7.4`, `8.1`, `8.2`, `8.3`, and `8.4`.
Migration files may be `.zip`, `.tar.gz`, `.tgz`, `.wpress`, or `.daf`.

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
static-studio sites cancel-export <siteId> --yes
static-studio sites delete <siteId> --yes
```

Control the Docker WordPress runtime:

```bash
static-studio sites runtime-status <siteId>
static-studio sites start <siteId>
static-studio sites stop <siteId>
```

Redeploy without replacing content:

```bash
static-studio sites redeploy <siteId>
```

Redeploy from a replacement migration archive, or reuse an already-finalized
artifact after an interrupted request:

```bash
static-studio sites redeploy <siteId> --migration-file ./studio-backup-site.zip
static-studio sites redeploy <siteId> --migration-artifact-id <artifact-id>
```

Replacement uploads are private platform artifacts bound to the target site.
The file and artifact-ID options are mutually exclusive.

Inspect releases and roll back the static site:

```bash
static-studio sites releases <siteId> --limit 10
static-studio sites rollback-status <siteId>
static-studio sites rollback-snapshots <siteId>
static-studio sites rollback <siteId> <snapshotId> --yes
```

Use a snapshot returned by the status or snapshots command. Rollback changes the static export; it does not restore WordPress content.

## Domains and SSL

```bash
static-studio domains list <siteId>
static-studio domains add <siteId> example.com
static-studio domains add <siteId> example.com --prepare-only
static-studio domains primary <siteId> example.com
static-studio domains mount <siteId> example.com /docs
static-studio domains issue-ssl <siteId> example.com
static-studio domains remove <siteId> old.example.com
```

Adding or changing the primary domain starts an export. A normal `domains add`
starts WordPress when necessary, connects the hostname, requests SSL, registers
ownership, and refreshes routing. Use `--prepare-only` to prepare WordPress and
start the export before DNS points to Studio, without attaching the CDN
hostname, issuing SSL, registering ownership, or refreshing edge routing. Run
the command again without the flag to finish the connection.

Move a domain between two sites when you administer both:

```bash
static-studio domains transfer <sourceSiteId> <targetSiteId> example.com --yes
```

The legacy SSL syntax remains available as `static-studio domains issue-ssl example.com --site-id <siteId>`.

## Backups

```bash
static-studio backups list <siteId>
static-studio backups create <siteId>
static-studio backups get <siteId> <backupId>
static-studio backups restore <siteId> --backup-id <backupId> --yes
static-studio backups delete <siteId> --backup-id <backupId> --yes
static-studio backups download <siteId> <backupId>
static-studio backups policy <siteId>
static-studio backups policy <siteId> daily
```

Platform backup artifacts use UUIDs and are listed directly. To copy a ready
artifact into another platform site:

```bash
static-studio backups copy <siteId> <backupId> <targetSiteId> --yes
```

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
static-studio redirects delete <siteId> <redirectId>
```

Edit and toggle DB-backed redirects:

```bash
static-studio redirects update <siteId> <redirectId> --from-path /old-page --to-path /new-page
static-studio redirects disable <siteId> <redirectId>
static-studio redirects enable <siteId> <redirectId>
```

Import older Studio-owned CDN redirect rules so they can be managed by ID:

```bash
static-studio redirects refresh <siteId>
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

Supported WordPress roles are `administrator`, `editor`, `author`, and `contributor`; `subscriber` is not accepted.

## Site Health

Inspect persisted health and deployment state:

```bash
static-studio health overview <siteId>
```

Run every check, or select checks for up to 25 sites:

```bash
static-studio health run <siteId>
static-studio health run <siteIdA> <siteIdB> --checks uptime ssl sitemap indexability
```

Check names are `uptime`, `response_time`, `ssl`, `dns`, `cdn`, `static_freshness`, `robots`, `sitemap`, `indexability`, and `ai_readiness`.

Configure and test Agency Site Health alerts:

```bash
static-studio alerts status <siteId>
static-studio alerts save <siteId> \
  --enabled on \
  --recipients ops@example.com owner@example.com \
  --uptime on \
  --uptime-threshold 10 \
  --performance on \
  --performance-threshold 70 \
  --seo-critical on \
  --notify-on-recovery on
static-studio alerts test <siteId> ops@example.com
```

Enabled alerts require at least one of the three rules and 1 to 10 recipients. These commands require the Lagos Agency alert entitlement and site manage access.

## SEO Files and IndexNow

Manage root-level SEO files and verify sitemaps:

```bash
static-studio seo list <siteId>
static-studio seo save <siteId> robots.txt --file ./robots.txt
static-studio seo save <siteId> llms.txt --content "# Example"
static-studio seo apply <siteId>
static-studio seo check-sitemaps <siteId>
static-studio seo delete <siteId> llms.txt --yes
```

Enable IndexNow, configure automatic submissions, or submit the latest release manually:

```bash
static-studio indexnow status <siteId>
static-studio indexnow enable <siteId>
static-studio indexnow auto-submit <siteId> on
static-studio indexnow submit <siteId>
static-studio indexnow submit <siteId> --release-id <releaseId>
static-studio indexnow disable <siteId>
```

## Agency Reports

Inspect stored reports and generate PDF artifacts:

```bash
static-studio reports list <siteId> --limit 20
static-studio reports get <reportId>
static-studio reports generate-pdf <reportId>
static-studio reports pdf-url <reportId>
```

Create and manage a client share link:

```bash
# Configure REPORT_SHARE_PASSWORD through your shell or secret manager first.
static-studio reports share <reportId> \
  --recipient client@example.com \
  --password-env REPORT_SHARE_PASSWORD \
  --expires-at 2099-12-31T23:59:59Z
static-studio reports shares <reportId>
static-studio reports revoke-share <reportId> <shareId> --yes
```

The CLI never accepts the share password as a plaintext argument.

Create a schedule for one site or an Agency portfolio:

```bash
static-studio reports schedules [siteId]
static-studio reports schedule monthly <siteId> --name "Monthly client report"
static-studio reports schedule weekly <siteIdA> <siteIdB> \
  --auto-share on \
  --recipient client@example.com
static-studio reports disable-schedule <scheduleId>
static-studio reports delete-schedule <scheduleId> --yes
```

Schedules accept `weekly` or `monthly` and at most 100 site IDs. PDF, sharing, history, and schedule operations require the corresponding Lagos Agency entitlements.

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
static-studio performance get <siteId> --force
```

The deprecated `--url` option is accepted only when it normalizes to the site's stored URL; it can no longer select a different performance target.

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

Manage a child environment's custom domain after the parent site is fully deployed:

```bash
static-studio environments domain-list <siteId> staging
static-studio environments domain-connect <siteId> staging staging.example.com
static-studio environments domain-ssl <siteId> staging staging.example.com
static-studio environments domain-remove <siteId> staging --yes
```

Each environment keeps its managed Studio hostname and can have one custom hostname. Connecting another replaces the current custom hostname. Removing it restores the managed hostname as the WordPress and edge-routing fallback.

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
static-studio ssh list <siteId>
static-studio ssh add <siteId> --key-file ~/.ssh/id_ed25519.pub
static-studio ssh connect <siteId> <keyId>
static-studio ssh disconnect <siteId> <keyId>
static-studio ssh delete <keyId>
static-studio ssh retry <siteId>
```

`ssh add` queues both key creation and attachment to the target site. Supplying a site ID to `ssh list` returns the provider-bound SSH/SFTP connection snapshot.

# Command Reference

All commands support the global `--json` and `--profile <name>` options. The `sss` binary is an alias for `static-studio`.

## Root Commands

### `login`

Sign in with email OTP, store a Personal Access Token, or store a Supabase session token pair.

```bash
static-studio login [--email <email>] [--otp <code>] [--token <token>] [--refresh-token <token>] [--create-user]
```

If `--token` is present, token login is used. Personal Access Tokens are generated in the Static Studio app under **Account -> Access Token**, require an active paid subscription, and should be passed without `--refresh-token`. `--refresh-token` is only for Supabase session access tokens. Otherwise the CLI starts email OTP login.

### `logout`

Remove the saved local session for the selected profile.

```bash
static-studio logout
```

### `whoami`

Show the authenticated Static Studio user.

```bash
static-studio whoami
```

### `status`

Check platform status integrations.

```bash
static-studio status
```

## Sites

### `sites list`

List sites visible to the authenticated user.

```bash
static-studio sites list [--page <number>] [--page-size <number>] [--search <term>] [--sort <field>] [--asc]
```

| Option | Default | Description |
| --- | --- | --- |
| `--page <number>` | `1` | Page number, 1 to 10000. |
| `--page-size <number>` | `20` | Rows per page, 1 to 100. |
| `--search <term>` | none | Filter by site name or URL. |
| `--sort <field>` | `created_at` | One of `id`, `name`, `url`, `status`, `created_at`, `updated_at`. |
| `--asc` | off | Sort ascending instead of descending. |

Non-JSON output shows summary rows with `id`, `name`, `url`, `status`, and `created_at`.

### `sites get`

Show a single site record.

```bash
static-studio sites get <siteId>
```

### `sites basic-auth`

Show Basic Auth credentials for a site.

```bash
static-studio sites basic-auth <siteId> [--email <email>]
```

`--email` selects a specific `site_meta` email. By default, the authenticated user's email is used.

### `sites magic-login`

Generate a short-lived WordPress magic login link.

```bash
static-studio sites magic-login <siteId> [--email <email>]
```

Non-JSON output prints only the URL. JSON output includes `url`, `siteId`, `staticSiteId`, and `email`.

### `sites debug-log`

Fetch the WordPress debug log for a site.

```bash
static-studio sites debug-log <siteId> [options]
```

This is equivalent to `logs get <siteId>`.

| Option | Default | Description |
| --- | --- | --- |
| `--tail <lines>` | none | Return the last N lines, 1 to 10000. |
| `--level <level>` | `all` | One of `all`, `error`, `warning`, `notice`, `info`. |
| `--search <term>` | none | Return only lines containing the text, case-insensitive. |
| `--newest-first` | off | Reverse log lines before printing. |
| `--output-file <path>` | none | Write log text to a local file with `0600` permissions. |
| `--overwrite` | off | Replace `--output-file` if it exists. |
| `--timeout <seconds>` | `30` | Network timeout. Effective allowed range is 1 to 120 seconds. |
| `--max-bytes <bytes>` | `5242880` | Maximum response size. Allowed range is 1024 bytes to 20 MiB. |
| `--allow-insecure-http` | off | Allow fetching logs over HTTP. Intended only for trusted local testing. |
| `--allow-private-network` | off | Allow local or private network hosts. Intended only for trusted local testing. |

When `--output-file` is used without `--json`, stdout contains metadata and the log is written to the file. With `--json`, stdout includes metadata and the log content.

### `sites create`

Create and queue a new Static Studio site.

```bash
static-studio sites create [options]
```

| Option | Default | Description |
| --- | --- | --- |
| `--name <name>` | generated | Site display name. |
| `--subdomain <subdomain>` | generated | System-domain subdomain. |
| `--tld <tld>` | `onstatic.studio` | System-domain TLD. |
| `--url <url>` | derived | Public site URL. |
| `--admin-url <url>` | derived | WordPress admin URL. |
| `--bedrock` | off | Create a Bedrock WordPress site. |
| `--php-version <version>` | `8.3` | PHP version for the queued site. |
| `--migration-file <path>` | none | Upload a migration archive before queueing the site. |
| `--allow-any-zip-name` | off | Skip Static Studio backup ZIP filename validation. |

If `--migration-file` is supplied, the CLI uploads the file before queueing the site and prints upload metadata with the created site, queue result, and generated credentials.

### `sites update`

Update site metadata.

```bash
static-studio sites update <siteId> [--name <name>] [--notes <notes>] [--status <status>]
```

At least one update option is required.

### `sites delete`

Queue site deletion.

```bash
static-studio sites delete <siteId> [--yes]
```

Prompts for confirmation unless `--yes` is supplied.

### `sites push`

Push a static site export.

```bash
static-studio sites push <siteId> [mode]
```

`mode` defaults to `full`. Accepted modes are `full`, `export`, `changes`, and `update`. `full` and `export` queue a full export. `changes` and `update` queue an incremental update.

### `sites redeploy`

Redeploy an existing site after uploading a replacement migration archive.

```bash
static-studio sites redeploy <siteId> --migration-file <path> [--allow-any-zip-name]
```

### `sites retry`

Retry a failed deployment.

```bash
static-studio sites retry <siteId>
```

### `sites changes`

Show the pending WordPress change count.

```bash
static-studio sites changes <siteId>
```

### `sites clear-cache`

Clear the CDN cache for a site.

```bash
static-studio sites clear-cache <siteId>
```

## Domains

### `domains list`

List CDN hostnames for a site.

```bash
static-studio domains list <siteId>
```

The site must have a `pull_zone_id`.

### `domains add`

Add a custom domain and start an export.

```bash
static-studio domains add <siteId> <domain>
```

### `domains primary`

Set the primary custom domain and start an export.

```bash
static-studio domains primary <siteId> <domain>
```

### `domains remove`

Remove a custom domain.

```bash
static-studio domains remove <siteId> <domain>
```

### `domains issue-ssl`

Request SSL issuance for a domain.

```bash
static-studio domains issue-ssl <domain>
```

## Account

### `account usage`

Show account storage, bandwidth, and site counts.

```bash
static-studio account usage [--account-id <id>] [--include-subscription]
```

| Option | Description |
| --- | --- |
| `--account-id <id>` | Account owner ID. Defaults to the authenticated user. |
| `--include-subscription` | Include the latest subscription row. |

## Performance

### `performance run`

Run a PageSpeed and global TTFB performance test.

```bash
static-studio performance run <siteId> [--force] [--url <url>]
```

| Option | Description |
| --- | --- |
| `--force` | Ignore cached PageSpeed reports. |
| `--url <url>` | Test a URL instead of the stored site URL. Must use HTTP or HTTPS. |

### `performance stats`

Get CDN bandwidth, storage, cache, and response-time statistics.

```bash
static-studio performance stats <siteId>
```

The site must have a `pull_zone_id`.

### `performance get`

Run a performance test and fetch CDN statistics in one command.

```bash
static-studio performance get <siteId> [--force] [--url <url>]
```

### `performance reports`

List cached PageSpeed reports.

```bash
static-studio performance reports <siteId> [--limit <number>]
```

`--limit` defaults to `10` and must be between 1 and 100.

## Logs

### `logs get`

Fetch the WordPress debug log for a site.

```bash
static-studio logs get <siteId> [options]
```

Options are the same as `sites debug-log`.

## Environments

### `environments list`

List environments and add-on status.

```bash
static-studio environments list <siteId>
```

### `environments enable`

Enable environment management for a site.

```bash
static-studio environments enable <siteId>
```

### `environments create`

Create a child environment.

```bash
static-studio environments create <siteId> <name>
```

### `environments delete`

Delete a child environment.

```bash
static-studio environments delete <siteId> <name> [--yes]
```

Prompts for confirmation unless `--yes` is supplied. The `production` environment cannot be deleted as a child environment.

### `environments disable`

Disable environments and remove child environments.

```bash
static-studio environments disable <siteId> [--yes]
```

Prompts for confirmation unless `--yes` is supplied.

## Tags

### `tags list`

List account tags.

```bash
static-studio tags list [--account-id <id>]
```

`--account-id` defaults to the authenticated user.

### `tags site`

List tags assigned to a site.

```bash
static-studio tags site <siteId>
```

### `tags create`

Create an account tag.

```bash
static-studio tags create <name> [--color <hex>] [--account-id <id>]
```

`--color` defaults to `#3858E9`. `--account-id` defaults to the authenticated user.

### `tags update`

Update a tag name or color.

```bash
static-studio tags update <tagId> [--name <name>] [--color <hex>]
```

At least one update option is required.

### `tags delete`

Delete a tag.

```bash
static-studio tags delete <tagId> [--yes]
```

Prompts for confirmation unless `--yes` is supplied.

### `tags assign`

Assign a tag to a site.

```bash
static-studio tags assign <siteId> <tagId>
```

### `tags remove`

Remove a tag from a site.

```bash
static-studio tags remove <siteId> <tagId>
```

## Backups

### `backups list`

List cached backups.

```bash
static-studio backups list <siteId> [--refresh]
```

`--refresh` queues a backup sync before listing.

### `backups create`

Queue backup creation.

```bash
static-studio backups create <siteId>
```

### `backups sync`

Queue backup sync.

```bash
static-studio backups sync <siteId>
```

### `backups restore`

Queue backup restore.

```bash
static-studio backups restore <siteId> [--backup-id <id>] [--date <date>]
```

### `backups delete`

Queue backup deletion.

```bash
static-studio backups delete <siteId> [--backup-id <id>] [--date <date>]
```

## Redirects

### `redirects list`

List redirect rules.

```bash
static-studio redirects list <siteId> [--pull-zone-id <id>]
```

Use DB-backed redirect IDs from the `dbRedirects` response for update, enable, disable, and DB delete operations.

### `redirects create`

Create a 301 redirect.

```bash
static-studio redirects create <siteId> <fromPath> <toPath> [--pull-zone-id <id>] [--domain <domain>]
```

By default, the pull zone and domain are resolved from the site.

### `redirects update`

Update a DB-backed redirect. `redirects edit` is an alias.

```bash
static-studio redirects update <siteId> <redirectId> [--from-path <path>] [--to-path <path>] [--active|--inactive]
```

At least one field is required. Default redirects can only be enabled or disabled.

### `redirects enable`

Enable a DB-backed redirect.

```bash
static-studio redirects enable <siteId> <redirectId>
```

### `redirects disable`

Disable a DB-backed redirect.

```bash
static-studio redirects disable <siteId> <redirectId>
```

### `redirects delete`

Delete a DB-backed redirect, or disable a legacy CDN edge rule.

```bash
static-studio redirects delete <siteId> <redirectId> [--db] [--edge-rule] [--pull-zone-id <id>]
```

By default, the CLI treats the ID as a DB redirect ID and falls back to a legacy edge rule when the DB redirect is not found. Use `--edge-rule` to force the legacy CDN path.

After deleting or disabling the rule, the CLI refreshes edge rules for the site.

### `redirects refresh`

Refresh redirect edge rules from stored redirects.

```bash
static-studio redirects refresh <siteId> [--skip-import-existing]
```

By default, existing Studio-owned CDN redirects are imported before the refresh so older redirects can be managed through DB-backed commands. Use `--skip-import-existing` after out-of-band cleanup when you do not want CDN rules imported.

### `redirects bulk-create`

Create redirects from a JSON array file.

```bash
static-studio redirects bulk-create <siteId> <file> [--pull-zone-id <id>] [--domain <domain>]
```

See [Input formats and limits](input-formats-and-limits.md#bulk-redirect-files) for the file format.

## Users

### `users list`

List users on a site.

```bash
static-studio users list <siteId>
```

### `users invite`

Invite a user to a site.

```bash
static-studio users invite <siteId> <email> [--role <role>] [--owner-account-id <id>]
```

`--role` defaults to `administrator`.

### `users add`

Add an existing Static Studio user to a site.

```bash
static-studio users add <siteId> <email> [--user-id <id>] [--role <role>] [--owner-account-id <id>]
```

If `--user-id` is omitted, the CLI resolves the user by email. If no Static Studio user exists, use `users invite` instead.

### `users remove`

Remove a user from a site.

```bash
static-studio users remove <siteId> <user> [--email <email>]
```

`<user>` may be an email or user ID. `--email` is only needed when `<user>` is a user ID that cannot be resolved.

### `users make-admin`

Make a site user the admin.

```bash
static-studio users make-admin <siteId> <user>
```

`<user>` may be an email or user ID.

### `users set-admin`

Alias for `users make-admin`.

```bash
static-studio users set-admin <siteId> <user>
```

## Team

### `team list`

List account team members.

```bash
static-studio team list [--account-id <id>]
```

`--account-id` defaults to the authenticated user.

### `team invite`

Bulk add existing Studio users, optionally inviting missing users to owned sites.

```bash
static-studio team invite [emails...] [--file <path>] [--role <role>] [--invite-missing] [--max-emails <number>] [--account-id <id>]
```

| Option | Default | Description |
| --- | --- | --- |
| `--file <path>` | none | JSON, CSV, or newline-separated email list. |
| `--role <role>` | `editor` | WordPress role for site access. |
| `--invite-missing` | off | Send invites to emails that are not existing Studio users. |
| `--max-emails <number>` | `100` | Maximum unique emails to process, 1 to 100. |
| `--account-id <id>` | current user | Account owner ID. |

Emails from positional arguments and `--file` are combined, normalized, deduplicated, and capped by `--max-emails`.

### `team bulk-invite`

Bulk add or invite team members from a file.

```bash
static-studio team bulk-invite <file> [--role <role>] [--invite-missing] [--max-emails <number>] [--account-id <id>]
```

Options are the same as `team invite`, except the file is required as a positional argument.

### `team remove`

Remove a member from the account team and owned sites.

```bash
static-studio team remove <memberId> [--email <email>] [--account-id <id>] [--yes]
```

Prompts for confirmation unless `--yes` is supplied. If `--email` is omitted, the CLI looks up the email by member ID.

## SSH

### `ssh list`

List SSH keys and site associations.

```bash
static-studio ssh list
```

### `ssh add`

Queue a new SSH key and attach it to a site.

```bash
static-studio ssh add <siteId> (--key <publicKey> | --key-file <path>)
```

One of `--key` or `--key-file` is required.

### `ssh connect`

Queue attaching an existing SSH key to a site.

```bash
static-studio ssh connect <siteId> <keyId>
```

`keyId` must be a positive integer.

### `ssh disconnect`

Queue removing an SSH key from a site.

```bash
static-studio ssh disconnect <siteId> <keyId>
```

`keyId` must be a positive integer.

### `ssh delete`

Soft-delete a saved SSH key.

```bash
static-studio ssh delete <keyId>
```

# Input Formats and Limits

This page documents validation rules enforced by the CLI before requests are sent to Static Studio.

## IDs

Most IDs passed as arguments or options must contain only:

```text
letters, numbers, underscores, hyphens
```

IDs are trimmed and must be 1 to 128 characters long.

Examples:

```bash
static-studio sites get 12345
static-studio tags assign site_123 tag-abc
```

## Emails

Emails are trimmed, lowercased, and validated. Email lists are deduplicated after normalization.

Site Health alerts accept at most 10 unique recipients. An enabled alert configuration requires at least one recipient; `alerts test` always requires at least one.

WordPress role options accept:

```text
administrator, editor, author, contributor
```

`subscriber` is not supported. `users invite` and `users add` default to `administrator`. Team invite commands default to `editor`.

## Alert Settings

Alert site IDs must be positive safe integers. `alerts save --enabled on` requires at least one of the uptime, performance, or critical SEO rules to be on.

| Setting | Allowed value |
| --- | --- |
| Uptime threshold | Integer from 5 to 1440 minutes |
| Performance threshold | Integer from 1 to 100 |
| Recipients | 1 to 10 unique valid emails when enabled |

Alert toggles accept `on`/`off`, `true`/`false`, `yes`/`no`, and `1`/`0`. Configurable alerts require the Lagos Agency alert entitlement.

## Report Inputs

Report site IDs must be positive safe integers. Report, share, and schedule record IDs must be valid UUIDs. `reports list --limit` accepts 1 to 200 rows.

Report share rules:

- `--recipient` must be a valid email when supplied.
- `--expires-at` must be a valid future date and time.
- Passwords may be at most 256 characters and are read only from the environment variable named by `--password-env`; no plaintext password option is accepted.
- Environment variable names must start with a letter or underscore and contain only letters, numbers, and underscores. The selected variable must be set and nonempty.

Report schedule rules:

- Cadence must be `weekly` or `monthly`.
- Each schedule accepts 1 to 100 site IDs; duplicates are removed.
- Schedule names may be at most 200 characters.
- `--auto-share on` requires a valid `--recipient`.
- Toggle values use the same accepted forms as alert toggles.

Report features require the applicable Lagos Agency entitlements.

## Site Search

`sites list --search <term>` accepts up to 120 characters. Control characters, commas, and parentheses are rejected because the value is embedded in a Supabase filter expression.

## Site Creation and Mount Paths

New sites must use an HTTPS managed Studio hostname. `--subdomain` and `--tld` derive that URL; `--url` may only provide an equivalent managed Studio URL. Connect custom domains after creation. The platform derives the WordPress admin URL and generates all WordPress, Basic Auth, and secret credentials server-side, so `--admin-url` is no longer accepted.

Supported `--php-version` values are `7.4`, `8.0`, `8.1`, `8.2`, `8.3`, and `8.4`.

`sites create --mount-path` and `domains mount` normalize `/` to no mount path. Other values must be safe URL paths such as `/blog` without `..`, a query, or a fragment.

## Migration Uploads

Migration uploads are accepted by:

```bash
static-studio sites create --migration-file <path>
static-studio sites redeploy <siteId> --migration-file <path>
```

Accepted archive extensions:

- `.zip`
- `.tar.gz`
- `.tgz`

ZIP files must include `studio-backup-` in the filename unless `--allow-any-zip-name` is supplied. The maximum upload size is 10 GB.

Uploads are stored in the `site_migrations` bucket with a key derived from the site subdomain:

```text
public/site-migration-<subdomain>.zip
public/site-migration-<subdomain>.tar.gz
```

The CLI initializes a presigned multipart upload through Static Studio. It reads and uploads 25 MiB parts with two concurrent workers, requests signed URLs in batches of 10, retries a failed part up to five times, and completes the upload with the returned ETags. An interrupted upload is aborted when possible. Raw storage credentials are never returned to the CLI. Upload metadata is included in the command result.

## SEO Files

`seo save` accepts exactly one of `--content <text>` or `--file <path>`. Content is measured as UTF-8 and must be 1 MiB or smaller.

Managed SEO paths are root-level filenames such as:

```text
robots.txt, llms.txt, sitemap.xml, google123.html
```

Leading slashes are removed. Subdirectories, `..`, `?`, and `#` are rejected.

## Bulk Redirect Files

`redirects bulk-create` expects a JSON array file:

```json
[
  {
    "fromPath": "/old-page",
    "toPath": "/new-page"
  },
  {
    "fromPath": "/docs",
    "toPath": "https://example.com/docs"
  }
]
```

Rules:

- The file must be 512 KiB or smaller.
- The JSON root must be an array.
- The array can contain at most 1000 redirects.
- Each item must be an object with string `fromPath` and `toPath` values.
- Each path value must be 2048 characters or fewer.

By default, the CLI resolves `pullZoneId` and redirect domain from the site. Use `--pull-zone-id` or `--domain` to override them.

## Redirect Updates

`redirects update` accepts `--from-path`, `--to-path`, `--active`, and `--inactive`.

Rules:

- At least one update field must be provided.
- `--active` and `--inactive` are mutually exclusive.
- `--from-path` and `--to-path` are trimmed, cannot be empty, and must be 2048 characters or fewer.
- Default redirects can only be enabled or disabled.

## Team Email Files

`team invite --file <path>` and `team bulk-invite <file>` accept files up to 64 KiB.

JSON array format:

```json
[
  "person@example.com",
  "teammate@example.com"
]
```

Plain text, CSV, or semicolon-separated format:

```text
person@example.com
teammate@example.com, another@example.com; third@example.com
```

The parser splits non-JSON files on whitespace, commas, and semicolons. The default maximum is 100 unique emails, and `--max-emails` can set a value from 1 to 100.

## Debug Logs

`logs get` and `sites debug-log` fetch:

```text
<wp-base-url>/wp-json/static-studio/v1/debug-log
```

The WordPress base URL is derived from the site's `admin_url`. Bedrock-style `/wp/wp-admin` URLs are normalized to `/wp`.

Safety rules:

- Only HTTP and HTTPS URLs are accepted.
- HTTP is rejected unless `--allow-insecure-http` is supplied.
- Local hostnames and private network addresses are rejected unless `--allow-private-network` is supplied.
- Response size defaults to 5 MiB.
- `--max-bytes` must be between 1024 bytes and 20 MiB.
- `--timeout` must resolve to 1000 to 120000 milliseconds.

Log levels are inferred per line using simple text matching:

- `error`: fatal error, PHP fatal, `error:`, PHP error.
- `warning`: warning or PHP warning.
- `notice`: notice, PHP notice, or deprecated.
- `info`: info or debug.

`--search` is case-insensitive. `--newest-first` reverses the filtered lines before tailing.

## Tags

Tag names must be 1 to 80 printable characters. Tag colors must be six-digit hex values such as:

```text
#3858E9
```

Colors are normalized to uppercase.

## Environments

Environment names must be 1 to 64 printable characters and may contain:

```text
letters, numbers, spaces, dots, underscores, hyphens
```

The name must start with a letter or number. The CLI creates a slug by lowercasing the name, removing unsupported characters, converting spaces to hyphens, collapsing duplicate hyphens, and trimming leading or trailing hyphens.

`production` is reserved and cannot be used as a child environment name or deleted as a child environment.

Environment domain commands accept an environment ID, name, slug, or title. The parent site must have status `deployed`. Custom domains must be hostnames without credentials, ports, paths, queries, or fragments, and managed Studio hostnames cannot be used as custom domains. Each environment can have one custom hostname; connecting another replaces it.

## Numeric Limits

| Context | Allowed range |
| --- | --- |
| `sites list --page` | 1 to 10000 |
| `sites list --page-size` | 1 to 100 |
| `sites releases --limit` | 1 to 100 |
| `health overview` row limits | 1 to 100 each |
| `health run` site IDs | 1 to 25 sites |
| `alerts` recipients | 1 to 10 unique emails when required |
| `alerts --uptime-threshold` | 5 to 1440 minutes |
| `alerts --performance-threshold` | 1 to 100 |
| `reports list --limit` | 1 to 200 |
| `reports schedule` site IDs | 1 to 100 sites |
| `performance reports --limit` | 1 to 100 |
| `logs get --tail` / `sites debug-log --tail` | 1 to 10000 |
| `team invite --max-emails` / `team bulk-invite --max-emails` | 1 to 100 |
| `ssh connect <keyId>` / `ssh disconnect <keyId>` | positive integer |

## Confirmation Prompts

The following commands prompt unless `--yes` is supplied:

- `sites delete`
- `sites cancel-export`
- `sites rollback`
- `domains transfer`
- `seo delete`
- `reports revoke-share`
- `reports delete-schedule`
- `environments domain-remove`
- `environments delete`
- `environments disable`
- `tags delete`
- `team remove`

Cancellation exits with status `0` after printing `Cancelled.`

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

WordPress role options accept:

```text
administrator, editor, author, contributor, subscriber
```

`users invite` and `users add` default to `administrator`. Team invite commands default to `editor`.

## Site Search

`sites list --search <term>` accepts up to 120 characters. Control characters, commas, and parentheses are rejected because the value is embedded in a Supabase filter expression.

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

ZIP files must include `studio-backup-` in the filename unless `--allow-any-zip-name` is supplied. The maximum upload size is 10 GiB.

Uploads are stored in the `site_migrations` bucket with a key derived from the site subdomain:

```text
public/site-migration-<subdomain>.zip
public/site-migration-<subdomain>.tar.gz
```

The CLI requests temporary upload credentials from Static Studio, uploads with multipart S3-compatible upload, and includes upload metadata in the command result.

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

## Numeric Limits

| Context | Allowed range |
| --- | --- |
| `sites list --page` | 1 to 10000 |
| `sites list --page-size` | 1 to 100 |
| `performance reports --limit` | 1 to 100 |
| `logs get --tail` / `sites debug-log --tail` | 1 to 10000 |
| `team invite --max-emails` / `team bulk-invite --max-emails` | 1 to 100 |
| `ssh connect <keyId>` / `ssh disconnect <keyId>` | positive integer |

## Confirmation Prompts

The following commands prompt unless `--yes` is supplied:

- `sites delete`
- `environments delete`
- `environments disable`
- `tags delete`
- `team remove`

Cancellation exits with status `0` after printing `Cancelled.`

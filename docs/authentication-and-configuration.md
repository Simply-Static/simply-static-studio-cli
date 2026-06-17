# Authentication and Configuration

## Requirements

- Node.js 20 or newer.
- A Static Studio account.
- Network access to the configured Supabase project and Static Studio edge functions.

Install the published package globally:

```bash
npm install -g @simply-static/static-studio
static-studio --help
```

Run from a local checkout:

```bash
npm install
npm run build
node dist/cli.js --help
```

## Global Options

Global options are accepted before subcommands:

```bash
static-studio [--json] [--profile <name>] <command>
```

| Option | Default | Description |
| --- | --- | --- |
| `--json` | off | Print machine-readable JSON. Recommended for scripts and coding agents. |
| `--profile <name>` | `default` | Select the local saved authentication profile. |
| `--version` | package version | Print the CLI version. |
| `--help` | n/a | Print command help. |

## Login Methods

Interactive or OTP email login:

```bash
static-studio login --email person@example.com
static-studio login --email person@example.com --otp 123456
```

Personal Access Token login:

```bash
static-studio login --token "$STATIC_STUDIO_ACCESS_TOKEN"
```

Generate Personal Access Tokens in the Static Studio app under **Account -> Access Token**. They require an active paid subscription; free trial accounts can open the CLI token screen, but the token field and regeneration action remain locked until the account subscribes.

The CLI exchanges a Personal Access Token through the platform `access-token` Edge Function for a short-lived Supabase access token. Personal Access Tokens do not have refresh tokens, and the exchange response intentionally does not include one.

Options:

| Option | Description |
| --- | --- |
| `--email <email>` | Email address for OTP login. |
| `--otp <code>` | OTP code for non-interactive email login. |
| `--token <token>` | Personal Access Token to store instead of starting OTP login. Supabase session access tokens are also supported when paired with `--refresh-token`. |
| `--refresh-token <token>` | Refresh token paired with a Supabase session access token. Do not use this with a Personal Access Token. |
| `--create-user` | Allow Supabase Auth to create a user during OTP login. |

The command prints the authenticated user summary and config path.

## Saved Sessions

By default, saved sessions are stored in:

```text
~/.static-studio/config.json
```

The file is written with `0600` permissions. Use named profiles to keep sessions separate:

```bash
static-studio --profile personal login --email person@example.com
static-studio --profile agency login --token "$AGENCY_TOKEN"
static-studio --profile agency sites list
static-studio --profile agency logout
```

`logout` removes the selected profile. If the removed profile was active, the next available profile becomes active, otherwise the active profile falls back to `default`.

## Environment Variables

| Variable | Description |
| --- | --- |
| `STATIC_STUDIO_ACCESS_TOKEN` | Personal Access Token used directly for the current command. Supabase session access tokens are also supported. When set, the CLI does not require a saved profile. |
| `STATIC_STUDIO_REFRESH_TOKEN` | Refresh token paired with a Supabase session access token. Do not use this with a Personal Access Token. |
| `STATIC_STUDIO_CONFIG_DIR` | Directory that contains `config.json`; defaults to `~/.static-studio`. |
| `STATIC_STUDIO_SUPABASE_URL` | Override the Supabase URL in local config. |
| `STATIC_STUDIO_SUPABASE_ANON_KEY` | Override the Supabase anon key in local config. |

Environment tokens take precedence over saved profile tokens.

## Auth Checks

Use `whoami` to show the currently authenticated user:

```bash
static-studio whoami
```

Use `status` to call the platform status integration:

```bash
static-studio status
```

## Output Modes

Without `--json`:

- Arrays are printed as tables.
- Empty arrays print `No results.`
- Strings are printed directly.
- Objects are printed with Node's inspection formatting.

With `--json`, every command prints pretty JSON.

## Errors and Exit Codes

Operational errors are printed to stderr as:

```text
Error: <message>
```

Most errors exit with status `1`. User cancellations on confirmation prompts print `Cancelled.` and exit with status `0`.

Commands that can make destructive changes prompt for confirmation unless `--yes` is supplied.

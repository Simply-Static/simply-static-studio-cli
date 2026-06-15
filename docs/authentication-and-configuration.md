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

Token login:

```bash
static-studio login --token "$STATIC_STUDIO_ACCESS_TOKEN"
static-studio login --token "$STATIC_STUDIO_ACCESS_TOKEN" --refresh-token "$STATIC_STUDIO_REFRESH_TOKEN"
```

Options:

| Option | Description |
| --- | --- |
| `--email <email>` | Email address for OTP login. |
| `--otp <code>` | OTP code for non-interactive email login. |
| `--token <token>` | Access token to store instead of starting OTP login. |
| `--refresh-token <token>` | Refresh token paired with `--token`. |
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
| `STATIC_STUDIO_ACCESS_TOKEN` | Access token used directly for the current command. When set, the CLI does not require a saved profile. |
| `STATIC_STUDIO_REFRESH_TOKEN` | Optional refresh token paired with `STATIC_STUDIO_ACCESS_TOKEN` in the generated auth context. |
| `STATIC_STUDIO_CONFIG_DIR` | Directory that contains `config.json`; defaults to `~/.static-studio`. |
| `STATIC_STUDIO_SUPABASE_URL` | Override the Supabase URL in local config. |
| `STATIC_STUDIO_SUPABASE_ANON_KEY` | Override the Supabase anon key in local config. |

Environment access tokens take precedence over saved profile tokens.

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

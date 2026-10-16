# Authentication and Configuration

## Requirements

- Node.js 20 or newer.
- A Static Studio account.
- Network access to the configured Supabase project, Static Studio edge
  functions, and `https://challenges.cloudflare.com` for email login.

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

Interactive email OTP login:

```bash
static-studio login --email person@example.com
```

Before requesting the email code, the CLI starts a temporary HTTP server bound
only to `127.0.0.1`, prints its Cloudflare Turnstile challenge URL, attempts to
open it in the default browser, and waits for the browser to return a
short-lived security token. The challenge times out after five minutes and the
loopback server closes when it completes or fails.

Open the printed `127.0.0.1` URL in a browser that shares the CLI's network
namespace. Remote SSH sessions and containers may require loopback port
forwarding; otherwise use a trusted CAPTCHA-token flow or a Personal Access
Token.

To open the printed URL yourself, disable automatic browser launch:

```bash
static-studio login --email person@example.com --no-browser
```

For a two-step or non-interactive login, first request a code. A trusted
integration can supply its own short-lived Turnstile token instead of using the
local browser flow:

```bash
static-studio login \
  --email person@example.com \
  --request-only \
  --captcha-token "$STATIC_STUDIO_CAPTCHA_TOKEN"
static-studio login --email person@example.com --otp 123456
```

`--otp` verifies a code that was already requested and deliberately does not
request a replacement code or start another Turnstile challenge.

Personal Access Token login:

```bash
static-studio login --token "$STATIC_STUDIO_ACCESS_TOKEN"
```

Generate Personal Access Tokens in the Static Studio app under **Account -> Access Token**. Issuing and exchanging a token requires a subscription whose status is `active` and whose quota is greater than zero. Trial status is not checked as a separate categorical exclusion, so an eligible trial account can use a token.

The CLI exchanges a Personal Access Token through the platform `access-token` Edge Function for a short-lived Supabase access token. Personal Access Tokens do not have refresh tokens, and the exchange response intentionally does not include one.

Turnstile applies only when requesting an email OTP. Personal Access Token and
Supabase session-token login do not start a browser challenge and otherwise
keep their existing behavior.

Options:

| Option | Description |
| --- | --- |
| `--email <email>` | Email address for OTP login. |
| `--otp <code>` | Verify a previously requested email OTP without requesting another code or running Turnstile. |
| `--request-only` | Complete Turnstile, request an email OTP, and exit without prompting for the code. |
| `--captcha-token <token>` | Short-lived Cloudflare Turnstile token to use instead of starting the local browser flow. |
| `--no-browser` | Print the loopback Turnstile URL instead of trying to open it automatically. |
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
| `STATIC_STUDIO_TURNSTILE_SITE_KEY` | Override the Cloudflare Turnstile site key used by the local email-login challenge. |
| `STATIC_STUDIO_CONFIG_DIR` | Directory that contains `config.json`; defaults to `~/.static-studio`. |
| `STATIC_STUDIO_SUPABASE_URL` | Override the Supabase URL in local config. |
| `STATIC_STUDIO_SUPABASE_ANON_KEY` | Override the Supabase anon key in local config. |

Environment tokens take precedence over saved profile tokens.

A Turnstile site-key override must authorize `127.0.0.1` and match the secret
configured for the selected Supabase project. Treat `--otp` and
`--captcha-token` values as secrets: command-line values may be recorded in
shell history or visible to local process inspection.

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

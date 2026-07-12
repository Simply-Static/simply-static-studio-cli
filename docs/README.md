# Static Studio CLI Documentation

This directory contains the detailed reference for the `static-studio` command line interface.

These pages document release `0.1.5`.

## Documents

- [Authentication and configuration](authentication-and-configuration.md) explains install requirements, login methods, profiles, environment variables, output modes, and error behavior.
- [Command reference](command-reference.md) lists every command, argument, option, default, and important behavior exposed by the CLI.
- [Input formats and limits](input-formats-and-limits.md) documents accepted file formats, validation rules, and safety limits for uploads, SEO files, alerts, reports, bulk operations, logs, IDs, tags, and environments.
- [Workflows](workflows.md) provides task-oriented examples for hosting, deployment recovery, domains, Site Health, alerts, SEO, IndexNow, and reports.

## Executable Names

The package installs two equivalent binaries:

```bash
static-studio --help
sss --help
```

Examples in these docs use `static-studio`, but `sss` accepts the same commands and options.

## Quick Start

```bash
npm install -g @simply-static/static-studio
static-studio login --email person@example.com
static-studio sites list
```

For non-interactive environments, provide a Personal Access Token:

```bash
STATIC_STUDIO_ACCESS_TOKEN=... static-studio --json sites list
```

Personal Access Tokens are generated in the Static Studio app under **Account -> Access Token**. Issuance and exchange require an active subscription with quota greater than zero; trial status alone is not a categorical exclusion.

Use `--json` whenever another program or agent will parse the output.

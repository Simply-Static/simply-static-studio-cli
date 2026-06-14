# Static Studio CLI Documentation

This directory contains the detailed reference for the `static-studio` command line interface.

## Documents

- [Authentication and configuration](authentication-and-configuration.md) explains install requirements, login methods, profiles, environment variables, output modes, and error behavior.
- [Command reference](command-reference.md) lists every command, argument, option, default, and important behavior exposed by the CLI.
- [Input formats and limits](input-formats-and-limits.md) documents accepted file formats, validation rules, and safety limits for uploads, bulk redirects, team invites, logs, IDs, tags, and environments.
- [Workflows](workflows.md) provides task-oriented examples for common hosting operations.

## Executable Names

The package installs two equivalent binaries:

```bash
static-studio --help
sss --help
```

Examples in these docs use `static-studio`, but `sss` accepts the same commands and options.

## Quick Start

```bash
npm install -g @simply-static/studio-cli
static-studio login --email person@example.com
static-studio sites list
```

For non-interactive environments, provide an access token:

```bash
STATIC_STUDIO_ACCESS_TOKEN=... static-studio --json sites list
```

Use `--json` whenever another program or agent will parse the output.

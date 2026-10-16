# Changelog

## 0.3.0 - 2026-10-16

### Added

- Cloudflare Turnstile protection for email OTP requests, with a temporary
  loopback browser flow, `login --no-browser`, and a two-step
  `login --request-only` / `login --otp <code>` flow for automation.
  `login --captcha-token <token>` supports trusted integrations. Personal
  Access Token and Supabase session-token authentication are unchanged.
- Migration support for `.wpress` and `.daf`, alongside `.zip`, `.tar.gz`, and
  `.tgz`; Duplicator filenames ending in `_archive.zip` now pass the default ZIP
  validation.
- Replacement redeploys from either `--migration-file` or a finalized
  `--migration-artifact-id`, while a redeploy without either option performs an
  ordinary platform redeploy.
- `domains add --prepare-only` for preparing WordPress and an export before
  completing SSL, ownership registration, and live routing.

### Changed

- New platform sites support PHP 7.4 and PHP 8.1 through 8.4.
- Site creation consumes the provisioning job queued by the server and uses the
  dedicated queue endpoint only as a compatibility fallback.
- Site creation now requires a migration archive or finalized migration
  artifact while Studio's empty-site abuse-control switch is disabled.
- Site name and notes updates must be issued separately because names now use
  Studio's administrator-only Edge service.
- Backup list, create, restore, delete, status, download, copy, and policy
  operations now use the current platform backup contracts. Omit the cadence
  from `backups policy` to read it or pass `daily` or `weekly` to update it;
  restore and delete require `--backup-id`.
- Replacement uploads now use private version-3 platform migration artifacts
  bound to the target site.
- Removing a secondary custom domain now keeps WordPress aligned with the
  surviving primary domain.

### Removed

- Retired `sites migration-log` and `sites runtime-policy` commands.
- Direct site-status changes through `sites update --status`.
- Legacy `backups sync`, `backups list --refresh`, and date-based restore or
  delete selectors.

### Library API migration

This is a breaking library update for consumers importing the package API.
Retired Studio contracts removed the `MigrationLogResult`, `getMigrationLog`,
`getSiteMigrationSubdomain`, and `updatePlatformRuntimePolicy` exports.
`createSite` now requires a finalized migration artifact, `updateSite` accepts
only one of `name` or `notes`, and backup functions use platform backup IDs and
the current queue payloads. Site types no longer expose retired server-only
infrastructure fields. CLI users should follow the command changes above.

## 0.2.0 - 2026-07-29

### Added

- Docker WordPress runtime status, start/stop, and always-on/timed policy commands.
- Docker backup artifact status, secure downloads, cross-site copies, and automated daily/weekly policy management.
- Provider-bound SFTP connection snapshots and reconciliation retries.
- Resumable site creation from finalized private Docker migration artifacts.

### Changed

- New empty and imported sites now require the server-assigned `static-studio-docker` provider and queue Docker platform provisioning API v1.
- New-site imports use private version-3 Docker migration artifacts, direct signed multipart completion, server-side finalization, and artifact-bound provisioning.
- New Docker sites support PHP 8.2, 8.3, and 8.4. Bedrock creation is no longer exposed.
- Site reads omit server-only infrastructure fields and the WordPress administrator password. WordPress access uses magic links; approved Basic Auth and helper credentials remain available through their dedicated commands.
- Backup and SSH/SFTP operations derive behavior from each site's stored provider while preserving legacy SpinupWP workflows for existing sites.
- Replacement migration uploads remain available only for legacy SpinupWP sites; Docker sites use managed backup restore/copy workflows.

## 0.1.6 - 2026-07-15

### Changed

- Site names are now strictly display metadata. New managed hostnames use an opaque generated identifier, and `sites create` no longer accepts caller-controlled `--subdomain`, `--tld`, or `--url` values.
- Migration uploads and site provisioning now share the same server-generated, signed identifier without exposing it as a creation option.

## 0.1.5 - 2026-07-12

### Added

- Site Health checks, configurable alerts, and health/deployment overviews.
- SEO file and IndexNow management.
- Export cancellation, migration logs, release history, and static rollback workflows.
- Agency report PDFs, client shares, and weekly/monthly schedules.
- Mount-path management, environment custom domains, and safe custom-domain transfers.

### Changed

- Migration archives now use Static Studio's authenticated presigned multipart upload protocol. The CLI no longer receives storage credentials or depends on the AWS SDK.
- Site creation now uses Studio-generated credentials and the hardened Lagos queue contract.
- Domain, SSL, environment, redirect, user, and team operations now send the authorization context required by Lagos.
- Site listings include team-access sites while keeping embedded site metadata scoped to the authenticated user.
- WordPress roles are limited to `administrator`, `editor`, `author`, and `contributor`.

### Fixed

- CDN cache clears now authorize and purge by the site's pull zone.
- Domain mutations now require a deployed site, protect managed hostnames, and surface partial WordPress or edge-rule failures.
- Team removal now cleans up the matching site metadata record.
- Custom PageSpeed targets are rejected because Studio now tests the stored canonical site URL.

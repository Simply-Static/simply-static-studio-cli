# Changelog

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

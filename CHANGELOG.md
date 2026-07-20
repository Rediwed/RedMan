# Changelog

All notable changes to RedMan.

Versioning scheme:
- **X.X.1** - Patches: bug fixes, small UI improvements, and documentation changes
- **X.1.X** - Minor: new features, new workflows, and new settings
- **1.X.X** - Major: breaking data-model or deployment changes

## [Unreleased]

## [1.1.4] - 2026-07-20

### Fixed
- Fixed the production image's frontend path so `/` and SPA routes serve the built React application instead of returning `Cannot GET /`.

## [1.1.3] - 2026-07-20

### Performance
- Made readiness assessment constant-time and moved full backup integrity validation into a child process so large databases do not block API health.

### Security
- Streamed backup SHA-256 calculation and stopped loading multi-gigabyte artifacts into Node memory; the host helper still verifies the canonical stopped file with `sha256sum` before accepting it.

## [1.1.2] - 2026-07-19

### Performance
- Increased SQLite online-backup batches from the library's 100-page default to 16,384 pages so multi-gigabyte readiness backups complete practically on Unraid while retaining integrity and receipt checks.

## [1.1.1] - 2026-07-18

### Security
- Removed the implicit administrator-group fallback, required an explicit group and/or role in production, and added Pangolin Badger role authorization without trusting its unsanitized `Remote-Groups` header.

## [1.1.0] - 2026-07-18

### Added
- Added a five-step Upgrade Readiness wizard that assesses legacy risks, creates an integrity-checked database backup, generates a host preparation command, verifies the host receipt, and produces hardened-release configuration.
- Added portable Linux and Unraid host preparation with rollback artifacts and persistent restricted `redman-backup` SSH setup.
- Added a non-mutating release gate, synchronized version badge, changelog workflow, and public-only tagging script for future RedMan releases.

### Fixed
- Fixed fresh-database seeding when startup creates migration-owned tables before the development seed runs.
- Fixed mobile navigation and Settings tabs so the upgrade wizard remains usable without page-level horizontal overflow.

### Security
- Updated bridge dependencies to patched versions with a zero-advisory audit.
- Restricted production forward-auth headers to exact proxy source hosts and exact administrator group or Pangolin Badger role membership for upgrade mutations.
- Made the bridge a maintenance release that pauses schedules, job mutations, monitoring, and the peer API while exposing only app-data.
- Bound backup and rollback receipts to exact paths, sizes, SHA-256 values, SQLite integrity, and container image identity.
- Replaced root execution of container-sourced scripts with official `v1.1.0` downloads verified against embedded checksums.
- Pinned container build inputs, removed unnecessary transfer/import tooling from the maintenance image, and removed the legacy direct Docker socket deployment.

### Removed
- Removed the private, destructive automatic deploy helper from the public bridge release; installation and hardened cutover remain explicit operator actions.

## [1.0.0] - 2026-07-18

### Added
- Initial public release baseline.

# Changelog

All notable changes to RedMan.

Versioning scheme:
- **X.X.1** - Patches: bug fixes, small UI improvements, and documentation changes
- **X.1.X** - Minor: new features, new workflows, and new settings
- **1.X.X** - Major: breaking data-model or deployment changes

## [Unreleased]

### Added
- [x] Added a five-step Upgrade Readiness wizard that assesses legacy risks, creates an integrity-checked database backup, generates a host preparation command, verifies the host receipt, and produces hardened-release configuration.
- [x] Added portable Linux and Unraid host preparation with rollback artifacts and persistent restricted `redman-backup` SSH setup.
- [x] Added a non-mutating release gate, synchronized version badge, changelog workflow, and public-only tagging script for future RedMan releases.

### Fixed
- [x] Fixed fresh-database seeding when startup creates migration-owned tables before the development seed runs.
- [x] Fixed mobile navigation and Settings tabs so the upgrade wizard remains usable without page-level horizontal overflow.

### Security
- [x] Updated bridge dependencies to patched versions with a zero-advisory audit.
- [x] Restricted production forward-auth headers to exact proxy source hosts and exact administrator group or Pangolin Badger role membership for upgrade mutations.
- [x] Made the bridge a maintenance release that pauses schedules, job mutations, monitoring, and the peer API while exposing only app-data.
- [x] Bound backup and rollback receipts to exact paths, sizes, SHA-256 values, SQLite integrity, and container image identity.
- [x] Replaced root execution of container-sourced scripts with official `v1.1.0` downloads verified against embedded checksums.
- [x] Pinned container build inputs, removed unnecessary transfer/import tooling from the maintenance image, and removed the legacy direct Docker socket deployment.

### Removed
- [x] Removed the private, destructive automatic deploy helper from the public bridge release; installation and hardened cutover remain explicit operator actions.

## [1.0.0] - 2026-07-18

### Added
- Initial public release baseline.

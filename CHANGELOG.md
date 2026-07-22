# Changelog

All notable changes to RedMan.

Versioning scheme:
- **X.X.1** - Patches: bug fixes, small UI improvements, and documentation changes
- **X.1.X** - Minor: new features, new workflows, and new settings
- **1.X.X** - Major: breaking data-model or deployment changes

## [Unreleased]

### Added
- [x] Added the hardened full runtime with explicit local/proxy authentication, protected peer credentials, restricted backup accounts, exact-path Docker proxies, and schema 26 migrations.

### Changed
- [x] Ported the hardened application onto the clean v1.1.9 bridge baseline while retaining opt-in upgrade-readiness mode, its rollback workflow, and release checks.
- [x] Made Docker and Unraid the runtime resource-policy owners: deployment preserves existing UI-managed limits, writes reconstruction metadata, and RedMan adapts delta concurrency to effective cgroup memory, CPU, and PID ceilings.

### Fixed
- [x] Made snapshot conversion, pruning, file/database restore, Rclone destinations, legacy summary scans, Unraid capabilities, and deployment builds fail closed under interruption, unsafe paths, resource pressure, or validation errors.

### Security
- [x] Bounded startup migrations, credential conversion, database/pairing retention, private temporary cleanup, and per-run Immich retries; prevented incomplete retention cycles from resetting their cap every minute; moved large database integrity checks out of the API process, throttled automatic copies to once daily, constrained delta compression, and kept runs active through observable, cancellable post-processing; reconciled managed peer SSH grants fail closed at startup; scoped SSH identity strictly to RedMan app data; capped unauthenticated pairing payloads and storage; required private web/peer binding; rejected root SSH transfers at every runtime boundary; and added breakglass-hash-verified sequential deployment with restart-disabled canaries and host observation before promotion.

## [1.1.9] - 2026-07-20

### Added
- Added a detected setup that derives the existing origin, proxy, platform, host paths, timezone, Docker preference, and prepared backup roots while leaving the NAS private IP explicit.
- Persisted the non-secret hardened configuration as an atomic mode-`0600`, SHA-256-validated readiness receipt so Ready survives refreshes and restarts.

### Changed
- Reduced the default wizard to one recommended action per stage, moved technical checks and raw settings under details, skipped completed host forms, and made Ready explicitly tell operators to leave the bridge running after every NAS is prepared.
- Hid the unrelated general Settings save bar while the self-contained Upgrade tab is active.

## [1.1.8] - 2026-07-20

### Fixed
- Made the hardened configuration timezone editable, initialized it from the existing installation, and rejected unsupported IANA timezone identifiers before generation.

## [1.1.7] - 2026-07-20

### Fixed
- Made Unraid boot replay invoke persisted RedMan scripts through `bash`, because the FAT boot volume does not preserve executable bits.

## [1.1.6] - 2026-07-20

### Fixed
- Added checksum-pinned official Perl `rrsync` provisioning for Unraid releases that ship rsync without the support helper or Python, including `/boot` persistence and reboot replay.

## [1.1.5] - 2026-07-20

### Added
- Added resolution timing, numbered instructions, and direct wizard navigation to every non-ready assessment item.
- Added an admin-only in-app action to disable unsafe delete-after-import settings immediately; rollback-sensitive SSH, peer, and Docker migrations remain explicit staged guidance.

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

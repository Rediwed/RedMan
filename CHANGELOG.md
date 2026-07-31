# Changelog

All notable changes to RedMan.

Versioning scheme:
- **X.X.1** - Patches: bug fixes, small UI improvements, and documentation changes
- **X.1.X** - Minor: new features, new workflows, and new settings
- **1.X.X** - Major: breaking data-model or deployment changes

## [Unreleased]

### Added
- [x] Added optional bi-directional pairing. When connecting to a peer you can now offer it backup space on your own instance in the same request, so a single accept sets up both directions instead of repeating the entire pairing from the other side. The offer travels inside the signed handshake transcript, the receiver decides whether to take it up, and the reverse API key is derived from the same shared secret under a separate label so it is never transmitted.
- [x] Added a copy button to the pairing identity fingerprint, so both operators can compare the exact string instead of retyping it from a screen. It falls back to a selection-based copy when the browser blocks the clipboard API, which is common on plain-HTTP LAN addresses.
- [x] Added the hardened full runtime with explicit local/proxy authentication, protected peer credentials, restricted backup accounts, exact-path Docker proxies, and schema 27 migrations.
- [x] Added a **DB Integrity** column to the SSD Backup run history and run report, so every run shows at a glance whether the database copy written to that destination passed its SQLite integrity check, was not due yet, or failed verification.

### Changed
- [x] Reworked accepting an incoming connection request. The slide-in notification now only asks whether you want to handle the request; the backup location, storage quota, and fingerprint confirmation moved to a centred dialog that opens when you accept. The dialog uses the standard form styling, browses for the backup location through the regular directory and share picker instead of a bare text field, and shows an example quota (1024 GB = 1 TB) plus a live readback of what the peer will get.
- [x] Ported the hardened application onto the clean v1.1.9 bridge baseline while retaining opt-in upgrade-readiness mode, its rollback workflow, and release checks.
- [x] Made Docker and Unraid the runtime resource-policy owners: deployment preserves existing UI-managed limits, writes reconstruction metadata, and RedMan adapts delta concurrency to effective cgroup memory, CPU, and PID ceilings.
- [x] Made the deployment host-observation window adaptive: it now early-exits once the container is stably healthy (a minimum floor plus consecutive clean samples) instead of always waiting the full fixed window, so healthy deploys promote in seconds while immediate failure detection is unchanged.

### Fixed
- [x] Fixed backups failing indefinitely against a backup root that still holds content from before the restricted account existed. Such files are owned by root, and rsync mirrors the source's permissions — but changing a file's mode is refused to anyone except its owner, so every run ended with hundreds of *Operation not permitted* errors on files it could otherwise read and write. Nothing in the error pointed at ownership. The setup script now reports the situation with the command that resolves it, and `--adopt-backup-roots` hands the existing content over. Handing over is deliberately opt-in and never reaches the boot script: it is a one-off migration, not something to walk a multi-terabyte tree for on every start. Ownership is transferred with a single `chown -Rh`, which walks using directory file descriptors — passing paths to a separate process would let anything writing into the backup root swap a directory for a symlink between listing and change, and redirect a root-owned change outside the tree. Symlinks are re-owned without their targets, mount points and system paths are refused outright, and the whole step runs after the SSH configuration so a failure on one file cannot leave the account half-configured.
- [x] Fixed the restricted backup account being silently dismantled every time it was set up on Unraid. The setup script wrote the `Match` block, validated it, and then reloaded OpenSSH through `/etc/rc.d/rc.sshd restart` — which on Unraid rebuilds `sshd_config` from a template and takes the freshly written block with it. The script reported the account as ready while the host had in fact reverted to password authentication with no `AuthorizedKeysCommand`, so every backup to that peer failed and every deploy re-broke it. The reload now signals the running listener first, which re-reads the configuration in place without regenerating it, and the block is re-checked afterwards so a reload that discards it fails loudly instead of reporting success.
- [x] Fixed every Hyper Backup transfer to a restricted peer failing with *mkdir "…/cross-site/mnt/user/cross-site/…" failed: No such file or directory*. Hardening moved transfers onto a restricted account that reaches the filesystem through rrsync, which resolves every request underneath the allowed prefix — but jobs still sent the full absolute destination path they were created with, so the peer applied its own prefix a second time and wrote into a directory that cannot exist. The peer now advertises the path rsync must ask for, since it is the side that knows how its own account is confined. Because re-rooting only ever strips the peer's own prefix, the advertised path must be part of the destination the job was configured with — so a peer cannot name a different location and redirect the transfer, which on a pull would make `--delete-after` remove the local copy it was meant to restore. A peer that advertises nothing keeps the previous behaviour.
- [x] Fixed every Hyper Backup transfer failing with *Permission denied (publickey)* / *rsync: connection unexpectedly closed*. RedMan generates its own SSH key and deliberately stores it in the data volume so it survives container rebuilds, but the commands that actually connect never pointed at it — they relied on ssh finding a key in the default `~/.ssh` location, which is inside the container and therefore empty again after every recreate. Transfers kept working until the container was next rebuilt and then failed permanently, with the peer correctly holding the right key the whole time. The identity is now passed explicitly to both the rsync transport and the connection test, so the stored key is the one actually offered.
- [x] Fixed Hyper Backup refusing to run with *Storage usage unavailable: usage scan exceeded 5000 ms*. Measuring a backup target costs seconds and grows with the data, but the peer waited only five seconds and then killed the scan, so a destination slower than that could never be measured at all — every attempt paid the wait, none of them ever learned the answer, and the backup was refused over a failed measurement rather than a full disk. How long a request waits is now separate from how long the scan may run: the scan continues in the background and fills the cache, a figure that is merely old is served immediately while a refresh runs behind it, and a backup is only refused when a successful measurement actually shows the quota exceeded. A measurement that has not produced a figure yet is recorded in the peer audit log and allowed through. The scan budget is sized for a real backup target rather than a directory: the pair this was written for measures twenty seconds at one end and just under three minutes at the other, and a budget the scan cannot finish within is the same as never measuring at all.
- [x] Fixed Hyper Backup jobs failing with *Authentication failed — the API key was rejected by the remote peer* after re-pairing a destination. Each job stored its own snapshot of the peer's address and API key at creation time, while re-pairing derives a brand new ECDH key and can hand out a different address, so every existing job kept presenting a credential the peer had already replaced. Jobs are now bound to the peer's stable static identity and resolve the current address and key from the pairing record on every run, so re-pairing repairs existing jobs instead of silently breaking them — and a peer that moves to a new IP is followed automatically.
- [x] Fixed peer pairing failing with *Could not determine a private callback IP* on instances that run in a Docker bridge network. Auto-discovery already coped with that (it falls back to the Docker API), but pairing only looked at the container's own interfaces — which are exactly the `172.x` bridge addresses it must ignore — so the connection failed before any request left the host, even though `PEER_HOST` already declared a peer-reachable private IP. RedMan now resolves its callback address from the explicit Peer API URL, then `PEER_HOST`, then the host interfaces, validating the result as a private base URL before it is signed; the remaining failure message names both fixes instead of only the setting.
- [x] Fixed SSD backup runs finishing as *partial* with `Post-processing warning: database backup: SQLite integrity check timed out after 600000ms`. The database copy was written straight onto the backup destination and then integrity-checked there, so on a slow share or spinning array the full page-by-page read blew the 10-minute budget and the finished backup was deleted. RedMan now stages the copy beside the live database, verifies it on fast local storage, and only then copies the validated file to the destination.
- [x] Fixed run-file retention being unable to keep up with real backup volume: it removed at most 2.500 rows per six-hour cycle while active installs add far more per day, so `backup_run_files` grew without bound until the database became large enough to blow the integrity-check budget. Cycles now clear up to 25.000 rows and re-run after 15 minutes while a backlog remains, keeping the same 30-second time budget, 250 ms yields and per-cycle batch caps — failed cycles still fall back to the full six-hour interval.
- [x] Made snapshot conversion, pruning, file/database restore, Rclone destinations, legacy summary scans, Unraid capabilities, and deployment builds fail closed under interruption, unsafe paths, resource pressure, or validation errors.
- [x] Replaced raw immich-go crash dumps (including its full CLI usage/help text) in Media Import failure notifications and run history with a short, actionable summary; specifically recognizes an Immich API/schema mismatch (e.g. after an Immich upgrade changes a response field's type) and points at the fix, alongside distinct messages for auth and network failures.
- [x] Fixed three `deploy.sh` portability/robustness gaps found deploying to a second, non-root-SSH host: the existing-runtime-limits safety check no longer fails closed on Docker engines that render an unset `PidsLimit` as `<no value>` instead of `<nil>`; rollback-metadata and reconstruction-receipt capture now write through a privileged `mktemp`/`tee` instead of a plain shell redirect, so they succeed when the deploy SSH user isn't root (`sudo`-based targets); and the restart-policy-preservation step no longer copies forward `--restart no` from an abandoned, never-promoted canary left by a prior interrupted deploy attempt — it now falls back to `unless-stopped` instead of silently leaving the newly-promoted container without auto-restart.

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

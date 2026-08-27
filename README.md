| `TRUSTED_PROXIES` | required | Comma-separated exact proxy source hosts; use bare IPs, IPv4 `/32`, or IPv6 `/128` only; production rejects subnets, empty values, and `*` |
# RedMan

Homelab backup and management tool built for Unraid. Handles cross-site replication between NAS units (Hyper Backup), local SSD-to-array backups with delta versioning, cloud sync via rclone, Docker container monitoring, and camera media import.

Built with Express + SQLite on the backend and React + Vite on the frontend. Runs as a single Docker container.

> **Existing installation?** Install the intermediate readiness bridge before the hardened release, then complete **Settings > Upgrade**. The wizard creates a verified backup, prepares a host command, verifies its receipt, and generates the future container configuration. See [UPGRADING.md](UPGRADING.md).

## Features

### Hyper Backup — Cross-Site Replication
Push or pull data between two RedMan instances over rsync/SSH. Designed for multi-TB datasets between remote NAS units.

- **Auto-discovery** — scans LAN subnets (detected from Docker networks, zero config) for other RedMan instances
- **Bluetooth-style pairing** — click Connect on a discovered peer, accept on the other side; SSH keys + API keys exchanged automatically
- **Pairing toast notifications** — incoming connection requests pop up on every page; accepting opens a centred dialog with the fingerprint, a browsable backup location, and a storage quota
- **Optional bi-directional pairing** — offer the peer space on your instance in the same request, so one accept sets up both directions instead of repeating the whole flow
- **Complete setup paths** — select a paired destination or enter a private peer URL/API key manually, with push/pull direction and validated SSH overrides
- **Rsync over SSH** with `--partial` for resumable transfers
- **SSH keepalive** (`ServerAliveInterval=60`) prevents silent drops on long transfers
- **Restricted peer SSH keys** — accepted peers receive `restrict` + source-IP + forced `rrsync` entries scoped to their approved backup root; callback recipients are not granted inbound SSH
- **Per-peer authentication** with 256-bit API keys, audit logging, and path restrictions
- **Protected peer credentials** — incoming tokens are one-way hashed; outgoing pairing and Hyper credentials are AES-256-GCM encrypted from the instance identity and decrypted only in memory
- **Noise XX handshake** for pairing — ephemeral X25519 ECDH + Ed25519 signatures, API keys derived via HKDF (never transmitted)
- **Forward secrecy** — new ephemeral keypair per pairing attempt; compromising old keys doesn't help
- **Encrypted callback** — pairing payload encrypted with NaCl secretbox (XSalsa20-Poly1305)
- **Transcript-bound trust** — v3 signs every request/callback trust field and requires the operator to compare and type the initiator fingerprint
- **Old-style rejection** — legacy (v1) plaintext pairing requests get `426 Upgrade Required`
- **Key regeneration confirmation** — rotating a peer key requires explicit confirmation since it permanently invalidates the old key
- **Storage quotas** — the receiving peer controls how much storage is available
- **Explicit acceptance scope** — every new peer requires a non-root backup directory and finite quota
- **Peer shutdown notifications** — graceful handoff when either side goes offline
- **Peer-scoped shutdown handling** — only runs bound to the authenticated peer are interrupted
- **Retry with exponential backoff** (30s → 60s → 120s) on transient network failures
- **Actionable error messages** — failed runs show specific diagnostics (auth rejected, connection refused, SSH failed, timeout, path not found) instead of generic errors
- **Real-time progress** via `--info=progress2` (Linux) or `--progress` (macOS)
- **Bounded Hyper transfer memory** — rsync file events stream into batched database writes instead of accumulating whole-run output
- **Connection testing** — test peer connectivity before creating a job
- **Private peer network policy** — all server-initiated peer requests require numeric private/VPN IPs and bounded response time; public hosts and DNS rebinding are rejected
- **Remote path browsing** — browse directories and shares on the remote peer directly from the job form, scoped to the peer's allowed path prefix
- **Confined path browsing** — filesystem pickers resolve real paths, reject symlink escapes, and hide RedMan secrets/system roots

### SSD Backup — Local Redundancy
Back up SSDs to the array with point-in-time versioning.

- **Rsync-based** with delta detection
- **Delta versioning** — stores binary diffs (`.rdelta` via `rdiff`) instead of full copies
- **Tiered retention (GFS)** — configurable hourly/daily/weekly/monthly/quarterly retention policies
- **Automatic pruning** — delta-aware and fail-closed: retained dependents are atomically promoted before a base snapshot can be deleted
- **Incremental snapshot accounting** — file counts and byte totals are persisted per snapshot; legacy scans have explicit entry/time budgets and cache an unavailable marker instead of blocking requests
- **Version browser** — browse, preview, download, and restore files from any snapshot
- **Verified restore audit** — restores copy and SHA-256 verify a same-directory temporary file before atomic replacement, recording the exact snapshot, destination, and outcome
- **Restore drill** — restore a single file or a whole folder into a different destination instead of over the original, so recovery can be proven and audited without overwriting live data. A folder drill runs as a tracked, cancellable job with progress and a free-space pre-flight check.
- **Backup health cards** — show last success, latest issue, next run, overdue state, and last verified restore without treating a completed copy as proof of recovery
- **Inline preview** — view text, images, video, and PDF files directly in the browser
- **Pre-flight checks** — validates source/dest accessibility and disk space before starting
- **Empty-source protection** — destructive SSD, Hyper, and Rclone syncs abort when their source appears unmounted or empty
- **Integrity verification** — verify delta chain correctness via API
- **Tracked deep verification** — verification runs in the background with progress, cancellation, and terminal history instead of holding an HTTP request open
- **Bounded excludes** — up to 100 normalized rsync patterns can be previewed and edited per job; excluded paths are neither copied nor deleted

#### Delta Versioning Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `delta_versioning` | off | Enable/disable delta compression |
| `delta_threshold` | 50% | Minimum savings to keep a delta vs full copy |
| `delta_max_chain` | 10 | Force keyframe (full copy) after N deltas |
| `delta_keyframe_days` | 7 | Force keyframe if oldest in chain exceeds N days |

#### Retention Policy Tiers

| Tier | Default | Behavior |
|------|---------|----------|
| Hourly | 24 hours | Keep all snapshots |
| Daily | 7 days | Keep newest per calendar day |
| Weekly | 30 days | Keep newest per ISO week |
| Monthly | 90 days | Keep newest per calendar month |
| Quarterly | 365 days | Keep newest per quarter |

Set any tier to 0 to disable. Falls back to legacy `retention_days` for backward compatibility.

#### Version Browser

| Feature | Description |
|---------|-------------|
| Snapshot picker | Compact date/tier option with file count, stored bytes, and delta savings shown below |
| Breadcrumb nav | Navigate directories, click path segments to jump back |
| Versioned badge | Files that changed since the selected snapshot |
| Delta badge | Files stored as binary deltas |
| Preview (eye icon) | Inline preview for text, images, video, and PDF |
| Download | Download any file (deltas transparently reconstructed) |
| Restore | Confirm exact snapshot/source/destination overwrite, restore, and optionally verify bytes with SHA-256 |
| Restore drill | Restore a copy into another folder — same verification and audit trail, source files untouched |
| Test restore | Restore the whole open folder into a scratch destination as a background run, with progress and cancellation |

**Previewable types:** `.txt`, `.md`, `.json`, `.csv`, `.xml`, `.html`, `.js`, `.py`, `.sh`, `.yml`, `.jpg`, `.png`, `.gif`, `.webp`, `.svg`, `.mp4`, `.webm`, `.mov`, `.pdf`

### Rclone Sync — Cloud Backup
Sync to any rclone-supported cloud provider (Google Drive, S3, Backblaze B2, etc).

- **Confined destructive paths** — download and bisync destinations are dedicated subdirectories of configured storage roots, revalidated with symlink-aware confinement at execution time
- **Credential-safe configuration** — every accepted token, key, password, and secret field is redacted from admin responses

- Upload, download, or bidirectional sync
- JSON log parsing for per-file tracking
- Bisync resync handling
- **Full remote lifecycle** — create, configure, test, update, and delete rclone remotes from the UI
- **OneDrive auto-discovery** — resolves and stores the drive ID and type from the OAuth token required by current rclone versions
- **Remote browsing** — navigate a configured remote from the job form to pick a remote path that exists, instead of typing one and finding out on the first run

### Docker Monitoring
Optional real-time container metrics and management.

- CPU and memory usage with historical charts
- Container start/stop/restart controls
- Docker availability detection
- Raw Docker access is split across minimal exact-path internal proxies built from this repository: one permits only container listing, single-snapshot stats, and network listing, while the other permits only start/stop; restart is performed as a state-filtered list followed by stop and start
- Fresh installs leave this disabled until `DOCKER_HOST` and `DOCKER_CONTROL_HOST` point to the optional proxies

### Media Import
Auto-detect USB/SD card drives and import to Immich.

- Camera detection (Canon, GoPro, Apple, Sony, etc.)
- Auto-import on drive attach
- **Folder sources** — import from a folder inside RedMan's storage roots as well as from removable media, for photos that are already on the machine
- **Google Photos takeout** — a folder source can be read as a takeout, so the archives are handed to immich-go unpacked-in-place and the dates, locations, and albums from their sidecar files survive the move
- **Online Google Photos import** — select a connected Google Drive remote and RedMan finds its Takeout folder, then saves the source without starting work until you explicitly choose Import Now or Dry Run. A real import repeatedly checks free space, downloads one `.zip`, `.tgz`, or `.tar.gz` archive, imports it into Immich, checkpoints success, removes the local staging copy, and continues. Staging uses a private source-specific folder beside the RedMan database in the persistent `/app/backend/data` bind mount, never the Docker image; only the Takeout path remains overrideable under Advanced options. Failed archives stay local for a resumable retry; source files on Google Drive are never deleted
- Optional verified cleanup: only files with per-run Immich success/duplicate evidence and unchanged size, mtime, and SHA-256 are deleted; failed, unknown, changed, or unsafe files remain
- **Drive management** — rename and configure drives; ejection is shown only when an executable `MEDIA_EJECT_HELPER` host integration is configured, without granting `CAP_SYS_ADMIN`
- **Scan & import progress** — real-time tracking of photo/video scanning and Immich uploads
- **Atomic online-import progress** — Scan, Download, Import, and Cleanup repeat for each archive in one integrated stepper; the status names the current archive and phase while the progress bar covers the complete Takeout. Live counts show scanned, uploaded, already-present, and failed assets
- **Dry runs** — every connected drive, folder source, and online Takeout source can simulate the same remaining work with `dry_run: true`. Immich receives `--dry-run`, so no server assets change; RedMan records only run/report metadata, skips retries, new checkpoints, source deletion, ejection, and `last_import_at`, and removes only temporary online archives created by that dry run. Already-checkpointed online archives remain skipped, exactly as they would in a resumed import
- **Cancellation** — every active Media Import card has a confirmed Cancel action. Cancellation targets the complete RedMan orchestrator, including remote listing, disk checks, downloads, Immich analysis, and gaps between child processes. For an online import, the confirmation asks whether its current partial download should be removed from private local staging; completed archives and Google Drive source files are never deleted
- **Unified job progress** — SSD Backup, Hyper Backup, Cloud Backup, and regular Media Import use the same inline stepper, real progress bar, elapsed time, cancellation, and feature-specific live metrics without nesting another card inside each job
- **Immich auto-discovery** — scans LAN for Immich instances, auto-fills server URL in settings
- **Immich connection testing** — verify API key and server connectivity before importing
- **Process-safe Immich credentials** — upload API keys use Immich Go's supported environment variable and never appear in child-process arguments

### Notifications
Two notification channels with granular event control:

- **ntfy.sh** — push notifications via self-hosted or public ntfy.sh server (supports no auth, token, or basic auth)
- **Browser notifications** — native desktop/mobile notifications via SSE stream
- **Granular events** — independently toggle notifications for job start/complete/fail/progress, drive attach/detach/scan, and import events
- **Consistent terminal semantics** — partial completion is a warning, cancellation is emitted after persistence, and recurring progress is rate-limited per run
- **Test endpoints** — verify both channels before relying on them

### Safety and Retention Settings

Settings → Infrastructure exposes retention for per-file run details, run summaries, routine peer audit events, security events, and container metrics. Routine telemetry uses shorter defaults while failures and security events remain longer.

The empty-source exception is isolated under **Destructive backup behavior**. Keep it disabled unless an intentionally empty source is valid: enabling it allows rsync deletion when a source mount is empty or missing.

All forms keep backend validation errors inline. Destructive and credential flows use one accessible dialog system with focus trapping/restoration, Escape handling, inert background content, and explicit consequences.

### SSH & Identity Key Management
Built-in key lifecycle for rsync transfers and peer authentication:

- **Ed25519 keypair generation** — stored in the container's data directory
- **Static identity keys** — Ed25519 keypair (`data/identity.json`) for Noise XX pairing signatures
- **Localhost authorization** — one-click setup for local rsync/Immich connections
- **Connection testing** — verify SSH access to remote hosts with friendly error messages
- **Secure connection indicator** — shield icon in the global connection badge and peer cards shows handshake version

### Authentication and Authorization

Production requires an explicit `AUTH_MODE`:

- **`proxy`** — Pangolin Badger or another trusted forward-auth proxy validates the external session. RedMan maps the normalized proxy subject to an enabled RedMan account and still applies `admin`/`viewer` permissions. Unknown identities are denied unless `PROXY_AUTO_PROVISION_ROLE=admin|viewer` is explicitly configured.
- **`local`** — RedMan provides first-admin setup, Argon2id passwords, rate-limited login with exponential lockout, opaque server-side sessions, CSRF protection, logout, password rotation, one-time recovery, account management, and authentication audit.

There is no fallback between modes. Production refuses to start when `AUTH_MODE` is absent or invalid. Proxy headers are ignored in local mode; local cookies are ignored in proxy mode.

`viewer` can inspect backup health/configuration, run history, progress, snapshots, downloads, and metrics. `admin` is required for execution/cancellation, restore, deletion, Docker mutation, peers, discovery, settings/secrets, and accounts. Undeclared API routes fail closed.

For a new local deployment, set a high-entropy `REDMAN_BOOTSTRAP_TOKEN`, start RedMan, and create the first administrator in the UI. RedMan ships no default credentials. Remove the bootstrap token after setup.

To recover a local account from the host/container shell:

```bash
cd /app/backend
npm run auth:recovery -- <username>
```

The command prints a one-time token valid for 15 minutes. Use **Use a recovery token** on the login screen. Recovery and password/role changes revoke existing sessions. Installing a database restore also revokes all restored sessions before requests are accepted.

If local mode has no enabled administrator, explicitly promote an existing local account from the host:

```bash
docker exec redman npm run auth:promote-admin -- <username>
```

Database, WAL/SHM, online backup, pending restore, and pre-restore safety files
are forced to mode `0600`; backup directories are `0700`, and only the three
newest pre-restore generations are retained. Protect the underlying backup
volume as sensitive credential storage.

See [ADR 001](docs/adr/001-authentication-modes.md) for trust boundaries, mode migration, and failure behavior.

Authentication data is stored in `auth_users`, `auth_credentials`, `auth_sessions`, `auth_recovery_events`, and `auth_audit_log`. Passwords use Argon2id; raw session and recovery tokens are never stored.

## Architecture

```
┌─────────────────────────────────┐
│         React Frontend          │  :5175 (dev) or served by Express
├─────────────────────────────────┤
│        Express API (:8090)      │  Main API — explicit proxy or local auth
│  ┌───────────┬────────────────┐ │
│  │ Scheduler │  Job Executors │ │  node-cron, rsync, rclone, immich-go
│  └───────────┴────────────────┘ │
├─────────────────────────────────┤
│      Peer API (:8091)           │  Machine-to-machine — API key auth
├─────────────────────────────────┤
│   SQLite + WAL (better-sqlite3) │  Single-file DB with migrations
└─────────────────────────────────┘
```

## Deployment

### Upgrade Readiness Bridge

The bridge release prepares an existing host without replacing its container image or applying the hardened schema. Production bridge mode pauses schedules, job mutations, drive monitoring, Docker monitoring, and the peer API until hardened cutover. Its five-step wizard:

1. assesses database health and legacy jobs, peers, media, and Docker settings;
2. creates an integrity-checked SQLite online backup;
3. generates an explicit host command for restricted Linux/Unraid SSH setup;
4. verifies the root-run helper's non-secret receipt and produces final environment configuration;
5. confirms the backup, host, configuration, and idle-job gates before cutover.

The host helper is downloaded from the official `v1.1.7` tag and verified against embedded SHA-256 values before root execution. On Unraid, the command also downloads the official rsync `v3.2.1` Perl `rrsync` support helper from upstream, verifies its pinned SHA-256, and persists it under `/boot/config/plugins/redman/` for FAT-safe `bash` boot replay. It briefly stops and restarts the same bridge container while capturing rollback metadata. The browser never receives host-root access, and the bridge never performs the final container replacement automatically.

### Generic Linux NAS (Docker Compose)

Prerequisites: Docker Compose, OpenSSH server, rsync with the `rrsync` support
script, and a numeric private IP that the other RedMan host can reach. Pass an
existing helper with `--rrsync-source` when it is not installed in a standard
location. RedMan
does not use root SSH and does not assume an existing account or group.

Clone the repository, provision the dedicated host account, and create the
host directories before starting the container:

```bash
git clone https://github.com/Rediwed/RedMan.git
cd RedMan

sudo ./scripts/setup-backup-user.sh \
  --data-dir /srv/redman \
  --backup-root /srv/redman-backups
sudo install -d -m 0750 /media

cp .env.example .env
# Edit .env: exact paths, HTTPS origin, proxy source, private PEER_HOST,
# and REDMAN_PEER_BIND set to the trusted LAN/VPN interface address.
docker compose up -d --build
```

Docker container monitoring is optional because it grants narrowly proxied
Docker control. Set both internal endpoints and enable the exact-path proxy profile
only when needed:

```bash
printf '\nDOCKER_HOST=http://docker-socket-proxy:2375\nDOCKER_CONTROL_HOST=http://docker-control-proxy:2375\n' >> .env
docker compose --profile docker-monitoring up -d --build
```

Without the profile, backup, restore, peer, media, and cloud-sync features start
normally; the Docker page reports that its endpoint is unavailable.

The account installer is idempotent. It creates a non-root, non-interactive
`redman-backup` system account and group with an unknown random credential,
installs `rrsync`, creates the root-owned managed `authorized_keys` file with
mode `0600`, and exposes it only through a fixed root-owned reader for the
restricted account. The reader emits only forced-`rrsync` entries whose
canonical path remains under an installer-approved backup root, so injected
unrestricted or escaping keys are ignored. Its OpenSSH `Match User` block
disables password and interactive authentication, validates the complete sshd
configuration, and reloads `ssh`/`sshd`.
New backup roots are created as `root:redman-backup` with mode `2770`, allowing
the capability-restricted container owner and forced-command SSH group to write
without granting general permission bypass.

The application process retains UID 0 because backup sources can use unrelated
host ownership that has no portable container UID mapping. Its Linux capability
set is nevertheless dropped completely except `DAC_READ_SEARCH`: it has no host
network, no direct Docker socket, no write-bypass capability, and only explicit
host mounts. Writes therefore still obey normal ownership and mode bits; the
managed host key file and new backup roots use the narrow ownership model above.
If validation or reload fails, it restores the original configuration. Use
`--dry-run` to inspect all resolved paths without requiring root.

The shipped Compose file is path-neutral:

```yaml
services:
  redman:
    build: .
    container_name: redman
    mem_limit: ${REDMAN_MEMORY_LIMIT:-1536m}
    memswap_limit: ${REDMAN_MEMORY_SWAP_LIMIT:-2048m}
    cpus: ${REDMAN_CPU_LIMIT:-2}
    pids_limit: ${REDMAN_PIDS_LIMIT:-256}
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    ports:
      - "127.0.0.1:8090:8090" # adjust only when your reverse proxy requires it
    volumes:
      - ${REDMAN_DATA_PATH}:/app/backend/data
      - ${REDMAN_STORAGE_PATH}:${REDMAN_STORAGE_PATH}
      - ${REDMAN_MEDIA_PATH}:${REDMAN_MEDIA_PATH}
      - ${REDMAN_HOST_AUTHORIZED_KEYS_PATH}:/host-ssh/authorized_keys
    environment:
      - NODE_ENV=production
      - AUTH_MODE=proxy
      - REDMAN_PUBLIC_ORIGIN=https://redman.example.com
      - TRUSTED_PROXIES=172.20.0.5/32  # replace with the exact source RedMan sees
      - PORT=8090
      - PEER_API_PORT=8091
      - PEER_HOST=10.10.0.2  # SSH address reachable by the other RedMan peer
      - SSH_USER=redman-backup
      - RRSYNC_PATH=/usr/local/bin/rrsync
      - REDMAN_STORAGE_ROOTS=${REDMAN_STORAGE_PATH},${REDMAN_MEDIA_PATH}
      - REDMAN_MEDIA_ROOT=${REDMAN_MEDIA_PATH}
      - REDMAN_SHARE_CONFIG_DIR=
      - REDMAN_UPGRADE_BRIDGE=false
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:8090/api/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"]
      interval: 30s
      timeout: 10s
      start_period: 10s
      retries: 3
    restart: unless-stopped

```

On first start, RedMan creates the complete database schema through idempotent
migrations. Seeding is optional development/demo setup and is never required for
a fresh production volume. Compose refuses to start when required host paths or
security values are missing. This prevents Docker from silently creating a
directory where the host `authorized_keys` file should be.

Media Import simulations are stored in the shared run history with
`backup_runs.dry_run = 1`, so API consumers and the UI can distinguish projected
upload counts from completed uploads after the live process has ended.

Proxy mode denies unknown identities by default. Provision the expected Badger
subject from the container host, then sign in through Pangolin:

```bash
docker exec redman npm run auth:provision-proxy -- "user@example.com" admin "Example Admin"
```

`PROXY_AUTO_PROVISION_ROLE` is available only as an explicit temporary migration
option. Do not leave admin auto-provisioning enabled.

#### Upgrade-readiness bridge image

The bridge is source-only until an immutable image is published. Check out the exact `v1.1.9` tag and use the app-data-only Compose definition above. Do not import an old Community Applications template: those templates may restore the Docker socket, share mounts, peer port, or mutable `latest` image that this maintenance bridge deliberately removes. Earlier `v1.1.x` tags are superseded for production installation; `v1.1.9` adds detected settings, persistent configuration readiness, and an explicit stop/wait outcome to the clean-Unraid, FAT-safe, corrected auth, large-database, frontend, and assessment workflow.

#### Generic Linux rollback

Stop RedMan, remove its marked OpenSSH block, validate, and reload SSH. The
installer preserves the pre-RedMan configuration once at
`/etc/ssh/sshd_config.redman-backup.orig`.

```bash
docker compose down
sudo sed -i '/^# BEGIN REDMAN BACKUP USER: redman-backup$/,/^# END REDMAN BACKUP USER: redman-backup$/d' /etc/ssh/sshd_config
sudo sshd -t
sudo systemctl reload sshd 2>/dev/null || sudo systemctl reload ssh
# Optional after confirming no peer needs it:
sudo userdel redman-backup
sudo groupdel redman-backup
```

### Fresh Unraid

The Unraid host recreates custom users at boot, so use the dedicated wrapper.
Run this from a terminal before creating the RedMan container:

```bash
git clone https://github.com/Rediwed/RedMan.git /mnt/user/appdata/redman-src
cd /mnt/user/appdata/redman-src
./scripts/setup-unraid-backup-user.sh \
  --data-dir /mnt/user/appdata/redman \
  --backup-root /mnt/user/cross-site
```

The wrapper calls the same portable installer and then persists both scripts in
`/boot/config/plugins/redman/`, adding one idempotent `bash` boot command to
`/boot/config/go`. If Unraid ships rsync without `rrsync`, the wrapper downloads
the official rsync `v3.2.1` Perl helper over TLS, verifies its pinned SHA-256,
and persists it in the same directory. This supports Unraid without Python and
does not rely on executable bits being preserved by the FAT boot volume.

Build the image as `redman:latest`, then import `unraid/redman.xml` as a custom
template. The template pre-configures native `/mnt/user`, `/mnt/cache`,
`/mnt/disks`, and `/boot/config/shares` mappings plus the exact managed
`authorized_keys` file. It deliberately does not publish peer port 8091; add a
trusted LAN/VPN-only mapping with host/network firewall restrictions only when
inbound pairing and backups are required. Do not start it before the bootstrap
creates the managed key file.

```bash
docker build -t redman:latest .
```

#### Remote deploy helper

```bash
bash deploy.sh --custom       # Deploy an environment-configured public target
bash deploy.sh --profile nas  # Deploy a gitignored local named profile
bash deploy.sh --custom --check
bash deploy.sh --custom --force
```

The helper supports any clean Linux or Unraid target through `--custom`.
Validate the non-secret resolved configuration before deployment:

```bash
export REDMAN_DEPLOY_SSH=admin@nas.example
export REDMAN_DEPLOY_SOURCE_PATH=/srv/redman-src
export REDMAN_DEPLOY_DATA_PATH=/srv/redman
export REDMAN_DEPLOY_STORAGE_PATH=/srv/redman-backups
export REDMAN_DEPLOY_MEDIA_PATH=/media
export REDMAN_DEPLOY_PLATFORM=linux       # or unraid
export REDMAN_DEPLOY_DOCKER_PREFIX=sudo  # empty when the SSH user runs Docker
export REDMAN_DEPLOY_WEB_BIND=127.0.0.1
export REDMAN_DEPLOY_DOCKER_MONITORING=false
export REDMAN_DEPLOY_TZ=UTC              # or an IANA zone such as Europe/Amsterdam
export REDMAN_DEPLOY_AUTH_MODE=local
export REDMAN_DEPLOY_PUBLIC_ORIGIN=https://redman.example.com
export REDMAN_DEPLOY_TRUSTED_PROXIES=10.0.0.5/32
export REDMAN_DEPLOY_PEER_HOST=192.168.1.20
export REDMAN_DEPLOY_PEER_BIND=192.168.1.20
export REDMAN_DEPLOY_GUARD_SECONDS=600
export REDMAN_DEPLOY_HEALTH_TIMEOUT_SECONDS=120
export REDMAN_DEPLOY_OBSERVATION_SECONDS=120

./deploy.sh --custom --print-config
./deploy.sh --custom
```

No target is selected implicitly. Running `deploy.sh` without `--custom` or an
explicit `--profile NAME` exits without contacting a host. Reusable profiles
belong in gitignored `.redman-deploy-profiles.sh`; copy
`deploy-profiles.example.sh` as a starting point. Multiple `--profile NAME`
arguments deploy sequentially and stop at the first failed target.

The activity gate treats both `running` and `cancelling` runs as active. A
Media Import must finish its bounded child-process termination before a normal
deployment can replace the container; `--wait-for-idle` waits for that state to
settle instead of interrupting it.

The script runs syntax and compatibility checks, provisions the platform-specific
backup account, builds locally on the target, and preserves auth/trust values
from an existing container when a profile leaves them unset. The host must have
the Container Breakglass plugin commands `container-breakglass` and
`container-deploy-guard` installed. Before replacement, the helper saves the
existing container inspection and tags its image under `redman:rollback-*`, then
arms a target-specific 10-minute deadman guard.

The replacement starts with restart policy `no` and preserves any existing
Docker/Unraid UI memory, memory+swap, CPU, CPU-set, CPU-share, and PID settings.
Deployment does not invent limits when none exist and does not apply runtime
limits to image builds. After application health succeeds,
the helper observes application health, Unraid WebUI responsiveness (on Unraid),
available host memory, container state, and OOM state for two minutes. Only then
does it restore the existing restart policy, writes a mode-`0600` allowlisted
runtime reconstruction receipt below `deploy-current/`, and disarms the guard.
Full pre-replacement Docker inspection is retained separately as sensitive,
mode-`0600` rollback metadata. A failed canary immediately
latches and kills only RedMan; loss of the deploy session causes the host-side
deadman to do the same at expiry.

A persistent breakglass latch is never cleared implicitly. After reviewing the
failure and rollback assets, pass `--clear-breakglass-latch` explicitly for the
next deployment. Deployment also verifies that the loaded breakglass and guard
scripts match the SHA-256 values embedded in the persistent Unraid plugin
manifest. Guard, observation, and host-safety floors can be overridden through
the corresponding `REDMAN_DEPLOY_*` environment values.

Set `REDMAN_DEPLOY_DOCKER_MONITORING=true` to provision the pinned socket-proxy
sidecars. Only those minimal proxies mount `/var/run/docker.sock`; RedMan itself never does.

### Development

```bash
cd app && npm install
./start-dev.sh
# Opens frontend at http://localhost:5175
# Backend at http://localhost:8090
# Peer API at http://localhost:8091 outside production bridge mode
```

Run bridge release checks with:

```bash
./scripts/release.sh check
```

Run the repeatable local release gate before pushing or deploying:

```bash
npm --prefix app exec playwright install chromium  # one-time per Playwright version
npm --prefix app run validate
```

It runs ESLint, focused and integration regressions, a clean-volume startup,
the compatibility contract, a production frontend build, a full dependency
audit, desktop/mobile Chromium smoke tests with Axe accessibility checks, and a
real greenfield Linux/OpenSSH scoped-rsync test in an isolated container. The
production dependency stage removes upstream SSH/certificate test-key fixtures;
the greenfield image check prevents them from returning on dependency updates.
Playwright traces and browser databases stay under ignored `test/data/` paths.

On a Docker-capable development host, the real greenfield SSH acceptance test
provisions a pristine Linux/OpenSSH container and verifies scoped rsync succeeds
while arbitrary commands and `..` escapes fail:

```bash
npm --prefix app run test:greenfield
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8090` | Main API + UI port (1-65.535; must differ from `PEER_API_PORT`) |
| `PEER_API_PORT` | `8091` | Peer-to-peer API port (1-65.535; canonical name in every launch artifact) |
| `DB_PATH` | `data/redman.db` | SQLite database path |
| `AUTH_MODE` | required in production | `proxy` for Pangolin/forward-auth or `local` for RedMan login |
| `PROXY_AUTO_PROVISION_ROLE` | unset | Temporary explicit `admin`/`viewer` role for unknown trusted identities; host provisioning is preferred and persistent admin auto-provisioning is unsafe |
| `REDMAN_BOOTSTRAP_TOKEN` | unset | One-time high-entropy first-admin token for a clean local-mode database |
| `REDMAN_PUBLIC_ORIGIN` | required in production | Exact HTTPS origin, e.g. `https://redman.example.com`, allowed to submit credentials and proxy-mode mutations |
| `SESSION_IDLE_MINUTES` | `30` | Local session idle timeout (5-1.440 minutes) |
| `SESSION_ABSOLUTE_HOURS` | `24` | Local session absolute lifetime (1-720 hours) |
| `SESSION_COOKIE_SECURE` | `true` in production | Secure-cookie enforcement; local production auth refuses an insecure override |
| `RECOVERY_TOKEN_MINUTES` | `15` | One-time recovery token lifetime (5-60 minutes) |
| `AUTH_DISABLED` | `false` | Development bypass; requires `REDMAN_LOCAL_DEV=1` and non-production mode |
| `TRUSTED_PROXIES` | required in production | Exact proxy source host IPs only; production accepts bare hosts, IPv4 `/32`, or IPv6 `/128` and rejects wildcard or broader ranges |
| `REDMAN_UPGRADE_BRIDGE` | `false` | Opt-in maintenance mode that pauses non-wizard mutations, schedulers, monitoring, and the peer API |
| `REDMAN_ADMIN_GROUP` | unset | Exact forward-auth group permitted to perform upgrade preparation while bridge mode is enabled; set this and/or `REDMAN_ADMIN_ROLE` |
| `REDMAN_ADMIN_ROLE` | unset | Exact forward-auth role permitted to perform upgrade preparation; Pangolin Badger sends this as `Remote-Role` |
| `PEER_HOST` | required in production | Numeric private SSH IP advertised to peers; also the preferred pairing callback address; wildcard, public, and DNS values are rejected |
| `REDMAN_MEMORY_LIMIT` | `1536m` | Compose memory limit for the RedMan container |
| `REDMAN_MEMORY_SWAP_LIMIT` | `2048m` | Compose combined memory and swap limit |
| `REDMAN_CPU_LIMIT` | `2` | Compose CPU limit |
| `REDMAN_PIDS_LIMIT` | `256` | Compose process limit |
| `REDMAN_HOST_AUTHORIZED_KEYS_PATH` | required by Compose | Host `authorized_keys` file for the restricted `redman-backup` account; run the host setup script first |
| `REDMAN_DATA_PATH` | required by Compose | Host directory for SQLite, identity keys, SSH client keys, logs, and rclone config |
| `REDMAN_STORAGE_PATH` | required by Compose | Dedicated host backup/storage root mounted at the same absolute container path for `rrsync` compatibility |
| `REDMAN_MEDIA_PATH` | required by Compose | Host removable-media root mounted at the same absolute container path |
| `REDMAN_STORAGE_ROOTS` | platform defaults | Comma-separated absolute container paths allowed in local path pickers |
| `REDMAN_MEDIA_ROOT` | `/mnt/disks` | Absolute container path monitored for removable media |
| `REDMAN_SHARE_CONFIG_DIR` | `/boot/config/shares` | Unraid share config directory; set empty on generic Linux |
| `REDMAN_WEB_BIND` | `127.0.0.1` | Compose host address for the web UI/main API |
| `REDMAN_WEB_PORT` | `8090` | Host port published for the web UI/main API |
| `REDMAN_PEER_BIND` | required by Compose | Trusted private LAN/VPN interface address for the peer API; wildcard binding is never the default |
| `REDMAN_PEER_PUBLISHED_PORT` | `8091` | Host port published for the peer API; `PEER_API_PORT` remains the internal listener |
| `DOCKER_HOST` | unset | Optional credential-free read-only Docker proxy origin; raw Unix sockets are rejected |
| `DOCKER_CONTROL_HOST` | unset | Optional lifecycle-only Docker proxy origin for start/stop controls; restart uses those two calls |
| `SSH_USER` | `redman-backup` | Dedicated non-root SSH user for forced-command rsync transfers |
| `RRSYNC_PATH` | `/usr/local/bin/rrsync` | Host path embedded in restricted peer authorized-key entries |
| `SSH_PORT` | `22` | SSH port for rsync transfers (1-65.535) |
| `NODE_ENV` | — | Set to `production` for static frontend serving |
| `HOSTNAME` | — | Used in SSH key comments (`redman@<HOSTNAME>`) |

## Production Hardening

RedMan includes several features for reliable operation with multi-TB datasets:

> In the intermediate readiness bridge, transfer, scheduling, media, peer, and Docker operations are intentionally paused. The descriptions below document normal RedMan behavior before and after the bridge.

### Transfer Resilience
- **`--partial` + `--partial-dir`** — interrupted transfers resume where they left off instead of restarting
- **`--timeout=300`** — aborts if no data is transferred for 5 minutes (prevents hung processes)
- **SSH keepalive** — sends probes every 60 seconds to detect dead connections
- **Automatic retry** — transient failures (network timeouts, connection refused) retry up to 3 times with exponential backoff

### Process Safety
- **Fatal restart discipline** — uncaught exceptions and rejections run bounded cleanup, close SQLite, and exit non-zero for Docker restart
- **Orphaned job cleanup** — on startup, any jobs stuck as "running" from a previous crash are marked as failed
- **Graceful shutdown** — on SIGTERM/SIGINT: closes listeners and timers → notifies peers → waits for rsync/Rclone/Immich children → updates DB → closes SQLite
- **Docker healthcheck** — container health monitored at `/api/health`
- **WAL-safe database recovery** — automatic database copies run at most once per 24 hours, rotate before writing, and are integrity-checked in a timeout-bounded child process; restore staging uses bounded asynchronous copy/validation, and startup preserves the previous DB/WAL set until the candidate is installed and verified
- **Observable SSD post-processing** — backup runs remain active through bounded, cancellable delta compression, snapshot pruning, version statistics, and database backup, with per-stage timing and retained warnings before terminal status is persisted
- **Cgroup-aware workload budget** — RedMan reads effective cgroup v2 memory, CPU, and PID ceilings at runtime and scales delta concurrency between one and four workers; unlimited or unavailable cgroups use a conservative two-worker fallback
- **Bounded database retention** — one cleanup owner starts 60 seconds after readiness, deletes at most 100 run-file rows and 1.000 telemetry rows per transaction, yields between at most 25 batches, stops scheduling work after a 30-second cycle budget, waits six hours even when incomplete, and cancels between batches during shutdown
- **Bounded temporary cleanup** — delta reconstruction uses a private mode-`0700` temp directory; each delayed cleanup cycle scans at most 1.000 entries and removes at most 100 stale files without overlapping a prior cycle
- **Non-root peer transfers** — API input, runtime configuration, and execution all reject `root`; migration 17 converts legacy jobs to the restricted `redman-backup` account
- **Fail-closed peer SSH startup** — up to 100 enabled peer grants are reconciled into the host-managed restricted key file at startup; unsafe or unverifiable paired grants are disabled while explicitly external manual peers remain untouched
- **Data-scoped SSH identity** — RedMan reads and generates client keys only below its persisted data directory and never migrates, replaces, or symlinks the process user’s `~/.ssh`
- **Bounded pairing ingress** — unauthenticated Noise pairing uses a 32 KB body ceiling, strict field/key sizes, a dedicated 30-attempt/10-minute IP limit, 20 active and 500 total incoming-row caps, read-only UI queries, and delayed 1.000-row expiry/history batches
- **Bounded startup migrations** — potentially heavy backfills and index builds preflight with cheap absolute table rowid limits plus a 1 GiB free-space floor; oversized databases fail closed for controlled offline migration, while credential conversion uses resumable 100-row transactions capped at 10.000 rows
- **Isolated media retries** — each Immich import run receives a unique mode-`0700` retry directory and removes only its own symlink tree

### Storage Management
- **Per-peer storage quotas** — the receiving NAS controls how much space a peer can use
- **Pre-flight disk space checks** — SSD backups abort if destination has less than 1 GB free
- **Automatic version pruning** — old snapshots cleaned up based on retention policy after each backup
- **Tiered retention** — keep hourly snapshots for 24h, daily for 7 days, weekly for 30, monthly for 90, quarterly for a year (all configurable)
- **Typed settings contract** — only documented keys can be updated; values are normalized and validated by type, range, enum, URL, timezone, or path policy

### Frontend Resilience
- **Auto-reconnect** — when the backend restarts (deploys, crashes, `node --watch`), the UI detects the disconnection and automatically refetches all page data once the backend comes back
- **Adaptive health polling** — checks every 5s normally, every 2s when disconnected, for fast recovery
- **Connection badge** — header shows live connected/offline status with latency, uptime, memory, version info, and per-peer secure/legacy handshake indicators
- **Instance name in title** — navbar and browser tab show "RedMan — InstanceName" when an instance name is configured in Settings, making it easy to distinguish between multiple deployments
- **User Name** — personalize your deployment with a user name in Settings

### Scheduling
- **Skip-if-running** — prevents overlapping executions of the same job
- **Transactional run claims** — manual and scheduled triggers share the same overlap guard and return the active run ID
- **Skip notifications** — alerts after 5 consecutive skips (schedule too aggressive)
- **Persistent across restarts** — cron schedules loaded from DB on boot
- **Exact cron behavior** — 5-field expressions are validated before persistence and next-run times use `cron-parser`; the UI preserves minutes and 8-hour intervals

## Peer Setup (Hyper Backup)

To set up cross-site backup between two NAS units:

### Auto-Discovery Pairing (Recommended)

1. Go to **Hyper Backup** and click **Discover Peers** — RedMan scans the local network
2. Click **Connect** on the discovered peer, and optionally tick **Also let … back up to me** to offer space in return
3. The remote peer's UI shows a pairing request with the sender's identity fingerprint (with a copy button, so both operators can compare the exact string)
4. Click **Accept** — both sides perform a Noise XX handshake:
   - Ephemeral X25519 keypairs generated on both sides
   - Each signs their ephemeral key with their static Ed25519 identity
   - ECDH shared secret computed → API key derived via HKDF (never sent over the wire)
   - Callback payload encrypted with NaCl secretbox
5. Both peers now have matching derived API keys and authorized SSH keys
6. Create a Hyper Backup job using the paired destination

The connection badge (top-left) shows a green shield (🛡️) for secure v2-paired peers or an amber shield for legacy pairings.

#### Bi-Directional Pairing (Optional)

By default a pairing sets up one direction: the initiator gets to back up to the receiver. Ticking **Also let … back up to me** adds a *reciprocal offer* — a backup path and quota on the initiator's own instance — to the pairing request:

- The offer is part of the **signed handshake transcript**, so the receiver knows it really came from the peer it verified, and tampering invalidates the signature
- The receiver sees the offered path and quota in its accept dialog and can take it up or decline just that part; declining the offer still completes the normal one-way pairing
- The reverse API key is derived from the same ECDH secret under a separate HKDF label, so like the forward key it is **never transmitted**
- On acceptance the initiator authorises the peer against its own offered path, and the receiver stores the offered space as a destination — both directions are usable immediately

The receiver always keeps control: it decides its own path and quota for the inbound direction, and can only accept an offer the peer actually signed.

#### Callback Address Resolution

A pairing request carries the URL the remote peer must call back on. RedMan resolves it in this order and uses the first result:

1. **Settings → Infrastructure → Peer API URL** (`peer_api_url`) — explicit operator override, validated as a private base URL before it is signed
2. **`PEER_HOST`** — the private IP already declared as peer-reachable (required in production)
3. **Host network interfaces** — bare metal, host networking, and macvlan containers

Containers on a Docker bridge network only see their own `172.x` address, which no peer can reach, so step 3 deliberately ignores those ranges. If nothing resolves, pairing fails with an error naming both fixes instead of guessing.

### Manual Setup (Legacy)

On the receiving NAS (your dad's):

1. Go to **Settings → Peers** and create a new authorized peer
2. Set the **allowed path prefix** below the bootstrapped host root (for example `/srv/redman-backups/your-name`, or `/mnt/user/backups/your-name` on Unraid)
3. Set a **storage limit** (e.g., 4 TB) — 0 for unlimited
4. Copy the generated API key (shown only once)

On the sending NAS (yours):

1. Go to **Hyper Backup → New Job**
2. Enter the remote peer URL (`http://<remote-ip>:8091`)
3. Paste the API key from step 4 above
4. Configure local path, remote path, direction (push/pull), and schedule

Peers authenticate via per-peer API keys. Each peer can have its own path restriction and storage quota. All peer API activity is logged in the audit log.

> **Key rotation:** Regenerating a peer API key permanently invalidates the old key. The UI shows a confirmation warning before proceeding. After rotation, update the key on any remote instance that references it.

### Error Diagnostics

Failed Hyper Backup runs display specific error messages in the run detail modal:

| Failure | Message Shown |
|---------|---------------|
| Peer not running | "Remote peer is unreachable — connection refused" |
| Bad API key | "Authentication failed — the API key was rejected" |
| Peer shut down mid-transfer | "Connection was reset. The peer may have shut down" |
| Network timeout | "Connection timed out. Check network connectivity" |
| DNS failure | "Could not resolve hostname. Check the remote URL" |
| SSH connection failed | "Verify the remote host is reachable and SSH is enabled" |
| Bad source/dest path | Extracted rsync error (e.g. "No such file or directory") |
| Transfer interrupted | "Transfer was interrupted by a signal" |
| Transfer timeout | "Remote host stopped responding during transfer" |

On macOS, rsync error lines are extracted from stdout (the PTY wrapper merges stderr into stdout). Unrecognized exit codes fall back to the rsync exit code description table.

### Peer Shutdown Handling

When a RedMan instance shuts down (Docker stop, system reboot, etc.):
1. It notifies all connected peers via `POST /peer/shutdown`
2. The receiving peer marks any active transfers as failed with a clear message
3. The receiving peer sends a notification (ntfy/browser) so the user knows
4. On next scheduled run, the transfer will resume from where `--partial` left off

## API

All feature routes are prefixed with `/api/` and pass through the selected authentication provider plus declared route authorization. Local development can bypass authentication only when both `AUTH_DISABLED=true` and `REDMAN_LOCAL_DEV=1` are set outside production.

| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | Readiness and version (unauthenticated; host/runtime/operation fields redacted) |
| `GET /api/health/details` | Full host/runtime health details (authenticated) |
| `/api/auth/*` | Mode status, bootstrap, login/logout, recovery, sessions, passwords, users, and auth audit |
| `/api/ssd-backup/*` | SSD backup configs, runs, version browser, delta verification |
| `/api/hyper-backup/*` | Hyper Backup jobs and run history |
| `/api/rclone/*` | Rclone sync jobs |
| `/api/docker/*` | Container list, metrics, controls |
| `/api/overview/*` | Dashboard stats |
| `/api/settings/*` | App settings, notifications, SSH key management, DB backup & recovery |
| `/api/peers/*` | Authorized peer management, audit log |
| `/api/media-import/*` | Drive detection, folder sources, and Immich import |
| `/api/filesystem/*` | Path browsing |
| `/api/external-jobs/*` | External job registration, health, and run history (authenticated) |
| `POST /api/external-jobs/heartbeat/:slug` | Heartbeat ingest for schedules on other hosts (per-job Bearer token, not a user session) |
| `/api/events/*` | Event history and severity summary |
| `GET /api/status` | Normalized status board across backups, external jobs, containers, and peers |

#### External job heartbeats

Schedules that RedMan does not run itself report in with one request. Register the
job, declare the schedule you expect it to keep, and RedMan raises it as overdue
when a report fails to arrive within the grace period:

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $REDMAN_HEARTBEAT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"exit_code\":$?,\"duration_seconds\":$SECONDS}" \
  https://redman.example/api/external-jobs/heartbeat/my-nightly-job
```

Omit `cron_expression` for jobs that run irregularly; without a declared schedule
a job is never reported late. The endpoint keeps accepting heartbeats during
upgrade-bridge mode so a maintenance window does not create false overdue alarms.

#### Heartbeats from hosts that cannot reach RedMan

A host outside the network has no route in, so it leaves a signed line on an ntfy
topic instead and RedMan collects it on its own outbound polls. Enable it under
**Settings → Notifications → Collect heartbeats from a topic**.

```
redman-hb1 <slug> <unix-ts> <exit|-> <duration|-> <signature> <message>
```

The signature is `HMAC-SHA256` over the five fields that precede it, joined by
newlines and taken **exactly as they appear on the wire** — including the `-`
that stands for an absent number. The key is the SHA-256 of the job's ingest
token, a value the reporting host can derive and RedMan already stores, so no
secret ever crosses the broker.

One detail decides whether it verifies: the slug is signed as RedMan normalises
it, meaning lower case with anything outside `a-z 0-9 . _ -` replaced by `-`.

Because command substitution strips trailing newlines, pipe `printf` straight
into `openssl` rather than storing the payload in a variable first:

```bash
slug="$(printf '%s' "$slug" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9._-' '-')"
key="$(printf '%s' "$REDMAN_HEARTBEAT_TOKEN" | sha256sum | cut -d' ' -f1)"
sig="$(printf '%s\n%s\n%s\n%s\n%s' "$slug" "$ts" "$code" "$duration" "$message" \
  | openssl dgst -sha256 -hmac "$key" -hex | awk '{print $NF}')"

printf '%s %s %s %s %s %s %s' \
  redman-hb1 "$slug" "$ts" "$code" "$duration" "$sig" "$message"
```

**Choose a topic nobody can guess, and do not reuse the notification topic.**
Anyone who knows the topic name can read every heartbeat on it and publish to it.
Signing means they cannot invent a result or alter one, and a repeat of a line
already recorded is rejected, so a captured message cannot be re-posted to hide a
job that has since stopped running. What they can still learn is which schedules
exist and whether they are passing.

Messages older than 15 minutes are refused, which is also how far back each poll
reads. A missed poll or a restart therefore heals on the next round rather than
leaving a permanent gap. The reporting host needs a clock within that tolerance;
without NTP a drifting host has every heartbeat refused.

### Peer API (port 8091)

Machine-to-machine endpoints authenticated via Bearer API key:

| Endpoint | Description |
|----------|-------------|
| `GET /peer/health` | Instance info and version |
| `POST /peer/backup/prepare` | Validate path, check quota, return SSH info |
| `POST /peer/backup/complete` | Transfer completion notification |
| `GET /peer/backup/status/:runId` | Check transfer status |
| `GET /peer/storage` | Query storage usage and quota |
| `POST /peer/shutdown` | Graceful shutdown notification |

## Testing

See [test/README.md](test/README.md) for the full test environment documentation including test data generation, two-instance setup, and delta versioning tests.

```bash
# Quick start
python test/generate_test_data.py --size small
./test/setup_local_test.sh
open http://localhost:5175
```

Focused audit regressions run with `cd app && npm run test:mitigations` and are
included in `pre-push.sh`.

## Tech Stack

- **Backend:** Node.js, Express, better-sqlite3, node-cron
- **Frontend:** React 18, Vite, react-router-dom, lucide-react
- **Transfer:** rsync, rclone, and rdiff in normal RedMan releases; deliberately omitted from the readiness bridge image
- **Import:** immich-go in normal RedMan releases; deliberately omitted from the readiness bridge image
- **System tools:** storage/media tools return with the hardened release after bridge preparation
- **Container:** Docker (node:20-alpine), dockerode
- **Target platform:** Unraid and generic Linux NAS hosts; macOS is supported for development/testing

# RedMan

Homelab backup and management tool built for Unraid. Handles cross-site replication between NAS units (Hyper Backup), local SSD-to-array backups with delta versioning, cloud sync via rclone, Docker container monitoring, and camera media import.

Built with Express + SQLite on the backend and React + Vite on the frontend. Runs as a single Docker container.

## Features

### Hyper Backup — Cross-Site Replication
Push or pull data between two RedMan instances over rsync/SSH. Designed for multi-TB datasets between remote NAS units.

- **Rsync over SSH** with `--partial` for resumable transfers
- **SSH keepalive** (`ServerAliveInterval=60`) prevents silent drops on long transfers
- **Per-peer authentication** with 256-bit API keys, audit logging, and path restrictions
- **Key regeneration confirmation** — rotating a peer key requires explicit confirmation since it permanently invalidates the old key
- **Storage quotas** — the receiving peer controls how much storage is available
- **Peer shutdown notifications** — graceful handoff when either side goes offline
- **Retry with exponential backoff** (30s → 60s → 120s) on transient network failures
- **Actionable error messages** — failed runs show specific diagnostics (auth rejected, connection refused, SSH failed, timeout, path not found) instead of generic errors
- **Real-time progress** via `--info=progress2` (Linux) or `--progress` (macOS)
- **Connection testing** — test peer connectivity before creating a job

### SSD Backup — Local Redundancy
Back up SSDs to the array with point-in-time versioning.

- **Rsync-based** with delta detection
- **Delta versioning** — stores binary diffs (`.rdelta` via `rdiff`) instead of full copies
- **Tiered retention (GFS)** — configurable hourly/daily/weekly/monthly/quarterly retention policies
- **Automatic pruning** — delta-aware: promotes dependent keyframes before deleting snapshots
- **Version browser** — browse, preview, download, and restore files from any snapshot
- **Inline preview** — view text, images, video, and PDF files directly in the browser
- **Pre-flight checks** — validates source/dest accessibility and disk space before starting
- **Integrity verification** — verify delta chain correctness via API

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
| Snapshot picker | Dropdown with tier badge, file count, and delta savings % |
| Breadcrumb nav | Navigate directories, click path segments to jump back |
| Versioned badge | Files that changed since the selected snapshot |
| Delta badge | Files stored as binary deltas |
| Preview (eye icon) | Inline preview for text, images, video, and PDF |
| Download | Download any file (deltas transparently reconstructed) |
| Restore | Restore any file back to the source path |

**Previewable types:** `.txt`, `.md`, `.json`, `.csv`, `.xml`, `.html`, `.js`, `.py`, `.sh`, `.yml`, `.jpg`, `.png`, `.gif`, `.webp`, `.svg`, `.mp4`, `.webm`, `.mov`, `.pdf`

### Rclone Sync — Cloud Backup
Sync to any rclone-supported cloud provider (Google Drive, S3, Backblaze B2, etc).

- Upload, download, or bidirectional sync
- JSON log parsing for per-file tracking
- Bisync resync handling
- **Full remote lifecycle** — create, configure, test, update, and delete rclone remotes from the UI
- **Remote browsing** — list contents of configured remotes

### Docker Monitoring
Real-time container metrics and management.

- CPU and memory usage with historical charts
- Container start/stop/restart controls
- Docker availability detection

### Media Import
Auto-detect USB/SD card drives and import to Immich.

- Camera detection (Canon, GoPro, Apple, Sony, etc.)
- Auto-import on drive attach
- Optional delete-after-import and eject-after-import
- **Drive management** — rename, configure, and eject drives from the UI
- **Scan & import progress** — real-time tracking of photo/video scanning and Immich uploads
- **Immich connection testing** — verify API key and server connectivity before importing

### Notifications
Two notification channels with granular event control:

- **ntfy.sh** — push notifications via self-hosted or public ntfy.sh server (supports no auth, token, or basic auth)
- **Browser notifications** — native desktop/mobile notifications via SSE stream
- **Granular events** — independently toggle notifications for job start/complete/fail/progress, drive attach/detach/scan, and import events
- **Test endpoints** — verify both channels before relying on them

### SSH Key Management
Built-in SSH key lifecycle for rsync transfers:

- **Ed25519 keypair generation** — stored in the container's data directory
- **Localhost authorization** — one-click setup for local rsync/Immich connections
- **Connection testing** — verify SSH access to remote hosts with friendly error messages

## Architecture

```
┌─────────────────────────────────┐
│         React Frontend          │  :5175 (dev) or served by Express
├─────────────────────────────────┤
│        Express API (:8090)      │  Main API — Authelia-protected
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

### Docker (recommended)

```yaml
# docker-compose.yml
services:
  redman:
    build: .
    container_name: redman
    ports:
      - "8090:8090"   # Web UI + API
      - "8091:8091"   # Peer API
    volumes:
      - db-data:/app/backend/data
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - /boot/config/shares:/boot/config/shares:ro  # Unraid share detection
      - /mnt/user:/mnt/user:ro
      - /mnt/cache:/mnt/cache:ro
      - type: bind
        source: /mnt/disks
        target: /mnt/disks
        bind:
          propagation: rslave
    environment:
      - NODE_ENV=production
      - PORT=8090
      - PEER_PORT=8091
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:8090/api/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"]
      interval: 30s
      timeout: 10s
      start_period: 10s
      retries: 3
    restart: unless-stopped

volumes:
  db-data:
```

```bash
docker compose up -d
```

### Unraid

Install via Community Applications or manually import `unraid/redman.xml` as a template. The template pre-configures all required paths and ports.

### Development

```bash
cd app && npm install
./start-dev.sh
# Opens frontend at http://localhost:5175
# Backend at http://localhost:8090
# Peer API at http://localhost:8091
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8090` | Main API + UI port |
| `PEER_API_PORT` | `8091` | Peer-to-peer API port |
| `DB_PATH` | `data/redman.db` | SQLite database path |
| `AUTH_DISABLED` | `false` | Disable Authelia auth (dev only) |
| `PEER_HOST` | `0.0.0.0` | IP address advertised to peers |
| `SSH_USER` | `root` | SSH user for rsync transfers |
| `SSH_PORT` | `22` | SSH port for rsync transfers |
| `NODE_ENV` | — | Set to `production` for static frontend serving |
| `HOSTNAME` | — | Used in SSH key comments (`redman@<HOSTNAME>`) |

## Production Hardening

RedMan includes several features for reliable operation with multi-TB datasets:

### Transfer Resilience
- **`--partial` + `--partial-dir`** — interrupted transfers resume where they left off instead of restarting
- **`--timeout=300`** — aborts if no data is transferred for 5 minutes (prevents hung processes)
- **SSH keepalive** — sends probes every 60 seconds to detect dead connections
- **Automatic retry** — transient failures (network timeouts, connection refused) retry up to 3 times with exponential backoff

### Process Safety
- **Global exception handlers** — `uncaughtException` and `unhandledRejection` are caught and logged instead of silently crashing
- **Orphaned job cleanup** — on startup, any jobs stuck as "running" from a previous crash are marked as failed
- **Graceful shutdown** — on SIGTERM/SIGINT: stops scheduler → notifies peers → kills child processes → updates DB → exits
- **Docker healthcheck** — container health monitored at `/api/health`

### Storage Management
- **Per-peer storage quotas** — the receiving NAS controls how much space a peer can use
- **Pre-flight disk space checks** — SSD backups abort if destination has less than 1 GB free
- **Automatic version pruning** — old snapshots cleaned up based on retention policy after each backup
- **Tiered retention** — keep hourly snapshots for 24h, daily for 7 days, weekly for 30, monthly for 90, quarterly for a year (all configurable)

### Frontend Resilience
- **Auto-reconnect** — when the backend restarts (deploys, crashes, `node --watch`), the UI detects the disconnection and automatically refetches all page data once the backend comes back
- **Adaptive health polling** — checks every 5s normally, every 2s when disconnected, for fast recovery
- **Connection badge** — header shows live connected/offline status with latency, uptime, memory, and version info

### Scheduling
- **Skip-if-running** — prevents overlapping executions of the same job
- **Skip notifications** — alerts after 5 consecutive skips (schedule too aggressive)
- **Persistent across restarts** — cron schedules loaded from DB on boot

## Peer Setup (Hyper Backup)

To set up cross-site backup between two NAS units:

### On the receiving NAS (your dad's):

1. Go to **Settings → Peers** and create a new authorized peer
2. Set the **allowed path prefix** (e.g., `/mnt/user/backups/your-name`)
3. Set a **storage limit** (e.g., 4 TB) — 0 for unlimited
4. Copy the generated API key (shown only once)

### On the sending NAS (yours):

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

All routes are prefixed with `/api/` and protected by Authelia forward auth (or `AUTH_DISABLED=true` for development).

| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | Health check (unauthenticated) |
| `/api/ssd-backup/*` | SSD backup configs, runs, version browser, delta verification |
| `/api/hyper-backup/*` | Hyper Backup jobs and run history |
| `/api/rclone/*` | Rclone sync jobs |
| `/api/docker/*` | Container list, metrics, controls |
| `/api/overview/*` | Dashboard stats |
| `/api/settings/*` | App settings, notifications, SSH key management, DB backup & recovery |
| `/api/peers/*` | Authorized peer management, audit log |
| `/api/media-import/*` | Drive detection and Immich import |
| `/api/filesystem/*` | Path browsing |

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

## Tech Stack

- **Backend:** Node.js, Express, better-sqlite3, node-cron
- **Frontend:** React 18, Vite, react-router-dom, lucide-react
- **Transfer:** rsync (GNU/openrsync), rclone, rdiff (librsync)
- **Import:** immich-go (auto-downloaded in Docker build)
- **System tools:** util-linux (lsblk, umount for drive detection/ejection)
- **Container:** Docker (node:20-alpine), dockerode
- **Target platform:** Unraid (also works standalone on Linux/macOS)

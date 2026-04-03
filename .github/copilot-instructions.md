# RedMan — Copilot Instructions

## Project Overview

RedMan is a homelab backup and management tool for Unraid. Express + SQLite backend, React + Vite frontend, single Docker container. Two API servers: main API (:8090, Authelia-protected) and peer API (:8091, Bearer key auth). Five features: SSD Backup, Hyper Backup, Rclone Sync, Docker Monitoring, Media Import.

## Architecture

- **Backend:** `app/backend/src/` — ES modules (`"type": "module"`), Express routes + services, better-sqlite3 with WAL mode
- **Frontend:** `app/frontend/src/` — React 18 with JSX, Vite, react-router-dom, lucide-react icons
- **Shared workspace:** `app/package.json` uses npm workspaces (`backend`, `frontend`)
- **Database:** SQLite with inline migrations in `db.js` (ALTER TABLE, CREATE IF NOT EXISTS) + formal versioned migrations in `migrations.js`
- **No TypeScript** — plain JavaScript throughout, no type annotations
- **Dual servers:** Main API (`:8090`, Authelia forward auth) and Peer API (`:8091`, per-peer Bearer key auth via `peerApi.js`)
- **Backward compatibility contract:** `contracts/v1.json` defines frozen API, DB, and service contracts; validated by `test/test_backward_compat.mjs`

### Startup Sequence (`index.js`)

1. Crash recovery — marks orphaned `status='running'` jobs as failed
2. `startScheduler()` — loads cron jobs from DB
3. `startMetricsPoller()` — Docker container metrics collection
4. `startTempCleanup()` — orphaned delta temp file cleanup
5. `startDriveMonitor()` — USB/SD card detection

Graceful shutdown on SIGTERM/SIGINT: stops schedulers, notifies peers, kills rsync processes, marks active jobs as failed. Ignores SIGHUP for persistence through shell exits.

## Code Conventions

- ES module imports (`import`/`export`), no CommonJS (`require`)
- Backend route files export an Express `Router`; mounted in `index.js` under `/api/<feature>`
- Frontend API calls go through `frontend/src/api/index.js` — all endpoints centralized there
- Frontend pages: one file per feature in `pages/` (e.g., `SsdBackupPage.jsx`), co-located CSS
- Frontend components: shared UI in `components/`, each with co-located `.css` file
- CSS uses custom properties from `styles/tokens.css` (dark theme) — no CSS-in-JS, no Tailwind
- Hooks in `hooks/` — custom React hooks prefixed with `use`
- No test framework — manual test scripts in `test/` using plain Node.js (`*.mjs`)
- Only 5 backend deps: `better-sqlite3`, `cors`, `dockerode`, `express`, `node-cron`

### Backend Service Patterns

- Services export **plain functions** (not classes, not EventEmitter)
- Active jobs tracked in **in-memory `Map<runId, progressObj>`** — polled by routes for live status
- Child process spawning with output parsing (rsync, rclone, rdiff) — async/await throughout
- Config-level locking via `withConfigLock()` in deltaVersion to prevent concurrent writes
- Scheduler uses skip-if-running logic with retry on transient errors

### Backend Route Map

Health check (unauthenticated): `GET /api/health` — version, uptime, memory, active job count

**`/api/ssd-backup`** (ssdBackup.js):
`GET /shares` · `GET /browse?path` · `GET|POST /configs` · `GET|PUT|DELETE /configs/:id` · `POST /configs/:id/run` · `GET /runs?page&limit&config_id` · `GET /runs/:id` · `POST /configs/:id/prune` · `GET /configs/:id/snapshots` · `GET /configs/:id/browse?timestamp&path` · `GET /configs/:id/download?timestamp&path&inline` · `POST /configs/:id/restore` · `POST /configs/:id/verify-versions`

**`/api/hyper-backup`** (hyperBackup.js):
`GET|POST /jobs` · `GET|PUT|DELETE /jobs/:id` · `POST /jobs/:id/run` · `POST /test-connection` · `GET /runs?page&limit&job_id` · `GET /runs/:id`

**`/api/rclone`** (rclone.js):
`GET /remotes` · `GET /remote/:name/ls?path` · `GET|POST /jobs` · `GET|PUT|DELETE /jobs/:id` · `POST /jobs/:id/run` · `GET /runs?page&limit&job_id` · `GET /runs/:id` · `GET /providers` · `GET /remotes/:name/config` · `POST /remotes` · `PUT|DELETE /remotes/:name` · `POST /remotes/:name/test`

**`/api/docker`** (docker.js):
`GET /status` · `GET /containers` · `POST /containers/:id/:action` (start/stop/restart) · `GET /containers/:id/stats` · `GET /containers/:id/metrics?hours`

**`/api/media-import`** (mediaImport.js):
`GET /drives` · `GET /drives/known` · `GET|PUT /drives/:id` · `POST /drives/:id/scan` · `GET /drives/:id/scan` · `POST /drives/:id/import` · `GET /runs/:id/progress` · `GET /runs?page&drive_id` · `GET /runs/:id` · `POST /drives/:id/eject` · `POST /test-immich` · `GET /status`

**`/api/overview`** (overview.js):
`GET /summary`

**`/api/settings`** (settings.js):
`GET|PUT /` · `POST /ntfy-test` · `POST /browser-notify-test` · `GET /ssh/status` · `POST /ssh/generate` · `POST /ssh/authorize-localhost` · `POST /ssh/test` · `POST /db/backup` · `POST /db/backup-all` · `GET /db/backups?dest_path` · `GET /db/recovery-scan?paths` · `GET /db/recovery-info?dest_path` · `POST /db/restore` · `GET /notifications/stream` (SSE)

**`/api/peers`** (peers.js):
`GET|POST /` · `GET|PUT|DELETE /:id` · `POST /:id/regenerate-key` · `GET /:id/audit-log?page&limit` · `GET /audit-log/all?page&limit`

**`/api/filesystem`** (filesystem.js):
`GET /browse?dir` · `GET /roots`

**Peer API** (`:8091`, peerApi.js — Bearer key auth, all logged to `peer_audit_log`):
`GET /peer/health` · `POST /peer/backup/prepare` · `POST /peer/backup/complete` · `GET /peer/backup/status/:runId` · `POST /peer/shutdown` · `GET /peer/storage`

### Backend Route Conventions

- `/runs` endpoints support `page` + `limit` query params (limit capped at 100)
- Runs with `status='running'` include `liveProgress` from in-memory Map
- SSE stream at `/api/settings/notifications/stream` (30s heartbeat)
- Async scans: `POST .../scan` triggers, `GET .../scan` polls progress
- File downloads: `?inline` for browser preview, omit for attachment
- Sensitive data masking: API keys shown as `••••••••`; create/regenerate returns full key once

### Frontend Route Map

| Path | Page Component | Feature |
|------|---------------|---------|
| `/` | `OverviewPage` | Dashboard |
| `/ssd-backup` | `SsdBackupPage` | SSD Backup |
| `/hyper-backup` | `HyperBackupPage` | Hyper Backup |
| `/rclone` | `RclonePage` | Rclone Sync |
| `/media-import` | `MediaImportPage` | Media Import |
| `/settings` | `SettingsPage` | Settings (tabbed: General, Notifications, Peers, Integrations, Infrastructure) |

### Frontend Patterns

- `api/index.js` uses `fetchJSON()` wrapper with `/api` base URL (proxied to `:8090` in dev)
- Pages use `useState` + `useEffect` for data fetching; `useReconnect()` to re-fetch on app reconnect
- `useJobProgress()` hook polls run detail every 1s for active jobs
- `useBrowserNotifications()` connects to SSE stream, shows browser `Notification` popups
- `ConnectionStatus` component polls `/api/health` every 5s, dispatches `redman:reconnected` event on recovery
- Feature colors in tokens.css: SSD=purple, Hyper=orange, Rclone=cyan, Docker=blue, Media=pink
- Icons: lucide-react throughout — import from `lucide-react`

## Database Patterns

- Legacy inline migrations in `db.js` (frozen for v1) — check if column/table exists, then ALTER/CREATE
- **New schema changes** go in `migrations.js` as numbered, idempotent migrations tracked in `schema_migrations` table
- Use `better-sqlite3` synchronous API (not async)
- WAL mode enabled, foreign keys on, busy timeout 5s
- Tables: `settings`, `ssd_backup_configs`, `hyper_backup_jobs`, `rclone_jobs`, `backup_runs`, `backup_run_files`, `authorized_peers`, `peer_audit_log`, `container_metrics`, `media_drives`, `cache`, `schema_migrations`
- `backup_runs` is shared across all features (keyed by `feature` + `config_id`)
- `seed.js` drops and recreates all tables — used for dev/test resets only
- When adding a column/table: update `seed.js` + `migrations.js` + `contracts/v1.json` (all three must stay in sync)

## Security

- Main API protected by Authelia forward auth headers (`remote-user`, `remote-name`, etc.) — see `middleware/auth.js`
- Peer API uses per-peer Bearer API keys validated against `authorized_peers` table; logs all access to `peer_audit_log`
- Path traversal prevention via `middleware/validation.js` (`normalizePath`, `isWithinPrefix`)
- `AUTH_DISABLED=true` for development only — never in production (sets mock user `dev@localhost`)
- Do not expose internal paths or database details in API error responses

## Build & Run

- Dev: `cd app && npm install && npm run dev` (runs backend on :8090 + frontend on :5175 via concurrently)
- Seed DB: `cd app && npm run seed`
- Build frontend: `cd app && npm run build` (Vite outputs to `frontend/dist/`)
- Docker: `docker compose up -d` (3-stage build: frontend → backend deps → alpine runtime with rsync/rdiff/immich-go)
- Deploy to Unraid: `./deploy.sh [--seed]`
- Pre-push validation: `./pre-push.sh` (compat + medium integration + build) or `./pre-push.sh --quick` (small scale)
- Test environment: `./test/setup_local_test.sh` — two instances (A: 8090/8091/5175, B: 8094/8095)

## Environment Variables

See the table in `README.md`. Key ones: `PORT`, `PEER_API_PORT`, `DB_PATH`, `AUTH_DISABLED`, `SSH_USER`, `SSH_PORT`, `PEER_HOST`.

## Documentation

After any code change, update the relevant project documentation in the same change:

- `README.md` — features, architecture, API endpoints, environment variables, deployment
- `test/README.md` — test environment, workflows, test data, pre-configured jobs
- `contracts/v1.json` — when adding new endpoints, DB columns, service exports, or frontend API functions (additive only)

When adding or modifying features, routes, services, environment variables, database tables/columns, API endpoints, or CLI flags, ensure the corresponding docs stay in sync.

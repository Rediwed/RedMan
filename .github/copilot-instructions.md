# RedMan — Copilot Instructions

## Project Overview

RedMan is public homelab backup and management software for Unraid and generic Linux NAS hosts. Express + SQLite backend, React + Vite frontend, single Docker container. Two API servers: main API (:8090, explicit proxy or local auth) and peer API (:8091, Bearer key auth). Five features: SSD Backup, Hyper Backup, Rclone Sync, Docker Monitoring, Media Import.

The v1.1.9 release remains the upgrade-readiness bridge and rollback baseline. Setting `REDMAN_UPGRADE_BRIDGE=true` pauses schedules, non-wizard mutations, monitoring, and the peer API while an operator prepares or verifies a hardened cutover.

## Architecture

- **Backend:** `app/backend/src/` — ES modules (`"type": "module"`), Express routes + services, better-sqlite3 with WAL mode
- **Frontend:** `app/frontend/src/` — React 18 with JSX, Vite, react-router-dom, lucide-react icons
- **Shared workspace:** `app/package.json` uses npm workspaces (`backend`, `frontend`)
- **Database:** SQLite with one authoritative numbered migration path in `migrations.js`; `db.js` only configures and opens the database
- **No TypeScript** — plain JavaScript throughout, no type annotations
- **Dual servers:** Main API (`:8090`, hardened proxy or native local auth) and Peer API (`:8091`, per-peer Bearer key auth via `peerApi.js`)
- **Backward compatibility contract:** `contracts/v1.json` defines frozen API, DB, and service contracts; validated by `test/test_backward_compat.mjs`

### Startup Sequence (`index.js`)

1. Crash recovery — marks orphaned `status='running'` jobs as failed
2. `startScheduler()` — loads cron jobs from DB
3. `startMetricsPoller()` — Docker container metrics collection
4. `startTempCleanup()` — orphaned delta temp file cleanup
5. `startDriveMonitor()` — USB/SD card detection

Graceful shutdown on SIGTERM/SIGINT: stops schedulers, notifies peers, kills rsync processes, marks active jobs as failed. Ignores SIGHUP for persistence through shell exits.

## ⚠️ Mandatory Workflow Rules

These rules apply to **every** code change. Do not skip them.

### 1. Keep Documentation in Sync

After any code change, update the relevant docs **in the same change** — never defer to a follow-up:

| What changed | Update these files |
|---|---|
| API endpoint added/changed | `README.md` (route table), `contracts/v1.json` (additive only) |
| DB table/column added | `README.md` (schema), `contracts/v1.json`, `seed.js`, `migrations.js` |
| Environment variable added | `README.md` (env table) |
| Service function added/exported | `contracts/v1.json` |
| Frontend API function added | `contracts/v1.json` |
| Feature behavior changed | `README.md` (feature description) |
| CLI flag or deploy script changed | `README.md` (build & run section) |
| Test setup changed | `test/README.md` |

### 2. Send Notification After Long-Running Tasks

After any task that takes more than a couple of minutes (deployments, migrations, multi-step changes, bulk operations), **always** send a push notification through the helper configured in the local development environment. Do not commit a personal helper path, endpoint, or topic to this repository.

### 3. Preserve Greenfield Portability

- Product behavior and setup must work on a clean supported host without an operator's private SSH aliases, paths, users, groups, or existing containers.
- Keep generic Linux/OpenSSH logic in `scripts/setup-backup-user.sh`; keep Unraid reboot persistence in its wrapper.
- Host paths belong in `.env`, Compose variables, Unraid template values, or explicit deploy profiles, never in core runtime behavior.
- Any deployment/account/storage change needs rootless plan tests plus the isolated `npm run test:greenfield` acceptance test.

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

Health check (unauthenticated): `GET /api/health` — readiness/version with host/runtime/operation fields redacted

Health details (authenticated): `GET /api/health/details` — uptime, host platform, Node version, active jobs, memory, and process ID

**`/api/ssd-backup`** (ssdBackup.js):
`GET /shares` · `GET /browse?path` · `GET|POST /configs` · `GET|PUT|DELETE /configs/:id` · `POST /configs/:id/run` · `GET /runs?page&limit&config_id` · `GET /runs/:id` · `POST /configs/:id/prune` · `GET /configs/:id/snapshots` · `GET /configs/:id/browse?timestamp&path` · `GET /configs/:id/download?timestamp&path&inline` · `POST /configs/:id/restore` · `POST /configs/:id/verify-versions`

**`/api/hyper-backup`** (hyperBackup.js):
`GET|POST /jobs` · `GET|PUT|DELETE /jobs/:id` · `POST /jobs/:id/run` · `POST /test-connection` · `GET /remote-browse?remote_url&dir` · `GET /remote-roots?remote_url` · `GET /remote-shares?remote_url` · `GET /runs?page&limit&job_id` · `GET /runs/:id`

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

**`/api/upgrade-readiness`** (upgradeReadiness.js):
`GET /` · `POST /backup` · `POST /host-plan` · `POST /final-config`

**`/api/peers`** (peers.js):
`GET|POST /` · `GET /connectivity` (probes outgoing/destination peers via `remote_url`) · `GET|PUT|DELETE /:id` · `POST /:id/regenerate-key` · `GET /:id/audit-log?page&limit` · `GET /audit-log/all?page&limit`

**`/api/filesystem`** (filesystem.js):
`GET /browse?dir` · `GET /roots`

**`/api/discovery`** (discovery.js):
`GET /subnets?refresh` · `GET /peers?refresh` · `GET /immich?refresh` · `POST /clear-cache`
**`/api/external-jobs`** (externalJobs.js):
`POST /heartbeat/:slug` (per-job Bearer token, mounted before the auth chain) · `GET|POST /` · `GET /runs?job_id&page&limit` · `GET|PUT|DELETE /:id` · `POST /:id/regenerate-token`

**`/api/events`** (events.js):
`GET /?severity&category&type&since&page&limit` · `GET /summary?since`

Events are recorded by `services/events.js` from inside `notify.js`'s `sendQuiet()`, before the per-channel delivery gates. Disabling ntfy or browser notifications must never suppress the history. `job_progress` is deliberately excluded as transient noise.
**Peer API** (`:8091`, peerApi.js — Bearer key auth, all logged to `peer_audit_log`):
`GET /peer/discover` (unauthenticated — returns service identity for network scanning) · `POST /peer/pair/request` (unauthenticated — incoming pairing request) · `POST /peer/pair/callback` (unauthenticated — pairing acceptance callback) · `GET /peer/health` · `POST /peer/backup/prepare` · `POST /peer/backup/complete` · `GET /peer/backup/status/:runId` · `POST /peer/shutdown` · `GET /peer/storage` · `GET /peer/browse?dir` · `GET /peer/roots` · `GET /peer/shares`

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
| `/external-jobs` | `ExternalJobsPage` | External job heartbeats |
| `/status` | `StatusPage` | Event history and severity summary |
| `/settings` | `SettingsPage` | Settings (tabbed: General, Notifications, Peers, Integrations, Infrastructure, Upgrade) |

### Frontend Patterns

- `api/index.js` uses `fetchJSON()` wrapper with `/api` base URL (proxied to `:8090` in dev)
- Pages use `useState` + `useEffect` for data fetching; `useReconnect()` to re-fetch on app reconnect
- `useJobProgress()` hook polls run detail every 1s for active jobs
- `useBrowserNotifications()` connects to SSE stream, shows browser `Notification` popups
- `ConnectionStatus` component polls `/api/health` every 5s, dispatches `redman:reconnected` event on recovery
- `Navbar` fetches `instance_name` from settings on mount; renders "RedMan — InstanceName" in the title and `document.title`; also fetches `/api/peers/connectivity` to show destination peer status dots in the badge and detailed peer info in the popover
- Feature colors in tokens.css: SSD=purple, Hyper=orange, Rclone=cyan, Docker=blue, Media=pink
- Icons: lucide-react throughout — import from `lucide-react`

## Database Patterns

- All schema changes go in `migrations.js` as append-only numbered migrations tracked in `schema_migrations`
- Use `better-sqlite3` synchronous API (not async)
- WAL mode enabled, foreign keys on, busy timeout 5s
- Tables: `settings`, `ssd_backup_configs`, `hyper_backup_jobs`, `rclone_jobs`, `backup_runs`, `backup_run_files`, `authorized_peers`, `peer_audit_log`, `container_metrics`, `media_drives`, `cache`, `schema_migrations`, `pairing_requests`
- `backup_runs` is shared across all features (keyed by `feature` + `config_id`)
- `seed.js` deletes and inserts development data only; it never creates, alters, or drops schema
- When adding a column/table: append a migration and add the contract entry; seed only if the feature needs default data

## Security

- Main API uses explicit `proxy` or `local` mode through `middleware/mainAuth.js`; proxy mode accepts identity headers only from configured exact host IPs (`/32` or `/128`)
- Production upgrade-bridge mode requires an explicit `REDMAN_ADMIN_GROUP` and/or `REDMAN_ADMIN_ROLE`; upgrade mutations require that authority or a native RedMan administrator
- Peer API uses per-peer Bearer API keys validated against `authorized_peers` table; logs all access to `peer_audit_log`
- **Noise XX handshake** for peer pairing (`services/handshake.js`):
  - Ephemeral X25519 ECDH for forward secrecy — new keypair per pairing attempt
  - Ed25519 static identity signatures for mutual authentication
  - API keys derived via HKDF from ECDH shared secret — never transmitted over the wire
  - Callback payload encrypted with NaCl secretbox (XSalsa20-Poly1305)
  - Old-style (v1) plaintext pairing rejected with `426 Upgrade Required`
  - Static identity keys stored in `data/identity.json` (Ed25519 keypair)
  - Ephemeral secrets zeroed from DB after handshake completion
- Path traversal prevention via `middleware/validation.js` (`normalizePath`, `isWithinPrefix`)
- `AUTH_DISABLED=true` for development only — never in production (sets mock user `dev@localhost`)
- Do not expose internal paths or database details in API error responses

## Build & Run

- Dev: `cd app && npm install && npm run dev` (runs backend on :8090 + frontend on :5175 via concurrently)
- Seed DB: `cd app && npm run seed`
- Build frontend: `cd app && npm run build` (Vite outputs to `frontend/dist/`)
- Release check: `./scripts/release.sh check` (tests, build, audit, changelog, and version consistency without mutation)
- Routine validation: `npm --prefix app run validate` (lint, regressions, clean start, contract, build, audit, browser/Axe)
- Docker: `docker compose up -d` (3-stage build: frontend → backend deps → alpine runtime with rsync/rdiff/immich-go)
- Generic remote deploy: configure `REDMAN_DEPLOY_*`, run `./deploy.sh --custom --print-config`, then `./deploy.sh --custom`
- Optional local deploy profiles: copy `deploy-profiles.example.sh` to gitignored `.redman-deploy-profiles.sh`, then use `./deploy.sh --profile NAME`; no target is selected implicitly
- Release publication never selects or invokes a private deployment target implicitly
- Pre-push validation: `./pre-push.sh` (compat + medium integration + build) or `./pre-push.sh --quick` (small scale)
- Test environment: `./test/setup_local_test.sh` — two instances (A: 8090/8091/5175, B: 8094/8095)

## Environment Variables

See the table in `README.md`. Key ones: `PORT`, `PEER_API_PORT`, `DB_PATH`, `AUTH_DISABLED`, `SSH_USER`, `SSH_PORT`, `PEER_HOST`.

## Documentation

See **⚠️ Mandatory Workflow Rules** above — documentation must be updated in the same change as code. The key files are:

- `README.md` — features, architecture, API endpoints, environment variables, deployment
- `test/README.md` — test environment, workflows, test data, pre-configured jobs
- `contracts/v1.json` — when adding new endpoints, DB columns, service exports, or frontend API functions (additive only)
- `UPGRADING.md` — bridge preparation, hardened cutover, and rollback contract
- `CHANGELOG.md` — every meaningful change needs a public `- [x]` bullet under `## [Unreleased]`

When adding or modifying features, routes, services, environment variables, database tables/columns, API endpoints, or CLI flags, ensure the corresponding docs stay in sync.

## Release Workflow

- Meaningful work belongs on `feat/`, `fix/`, `chore/`, `docs/`, or `perf/` branches, never directly on `main`.
- Do not edit package versions or `app/frontend/src/version.js` by hand; `scripts/release.sh` updates every version source.
- Keep `CHANGELOG.md` current in the same change. Use `- [x]` for public notes and `- [ ]` for internal notes.
- Run `./scripts/release.sh check` before handoff. Do not run a version bump or push without explicit operator approval.
- RedMan releases tag and push public source only. They never invoke a private deployment target implicitly.

# RedMan — Test Environment

Local test environment for validating **SSD Backup** (with versioning and delta compression), **Hyper Backup** (cross-site replication), and **Media Import** features.

## Prerequisites

- Node.js 20+ with RedMan dependencies installed (`cd app && npm install`)
- Python 3.9+ with Pillow and piexif:

```bash
pip install -r test/requirements.txt
```

- **rdiff** (librsync) for delta versioning tests:
  ```bash
  brew install librsync        # macOS
  # apk add librsync           # Alpine (already in Docker image)
  ```

- macOS Remote Login enabled (for Hyper Backup SSH testing):
  **System Settings → General → Sharing → Remote Login → ON**

## Quick Start

```bash
# 1. Generate test data (~2 GB)
python test/generate_test_data.py --size small

# 2. Start two RedMan instances
./test/setup_local_test.sh

# 3. Open Instance A UI
open http://localhost:5175
```

## Test Data Generator

Creates a realistic filesystem with photos, videos, documents, databases, code files, and edge cases.

### Size Profiles

| Profile | Photos | Videos | Documents | Databases | Code | Edge Cases | Target |
|---------|--------|--------|-----------|-----------|------|------------|--------|
| small   | 100    | 3      | 100       | 3         | 30   | 10         | ~2 GB  |
| medium  | 250    | 8      | 250       | 8         | 75   | 20         | ~5 GB  |
| large   | 500    | 15     | 500       | 15        | 150  | 30         | ~10 GB |

```bash
python test/generate_test_data.py --size small   # ~2 GB, fastest
python test/generate_test_data.py --size medium  # ~5 GB
python test/generate_test_data.py --size large   # ~10 GB
```

### File Types Generated

| Category | Extensions | Method |
|----------|------------|--------|
| Photos | .jpg, .png, .cr2, .nef, .arw, .rw2, .raf | Pillow + piexif (EXIF metadata) |
| Videos | .mp4, .mov, .avi | Random binary with MP4 ftyp header |
| Documents | .txt, .md, .json, .csv, .xml, .html | Lorem ipsum + structured data |
| Databases | .db | Real SQLite with tables/data |
| Code | .py, .js, .sh, .yml, .toml, .env | Template-generated |
| Edge cases | various | Corrupt JPEG, zero-byte, deep nesting, unicode names, symlinks |

### Folder Structure

```
test/data/source/
├── DCIM/                    # Camera-style (for Media Import testing)
│   ├── 100CANON/
│   ├── 100GOPRO/
│   ├── 100APPLE/
│   └── .thumbnails/
├── photos/                  # Organized by year/event
│   ├── 2022/vacation/
│   ├── 2023/birthday/
│   └── 2024/hiking/
├── videos/
├── documents/
│   ├── work/
│   ├── personal/
│   └── financial/
├── databases/
├── projects/webapp/src/
└── edge_cases/
    ├── corrupt/
    ├── empty/
    ├── deep/ (25 levels)
    ├── unicode/
    ├── system/ (.DS_Store, Thumbs.db)
    ├── symlinks/
    ├── long_names/
    └── special_chars/
```

### Version Evolution

Simulate realistic file changes for versioning/backup tests. Run after creating the base dataset:

```bash
# Create base dataset
python test/generate_test_data.py --size small

# Run SSD backup → creates initial snapshot
# (trigger via UI or API)

# Apply evolution 1: small changes
python test/generate_test_data.py --evolve 1
# → Modifies 15% of docs, adds 20 photos, deletes 5, renames 10 files

# Run backup again → .versions/ captures the changes

# Apply evolution 2: medium changes
python test/generate_test_data.py --evolve 2
# → New database, deletes corrupt dir, adds 30 photos, modifies code

# Apply evolution 3: major restructure
python test/generate_test_data.py --evolve 3
# → Moves folders, updates all JSON, adds ~50 photos, new project
```

### Regeneration

```bash
# Force regenerate (deletes existing data)
python test/generate_test_data.py --size small --force
```

## Two-Instance Test Setup

Tests Hyper Backup by running two RedMan instances on the same machine.

### Architecture

```
Instance A (Primary)              Instance B (Remote Peer)
┌─────────────────────┐          ┌─────────────────────┐
│ API:  localhost:8090 │──push──▶│ API:  localhost:8094 │
│ Peer: localhost:8091 │◀──pull──│ Peer: localhost:8095 │
│ UI:   localhost:5175 │          │ (no UI — API only)   │
│ DB:   instance_a/    │          │ DB:   instance_b/    │
└─────────────────────┘          └─────────────────────┘
         │                                │
         └──── rsync via localhost SSH ────┘
```

### Commands

```bash
# Start both instances
./test/setup_local_test.sh

# Stop all test instances
./test/setup_local_test.sh --stop

# Re-seed databases only (no restart)
./test/setup_local_test.sh --seed
```

### Pre-configured Jobs

| Instance | Job | Direction | Source → Destination |
|----------|-----|-----------|---------------------|
| A | Test SSD Backup | local | test/data/source → test/data/dest_ssd |
| A | Test SSD Backup (Delta) | local | test/data/source → test/data/dest_ssd_delta |
| A | Test Hyper Push A→B | push | test/data/source → test/data/dest_hyper |
| B | Test Hyper Pull B←A | pull | test/data/source → test/data/dest_hyper |

> ⚠️ Jobs are created **disabled** by default. Enable them in the UI or via API.

### Logs

```bash
tail -f test/data/instance_a.log
tail -f test/data/instance_b.log
tail -f test/data/vite_a.log
```

## Testing Workflow

### SSD Backup with Versioning

1. Generate test data: `python test/generate_test_data.py --size small`
2. Start instances: `./test/setup_local_test.sh`
3. Open UI: http://localhost:5175
4. Navigate to SSD Backup → enable "Test SSD Backup" job
5. Run manually or wait for cron (every 5 minutes)
6. Verify `test/data/dest_ssd/` mirrors source
7. Apply evolution: `python test/generate_test_data.py --evolve 1`
8. Run backup again → check `.versions/` for changed/deleted files
9. Repeat with `--evolve 2` and `--evolve 3`

### Comprehensive Integration Test (mission-critical)

The comprehensive test validates RedMan's backup pipeline at scale — SSD Backup with delta versioning, file restoration, Hyper Backup cross-site replication, and metadata tracking. Designed to validate terabyte-scale workloads (70,000 photos, 10,000 videos, 100,000+ files).

```bash
# Prerequisites
brew install librsync        # macOS (rdiff for delta versioning)
./test/setup_local_test.sh   # Start both instances

# Run at different scales
node test/test_comprehensive.mjs --scale small      # ~500 files, fast (~2 min)
node test/test_comprehensive.mjs --scale medium     # ~5,000 files (~10 min)
node test/test_comprehensive.mjs --scale large      # ~50,000 files (~60 min)
node test/test_comprehensive.mjs --scale full       # ~100,000+ files (TB-scale simulation)

# Options
node test/test_comprehensive.mjs --skip-hyper       # Skip Hyper Backup tests
node test/test_comprehensive.mjs --keep-data        # Don't delete test data after run
```

**Scale profiles:**

| Scale | Photos | Videos | Documents | Databases | Code | Bulk Small | Total |
|-------|--------|--------|-----------|-----------|------|------------|-------|
| small | 100 | 10 | 200 | 3 | 50 | 100 | ~500 |
| medium | 1,000 | 50 | 2,000 | 10 | 200 | 500 | ~4,000 |
| large | 10,000 | 500 | 20,000 | 30 | 2,000 | 5,000 | ~38,000 |
| full | 70,000 | 10,000 | 30,000 | 100 | 5,000 | 15,000 | ~130,000 |

**8 test suites covering:**
1. **SSD Backup at scale** — 4 backup versions with delta versioning, verifying file change detection
2. **Delta reconstruction** — Download photos, CSVs, JSON, databases from delta-compressed snapshots; verify JPEG headers, SQLite headers, version markers
3. **Point-in-time restore** — Restore files from older snapshots, verify restored content matches snapshot exactly (SHA-256), verify binary integrity preserved
4. **Delta chain integrity** — Automated verification that all delta chains can be reconstructed
5. **Snapshot browsing** — Browse directory trees at each point-in-time, verify delta badges, retention tiers
6. **Version pruning** — Prune with GFS retention policy, verify delta integrity survives pruning
7. **Hyper Backup replication** — 3-push cycle with content verification, file additions, deletions propagation via `--delete`
8. **Scale validation** — Run history tracking, file-level action counts, timing data, scale projection

**File types tested:**
- Simulated JPEG photos (200KB–800KB) with EXIF-like headers and version markers
- Simulated MP4 videos (5–50MB) with ftyp headers
- Text documents with 60% stable / 40% version-specific content (delta-friendly)
- Growing CSV datasets (rows added each version, existing rows updated)
- JSON config files that evolve across versions
- Simulated SQLite databases (512KB–3MB) with stable schema + version-specific data
- Code files (.py, .js, .json, .sh)
- Bulk small files (100–2000 bytes, cache simulation)
- Edge cases: 25-level deep nesting, empty files, unicode filenames, large single files

**Version evolution pattern:**
- 60% of files stay unchanged (rsync skip detection)
- 25% change to current version (delta compression candidates)
- 10% change every version (always updated)
- 5% are version-behind (stale data)
- New directories appear in v2/v3, files deleted in v3, major reorganization in v4

### Delta Versioning (focused test)

Run the focused delta versioning test which tests the delta lifecycle in isolation:

```bash
brew install librsync        # macOS
./test/setup_local_test.sh

node test/test_delta_versioning.mjs
```

The test creates its own isolated config + data in `test/data/delta_test/` and cleans up after itself.

**What it tests:**
- Config creation with delta versioning, threshold, chain limits, and retention policy
- Initial full backup (no deltas yet)
- 3 mutation rounds with different change patterns (text edits, binary changes, file adds/deletes)
- Snapshot listing with delta stats and retention tier badges
- Version browser browsing with delta badge indicators
- File download from delta-compressed snapshots (verifies reconstruction)
- File restore from delta snapshots back to source
- Delta chain integrity verification
- Dashboard version stats (space savings)
- Manual prune with tiered retention

### Delta Versioning (manual via UI)

1. Generate test data: `python test/generate_test_data.py --size small`
2. Start instances: `./test/setup_local_test.sh`
3. Open UI → SSD Backup → enable "Test SSD Backup (Delta)"
4. Run backup → check that `.versions/` has a `_manifest.json` in each snapshot
5. Apply evolution: `python test/generate_test_data.py --evolve 1`
6. Run backup again → check for `.rdelta` files alongside the manifest
7. Click "Browse" → verify files display with correct sizes and "delta" badges
8. Download a versioned file → verify content is correct
9. Restore a versioned file → verify it appears at the source path

### Hyper Backup (Cross-Site)

1. Ensure macOS Remote Login is enabled
2. Start instances: `./test/setup_local_test.sh`
3. Open Instance A UI: http://localhost:5175
4. Navigate to Hyper Backup → enable "Test Hyper Push A→B"
5. Run manually → files should appear in `test/data/dest_hyper/`
6. Check Instance B's API for run history: `curl localhost:8094/api/hyper-backup/runs`

### Peer Storage Quotas

Test the per-peer storage limit enforcement:

```bash
# Set a 100 MB quota on Instance B's peer authorization for Instance A
curl -X PUT localhost:8094/api/peers/1 \
  -H 'Content-Type: application/json' \
  -d '{"storage_limit_bytes": 104857600}'

# Check storage usage from Instance A's perspective
curl -H 'Authorization: Bearer test-peer-key-beta' \
  localhost:8095/peer/storage

# Run a Hyper Backup push — should fail with 507 if quota exceeded
```

### Peer Shutdown Handling

Test graceful peer shutdown notifications:

```bash
# Start both instances
./test/setup_local_test.sh

# Trigger a Hyper Backup run from Instance A
curl -X POST localhost:8090/api/hyper-backup/jobs/1/run

# While running, stop Instance B gracefully (Ctrl+C or kill)
# Instance B notifies Instance A at /peer/shutdown before exiting
# Instance A marks the job as failed with "peer shutting down" message
```

### Media Import

1. Create a test "drive" directory:
   ```bash
   mkdir -p /tmp/test_drive/DCIM/100CANON
   cp test/data/source/DCIM/100CANON/*.jpg /tmp/test_drive/DCIM/100CANON/
   ```
2. Symlink to drive monitor path (or set `MEDIA_MOUNT_PATH` env var)
3. Check drive detection in UI → should detect camera type and file counts

### Database Backup & Recovery

The RedMan database is automatically backed up to each SSD backup destination after every successful run. Backups are stored in `dest_path/.versions/_db_backups/` with up to 5 rotated copies.

#### Scan for Backups

```bash
# Scan a backup destination for DB backups and version history
node test/recover_db.mjs --scan /path/to/dest_ssd

# Scan multiple destinations
node test/recover_db.mjs --scan test/data/dest_ssd test/data/dest_ssd_delta
```

#### Restore from Backup

```bash
# Restore the most recent DB backup
node test/recover_db.mjs --restore test/data/dest_ssd/.versions/_db_backups/redman-2024-05-10T14-32-15.db
```

#### Rebuild Configs from Filesystem

If no DB backup exists, reconstruct minimal configs from `.versions/` metadata:

```bash
# Creates disabled configs — review and set source paths before enabling
node test/recover_db.mjs --rebuild test/data/dest_ssd test/data/dest_ssd_delta
```

#### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/settings/db/backup` | Trigger manual DB backup to a destination |
| `POST` | `/api/settings/db/backup-all` | Backup DB to all SSD backup destinations |
| `GET` | `/api/settings/db/backups?dest_path=` | List available backups at a destination |
| `GET` | `/api/settings/db/recovery-scan` | Scan filesystem for recoverable configs |
| `GET` | `/api/settings/db/recovery-info?dest_path=` | Recovery info for a specific destination |
| `POST` | `/api/settings/db/restore` | Restore DB from a backup file (requires restart) |

### Backward Compatibility

Validates that all API endpoints, database schemas, service exports, and frontend API functions match the frozen v1 contract.

```bash
# Static checks only (no running server needed)
node test/test_backward_compat.mjs --skip-live

# Full validation with live API checks (requires running instances)
./test/setup_local_test.sh
node test/test_backward_compat.mjs

# Custom API URL
node test/test_backward_compat.mjs --api-url http://localhost:8090 --peer-url http://localhost:8091
```

**9 test suites covering:**
1. **Contract file integrity** — v1.json has all required sections
2. **Database schema** — Every table/column in the contract exists in seed.js + db.js
3. **Service exports** — Every function in the contract is exported from its service file
4. **Frontend API client** — Every function in the contract is exported from api/index.js
5. **Route file endpoints** — Every API endpoint in the contract has a matching router handler
6. **Version consistency** — All package.json + hardcoded versions match
7. **Migration system** — db.js has safe migration patterns, migrations.js exists
8. **Live API endpoints** — Sample GET endpoints return expected status codes
9. **Live Peer API** — Peer health endpoint returns expected fields

**Contract file:** `app/backend/src/contracts/v1.json` — the source of truth for all backward compatibility checks.

### Pre-Push Validation

Run the full test gate before deploying:

```bash
# Full suite: compat + medium integration test + frontend build
./pre-push.sh

# Quick mode: compat + small integration test
./pre-push.sh --quick

# Compat checks only (fastest)
./pre-push.sh --compat-only

# Full suite + deploy to Unraid
./pre-push.sh --deploy

# Keep test data after run
./pre-push.sh --keep-data
```

**Steps executed:**
1. Backend syntax check (all .js files)
2. Backward compatibility — static contract validation
3. Frontend build verification
4. Start test instances (Instance A + B)
5. Backward compatibility — live API validation
6. Comprehensive integration test (medium scale by default)
7. Stop test instances
8. Deploy to Unraid (only with `--deploy`)

## Cleanup

```bash
# Stop instances
./test/setup_local_test.sh --stop

# Remove all generated test data
rm -rf test/data/

# Regenerate fresh
python test/generate_test_data.py --size small
```

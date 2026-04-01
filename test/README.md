# RedMan — Test Environment

Local test environment for validating **SSD Backup** (with versioning), **Hyper Backup** (cross-site replication), and **Media Import** features.

## Prerequisites

- Node.js 20+ with RedMan dependencies installed (`cd app && npm install`)
- Python 3.9+ with Pillow and piexif:

```bash
pip install -r test/requirements.txt
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

### Hyper Backup (Cross-Site)

1. Ensure macOS Remote Login is enabled
2. Start instances: `./test/setup_local_test.sh`
3. Open Instance A UI: http://localhost:5175
4. Navigate to Hyper Backup → enable "Test Hyper Push A→B"
5. Run manually → files should appear in `test/data/dest_hyper/`
6. Check Instance B's API for run history: `curl localhost:8094/api/hyper-backup/runs`

### Media Import

1. Create a test "drive" directory:
   ```bash
   mkdir -p /tmp/test_drive/DCIM/100CANON
   cp test/data/source/DCIM/100CANON/*.jpg /tmp/test_drive/DCIM/100CANON/
   ```
2. Symlink to drive monitor path (or set `MEDIA_MOUNT_PATH` env var)
3. Check drive detection in UI → should detect camera type and file counts

## Cleanup

```bash
# Stop instances
./test/setup_local_test.sh --stop

# Remove all generated test data
rm -rf test/data/

# Regenerate fresh
python test/generate_test_data.py --size small
```

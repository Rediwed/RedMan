import db from './db.js';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

// Ensure data directory exists
try { mkdirSync(dirname(db.name), { recursive: true }); } catch {}

console.log('🌱 Seeding RedMan database...');

// Drop existing tables (reverse dependency order)
db.exec(`DROP TABLE IF EXISTS peer_audit_log`);
db.exec(`DROP TABLE IF EXISTS authorized_peers`);
db.exec(`DROP TABLE IF EXISTS backup_run_files`);
db.exec(`DROP TABLE IF EXISTS backup_runs`);
db.exec(`DROP TABLE IF EXISTS ssd_backup_configs`);
db.exec(`DROP TABLE IF EXISTS hyper_backup_jobs`);
db.exec(`DROP TABLE IF EXISTS rclone_jobs`);
db.exec(`DROP TABLE IF EXISTS container_metrics`);
db.exec(`DROP TABLE IF EXISTS media_drives`);
db.exec(`DROP TABLE IF EXISTS settings`);

// Settings (key-value store)
db.exec(`
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

// SSD Backup configurations
db.exec(`
  CREATE TABLE ssd_backup_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    source_path TEXT NOT NULL,
    dest_path TEXT NOT NULL,
    cron_expression TEXT NOT NULL DEFAULT '0 * * * *',
    versioning_enabled INTEGER NOT NULL DEFAULT 1,
    retention_days INTEGER NOT NULL DEFAULT 30,
    delta_versioning INTEGER NOT NULL DEFAULT 0,
    delta_threshold INTEGER NOT NULL DEFAULT 50,
    delta_max_chain INTEGER NOT NULL DEFAULT 10,
    delta_keyframe_days INTEGER NOT NULL DEFAULT 7,
    retention_policy TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    notify_on_success INTEGER NOT NULL DEFAULT 1,
    notify_on_failure INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

// Backup runs (shared across SSD Backup, Hyper Backup, Rclone)
db.exec(`
  CREATE TABLE backup_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feature TEXT NOT NULL,
    config_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    started_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT,
    files_total INTEGER DEFAULT 0,
    files_copied INTEGER DEFAULT 0,
    files_failed INTEGER DEFAULT 0,
    bytes_transferred INTEGER DEFAULT 0,
    duration_seconds REAL,
    error_message TEXT
  )
`);

// Per-file details for backup runs
db.exec(`
  CREATE TABLE backup_run_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES backup_runs(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    action TEXT NOT NULL,
    size INTEGER DEFAULT 0,
    version_path TEXT,
    error TEXT
  )
`);

// Hyper Backup cross-site jobs
db.exec(`
  CREATE TABLE hyper_backup_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    direction TEXT NOT NULL CHECK(direction IN ('push', 'pull')),
    remote_url TEXT NOT NULL,
    remote_api_key TEXT NOT NULL,
    local_path TEXT NOT NULL,
    remote_path TEXT NOT NULL,
    ssh_user TEXT DEFAULT 'root',
    ssh_host TEXT,
    ssh_port INTEGER DEFAULT 22,
    cron_expression TEXT NOT NULL DEFAULT '0 2 * * *',
    enabled INTEGER NOT NULL DEFAULT 1,
    notify_on_success INTEGER NOT NULL DEFAULT 1,
    notify_on_failure INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

// Rclone sync jobs
db.exec(`
  CREATE TABLE rclone_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    local_path TEXT NOT NULL,
    remote_name TEXT NOT NULL,
    remote_path TEXT NOT NULL,
    sync_direction TEXT NOT NULL DEFAULT 'upload' CHECK(sync_direction IN ('upload', 'download', 'bisync')),
    cron_expression TEXT NOT NULL DEFAULT '0 3 * * *',
    enabled INTEGER NOT NULL DEFAULT 1,
    bisync_resync_needed INTEGER NOT NULL DEFAULT 0,
    notify_on_success INTEGER NOT NULL DEFAULT 1,
    notify_on_failure INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

// Container resource metrics (24h retention)
db.exec(`
  CREATE TABLE container_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    container_id TEXT NOT NULL,
    container_name TEXT NOT NULL,
    cpu_percent REAL NOT NULL DEFAULT 0,
    memory_usage INTEGER NOT NULL DEFAULT 0,
    memory_limit INTEGER NOT NULL DEFAULT 0,
    recorded_at TEXT DEFAULT (datetime('now'))
  )
`);

// Media drives — known USB/SD card drives for Immich import
db.exec(`
  CREATE TABLE media_drives (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT,
    serial TEXT,
    label TEXT,
    name TEXT,
    mount_path TEXT,
    size_bytes INTEGER,
    filesystem TEXT,
    detected_camera TEXT,
    auto_import INTEGER NOT NULL DEFAULT 0,
    delete_after_import INTEGER NOT NULL DEFAULT 0,
    eject_after_import INTEGER NOT NULL DEFAULT 0,
    first_seen_at TEXT DEFAULT (datetime('now')),
    last_seen_at TEXT DEFAULT (datetime('now')),
    last_import_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

// Authorized peers — per-peer API keys for Hyper Backup
db.exec(`
  CREATE TABLE authorized_peers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    api_key TEXT NOT NULL UNIQUE,
    allowed_path_prefix TEXT NOT NULL DEFAULT '/',
    storage_limit_bytes INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_seen_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

// Peer audit log — tracks all peer API activity
db.exec(`
  CREATE TABLE peer_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    peer_id INTEGER REFERENCES authorized_peers(id) ON DELETE SET NULL,
    peer_name TEXT,
    action TEXT NOT NULL,
    details TEXT,
    ip_address TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

// Cache table for dashboard stats
db.exec(`
  CREATE TABLE cache (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

// Indexes
db.exec(`CREATE INDEX idx_backup_runs_feature ON backup_runs(feature)`);
db.exec(`CREATE INDEX idx_backup_runs_config ON backup_runs(config_id)`);
db.exec(`CREATE INDEX idx_backup_run_files_run ON backup_run_files(run_id)`);
db.exec(`CREATE INDEX idx_container_metrics_recorded ON container_metrics(recorded_at)`);
db.exec(`CREATE INDEX idx_container_metrics_container ON container_metrics(container_id)`);
db.exec(`CREATE INDEX idx_media_drives_uuid ON media_drives(uuid)`);
db.exec(`CREATE INDEX idx_media_drives_serial ON media_drives(serial)`);
db.exec(`CREATE INDEX idx_authorized_peers_api_key ON authorized_peers(api_key)`);
db.exec(`CREATE INDEX idx_peer_audit_log_peer ON peer_audit_log(peer_id)`);
db.exec(`CREATE INDEX idx_peer_audit_log_created ON peer_audit_log(created_at)`);

// Seed default settings
const upsert = db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`);
const seedSettings = db.transaction(() => {
  upsert.run('instance_name', 'RedMan');

  // Notification channels
  upsert.run('ntfy_enabled', 'false');
  upsert.run('browser_notify_enabled', 'false');

  // ntfy.sh configuration
  upsert.run('ntfy_server', 'https://ntfy.sh');
  upsert.run('ntfy_topic', '');
  upsert.run('ntfy_auth_type', 'none');
  upsert.run('ntfy_auth_token', '');
  upsert.run('ntfy_username', '');
  upsert.run('ntfy_password', '');

  // Legacy ntfy fields (kept for backward compat)
  upsert.run('ntfy_url', '');
  upsert.run('ntfy_token', '');

  // Event toggles
  upsert.run('ntfy_on_job_start', 'true');
  upsert.run('ntfy_on_job_complete', 'true');
  upsert.run('ntfy_on_job_error', 'true');
  upsert.run('ntfy_on_progress', 'false');
  upsert.run('ntfy_progress_interval', '60');
  upsert.run('ntfy_on_drive_attach', 'true');
  upsert.run('ntfy_on_drive_lost', 'true');
  upsert.run('ntfy_on_drive_scan', 'false');

  // Docker
  upsert.run('docker_socket', '/var/run/docker.sock');
  upsert.run('peer_api_port', '8091');
  upsert.run('metrics_poll_interval', '30');
  upsert.run('metrics_retention_hours', '24');

  // Immich / Media Import
  upsert.run('immich_server_url', '');
  upsert.run('immich_api_key', '');
  upsert.run('media_import_poll_interval', '10');
});

seedSettings();

const count = db.prepare('SELECT COUNT(*) as count FROM settings').get();
console.log(`✅ Seeded ${count.count} settings.`);
console.log('✅ RedMan database ready.');

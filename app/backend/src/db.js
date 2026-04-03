import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const dbPath = process.env.DB_PATH || join(__dirname, '..', 'data', 'redman.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Startup migrations ──
// Create authorized_peers + peer_audit_log if they don't exist (for DBs created before this feature)
const tableExists = (name) =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

if (!tableExists('authorized_peers')) {
  db.exec(`
    CREATE TABLE authorized_peers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      api_key TEXT NOT NULL UNIQUE,
      allowed_path_prefix TEXT NOT NULL DEFAULT '/',
      enabled INTEGER NOT NULL DEFAULT 1,
      last_seen_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_authorized_peers_api_key ON authorized_peers(api_key)`);

  // Migrate existing global peer_api_key setting to an authorized_peers row
  const row = db.prepare("SELECT value FROM settings WHERE key = 'peer_api_key'").get();
  if (row?.value && row.value.length > 0) {
    db.prepare(`INSERT INTO authorized_peers (name, api_key, allowed_path_prefix) VALUES (?, ?, '/')`)
      .run('Migrated peer', row.value);
    db.prepare("DELETE FROM settings WHERE key = 'peer_api_key'").run();
    console.log('[migration] Migrated global peer_api_key to authorized_peers table');
  }
}

// Add retention_days column to ssd_backup_configs if missing (versioning retention policy)
if (tableExists('ssd_backup_configs')) {
  const cols = db.prepare("PRAGMA table_info(ssd_backup_configs)").all();
  if (!cols.find(c => c.name === 'retention_days')) {
    db.exec(`ALTER TABLE ssd_backup_configs ADD COLUMN retention_days INTEGER NOT NULL DEFAULT 30`);
    console.log('[migration] Added retention_days column to ssd_backup_configs');
  }
}

// Add delta versioning columns to ssd_backup_configs if missing
if (tableExists('ssd_backup_configs')) {
  const dvCols = db.prepare("PRAGMA table_info(ssd_backup_configs)").all();
  if (!dvCols.find(c => c.name === 'delta_versioning')) {
    db.exec(`ALTER TABLE ssd_backup_configs ADD COLUMN delta_versioning INTEGER NOT NULL DEFAULT 0`);
    db.exec(`ALTER TABLE ssd_backup_configs ADD COLUMN delta_threshold INTEGER NOT NULL DEFAULT 50`);
    db.exec(`ALTER TABLE ssd_backup_configs ADD COLUMN delta_max_chain INTEGER NOT NULL DEFAULT 10`);
    db.exec(`ALTER TABLE ssd_backup_configs ADD COLUMN delta_keyframe_days INTEGER NOT NULL DEFAULT 7`);
    console.log('[migration] Added delta versioning columns to ssd_backup_configs');
  }
  if (!dvCols.find(c => c.name === 'retention_policy')) {
    db.exec(`ALTER TABLE ssd_backup_configs ADD COLUMN retention_policy TEXT`);
    // Migrate existing retention_days to retention_policy JSON
    const configs = db.prepare('SELECT id, retention_days FROM ssd_backup_configs').all();
    const updateStmt = db.prepare('UPDATE ssd_backup_configs SET retention_policy = ? WHERE id = ?');
    for (const cfg of configs) {
      const policy = JSON.stringify({ hourly: 24, daily: cfg.retention_days || 7, weekly: 30, monthly: 90, quarterly: 365 });
      updateStmt.run(policy, cfg.id);
    }
    console.log('[migration] Added retention_policy column to ssd_backup_configs');
  }
}

// Create cache table for dashboard stats
if (!tableExists('cache')) {
  db.exec(`
    CREATE TABLE cache (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
  console.log('[migration] Created cache table');
}

// Add storage_limit_bytes column to authorized_peers if missing (per-peer storage quota)
if (tableExists('authorized_peers')) {
  const peerCols = db.prepare("PRAGMA table_info(authorized_peers)").all();
  if (!peerCols.find(c => c.name === 'storage_limit_bytes')) {
    db.exec(`ALTER TABLE authorized_peers ADD COLUMN storage_limit_bytes INTEGER NOT NULL DEFAULT 0`);
    console.log('[migration] Added storage_limit_bytes column to authorized_peers (0 = unlimited)');
  }
}

// Add busy_timeout for concurrent access during long operations
db.pragma('busy_timeout = 5000');

// Ensure index on backup_run_files(run_id) exists (critical for run detail queries at scale)
if (tableExists('backup_run_files')) {
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='backup_run_files' AND name='idx_backup_run_files_run'").get();
  if (!indexes) {
    db.exec(`CREATE INDEX idx_backup_run_files_run ON backup_run_files(run_id)`);
    console.log('[migration] Added index idx_backup_run_files_run on backup_run_files(run_id)');
  }
}

if (!tableExists('peer_audit_log')) {
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
  db.exec(`CREATE INDEX IF NOT EXISTS idx_peer_audit_log_peer ON peer_audit_log(peer_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_peer_audit_log_created ON peer_audit_log(created_at)`);
}

// ── Formal versioned migrations ──
// New schema changes go in migrations.js, not as inline ALTER TABLE here.
import { runMigrations } from './migrations.js';
runMigrations(db);

export default db;

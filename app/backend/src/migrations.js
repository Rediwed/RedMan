// RedMan — Formal Migration System
// Tracks schema version and runs numbered migrations in order.
// Migrations are additive-only: new columns, new tables, new indexes.
// Removing columns or tables requires a major version bump + contract update.
//
// Usage: import and call runMigrations(db) during startup in db.js

import { statfsSync } from 'node:fs';
import { dirname } from 'node:path';

export const STARTUP_MIGRATION_MIN_FREE_BYTES = 1024 ** 3;
export const STARTUP_MIGRATION_ROW_LIMITS = Object.freeze({
  configuration: 10_000,
  history: 100_000,
  audit: 250_000,
  telemetry: 1_000_000,
  files: 1_000_000,
});

const MIGRATION_TABLE_LIMITS = Object.freeze({
  0: {
    settings: STARTUP_MIGRATION_ROW_LIMITS.configuration,
    ssd_backup_configs: STARTUP_MIGRATION_ROW_LIMITS.configuration,
    backup_runs: STARTUP_MIGRATION_ROW_LIMITS.history,
    backup_run_files: STARTUP_MIGRATION_ROW_LIMITS.files,
    hyper_backup_jobs: STARTUP_MIGRATION_ROW_LIMITS.configuration,
    rclone_jobs: STARTUP_MIGRATION_ROW_LIMITS.configuration,
    container_metrics: STARTUP_MIGRATION_ROW_LIMITS.telemetry,
    media_drives: STARTUP_MIGRATION_ROW_LIMITS.configuration,
    media_import_ledger: STARTUP_MIGRATION_ROW_LIMITS.files,
    authorized_peers: STARTUP_MIGRATION_ROW_LIMITS.configuration,
    peer_audit_log: STARTUP_MIGRATION_ROW_LIMITS.audit,
    cache: STARTUP_MIGRATION_ROW_LIMITS.history,
    pairing_requests: STARTUP_MIGRATION_ROW_LIMITS.configuration,
  },
  13: { hyper_backup_jobs: STARTUP_MIGRATION_ROW_LIMITS.configuration, pairing_requests: STARTUP_MIGRATION_ROW_LIMITS.configuration },
  14: { backup_runs: STARTUP_MIGRATION_ROW_LIMITS.history, hyper_backup_jobs: STARTUP_MIGRATION_ROW_LIMITS.configuration },
  15: { media_drives: STARTUP_MIGRATION_ROW_LIMITS.configuration },
  16: { media_import_ledger: STARTUP_MIGRATION_ROW_LIMITS.files },
  17: { hyper_backup_jobs: STARTUP_MIGRATION_ROW_LIMITS.configuration },
  18: {
    authorized_peers: STARTUP_MIGRATION_ROW_LIMITS.configuration,
    pairing_requests: STARTUP_MIGRATION_ROW_LIMITS.configuration,
    hyper_backup_jobs: STARTUP_MIGRATION_ROW_LIMITS.configuration,
  },
  21: { restore_events: STARTUP_MIGRATION_ROW_LIMITS.history },
  22: {
    auth_users: STARTUP_MIGRATION_ROW_LIMITS.configuration,
    auth_credentials: STARTUP_MIGRATION_ROW_LIMITS.configuration,
    auth_sessions: STARTUP_MIGRATION_ROW_LIMITS.history,
    auth_recovery_events: STARTUP_MIGRATION_ROW_LIMITS.history,
    auth_audit_log: STARTUP_MIGRATION_ROW_LIMITS.audit,
  },
  23: { ssd_backup_configs: STARTUP_MIGRATION_ROW_LIMITS.configuration, authorized_peers: STARTUP_MIGRATION_ROW_LIMITS.configuration },
  25: { authorized_peers: STARTUP_MIGRATION_ROW_LIMITS.configuration, pairing_requests: STARTUP_MIGRATION_ROW_LIMITS.configuration },
  26: {
    backup_runs: STARTUP_MIGRATION_ROW_LIMITS.history,
    peer_audit_log: STARTUP_MIGRATION_ROW_LIMITS.audit,
    auth_sessions: STARTUP_MIGRATION_ROW_LIMITS.history,
    auth_recovery_events: STARTUP_MIGRATION_ROW_LIMITS.history,
  },
});

function tableExists(database, table) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function indexExists(database, index) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(index));
}

export function assertMigrationWorkloadBounded(database, migrationVersion, options = {}) {
  const limits = { ...(MIGRATION_TABLE_LIMITS[migrationVersion] || {}) };
  if (migrationVersion === 23 && !indexExists(database, 'idx_backup_run_files_run')) {
    limits.backup_run_files = STARTUP_MIGRATION_ROW_LIMITS.files;
  }

  const tableMaxRowIds = {};
  for (const [table, limit] of Object.entries(limits)) {
    if (!tableExists(database, table)) continue;
    const maxRowId = Number(database.prepare(`SELECT COALESCE(MAX(rowid), 0) AS value FROM ${table}`).get().value);
    tableMaxRowIds[table] = maxRowId;
    if (!Number.isSafeInteger(maxRowId) || maxRowId > limit) {
      throw new Error(`Migration ${migrationVersion} blocked: ${table} rowid ${maxRowId} exceeds the startup limit ${limit}; use a controlled offline migration`);
    }
  }

  let availableBytes = options.availableBytes ?? null;
  if (availableBytes === null && database.name && database.name !== ':memory:') {
    const filesystem = statfsSync(dirname(database.name), { bigint: true });
    availableBytes = Number(filesystem.bavail * filesystem.bsize);
  }
  if (availableBytes !== null && (!Number.isFinite(availableBytes) || availableBytes < STARTUP_MIGRATION_MIN_FREE_BYTES)) {
    throw new Error(`Migration ${migrationVersion} blocked: at least 1 GiB free is required for bounded WAL/index amplification`);
  }
  return { tableMaxRowIds, availableBytes };
}

// Each migration has a version number, description, and up() function.
// Migrations MUST be idempotent — they run table/column existence checks internally.
// Once a migration is released, it must NEVER be modified.
const migrations = [
  // ── v1.0.0 baseline ──
  {
    version: 0,
    description: 'Create the non-destructive baseline schema for fresh installations',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS ssd_backup_configs (
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
          exclude_patterns TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          notify_mode TEXT NOT NULL DEFAULT 'global',
          notify_on_start INTEGER NOT NULL DEFAULT 1,
          notify_on_success INTEGER NOT NULL DEFAULT 1,
          notify_on_failure INTEGER NOT NULL DEFAULT 1,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS backup_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          feature TEXT NOT NULL,
          config_id INTEGER NOT NULL,
          peer_static_pubkey TEXT,
          status TEXT NOT NULL DEFAULT 'running',
          started_at TEXT DEFAULT (datetime('now')),
          completed_at TEXT,
          files_total INTEGER DEFAULT 0,
          files_copied INTEGER DEFAULT 0,
          files_failed INTEGER DEFAULT 0,
          bytes_transferred INTEGER DEFAULT 0,
          duration_seconds REAL,
          error_message TEXT
        );

        CREATE TABLE IF NOT EXISTS backup_run_files (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id INTEGER NOT NULL REFERENCES backup_runs(id) ON DELETE CASCADE,
          file_path TEXT NOT NULL,
          action TEXT NOT NULL,
          size INTEGER DEFAULT 0,
          version_path TEXT,
          error TEXT,
          file_date TEXT
        );

        CREATE TABLE IF NOT EXISTS hyper_backup_jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          direction TEXT NOT NULL CHECK(direction IN ('push', 'pull')),
          remote_url TEXT NOT NULL,
          remote_api_key TEXT NOT NULL,
          remote_api_key_encrypted TEXT,
          peer_static_pubkey TEXT,
          local_path TEXT NOT NULL,
          remote_path TEXT NOT NULL,
          ssh_user TEXT DEFAULT 'redman-backup',
          ssh_host TEXT,
          ssh_port INTEGER DEFAULT 22,
          cron_expression TEXT NOT NULL DEFAULT '0 2 * * *',
          enabled INTEGER NOT NULL DEFAULT 1,
          notify_mode TEXT NOT NULL DEFAULT 'global',
          notify_on_start INTEGER NOT NULL DEFAULT 1,
          notify_on_success INTEGER NOT NULL DEFAULT 1,
          notify_on_failure INTEGER NOT NULL DEFAULT 1,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS rclone_jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          local_path TEXT NOT NULL,
          remote_name TEXT NOT NULL,
          remote_path TEXT NOT NULL,
          sync_direction TEXT NOT NULL DEFAULT 'upload' CHECK(sync_direction IN ('upload', 'download', 'bisync')),
          cron_expression TEXT NOT NULL DEFAULT '0 3 * * *',
          enabled INTEGER NOT NULL DEFAULT 1,
          bisync_resync_needed INTEGER NOT NULL DEFAULT 0,
          notify_mode TEXT NOT NULL DEFAULT 'global',
          notify_on_start INTEGER NOT NULL DEFAULT 1,
          notify_on_success INTEGER NOT NULL DEFAULT 1,
          notify_on_failure INTEGER NOT NULL DEFAULT 1,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS container_metrics (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          container_id TEXT NOT NULL,
          container_name TEXT NOT NULL,
          cpu_percent REAL NOT NULL DEFAULT 0,
          memory_usage INTEGER NOT NULL DEFAULT 0,
          memory_limit INTEGER NOT NULL DEFAULT 0,
          recorded_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS media_drives (
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
        );

        CREATE TABLE IF NOT EXISTS media_import_ledger (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id INTEGER NOT NULL REFERENCES backup_runs(id) ON DELETE CASCADE,
          source_path TEXT NOT NULL,
          outcome TEXT NOT NULL,
          source_size INTEGER,
          source_mtime TEXT,
          source_sha256 TEXT,
          error TEXT,
          verified_at TEXT,
          deleted_at TEXT,
          deletion_error TEXT,
          UNIQUE(run_id, source_path)
        );

        CREATE TABLE IF NOT EXISTS authorized_peers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          api_key TEXT NOT NULL UNIQUE,
          api_key_hash TEXT,
          allowed_path_prefix TEXT NOT NULL DEFAULT '/',
          storage_limit_bytes INTEGER NOT NULL DEFAULT 0,
          enabled INTEGER NOT NULL DEFAULT 1,
          last_seen_at TEXT,
          last_seen_ip TEXT,
          static_pubkey TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS peer_audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          peer_id INTEGER REFERENCES authorized_peers(id) ON DELETE SET NULL,
          peer_name TEXT,
          action TEXT NOT NULL,
          details TEXT,
          ip_address TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS cache (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS pairing_requests (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          direction TEXT NOT NULL,
          token TEXT NOT NULL UNIQUE,
          remote_instance TEXT NOT NULL,
          remote_url TEXT NOT NULL,
          remote_ssh_pubkey TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          peer_id INTEGER REFERENCES authorized_peers(id),
          api_key TEXT,
          api_key_encrypted TEXT,
          error TEXT,
          remote_storage_limit INTEGER,
          remote_allowed_path TEXT,
          handshake_version INTEGER DEFAULT 1,
          remote_ephemeral_pubkey TEXT,
          remote_static_pubkey TEXT,
          ephemeral_secret TEXT,
          remote_fingerprint TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          expires_at TEXT DEFAULT (datetime('now', '+10 minutes'))
        );

        CREATE INDEX IF NOT EXISTS idx_backup_runs_feature ON backup_runs(feature);
        CREATE INDEX IF NOT EXISTS idx_backup_runs_config ON backup_runs(config_id);
        CREATE INDEX IF NOT EXISTS idx_backup_run_files_run ON backup_run_files(run_id);
        CREATE INDEX IF NOT EXISTS idx_container_metrics_recorded ON container_metrics(recorded_at);
        CREATE INDEX IF NOT EXISTS idx_container_metrics_container ON container_metrics(container_id);
        CREATE INDEX IF NOT EXISTS idx_media_drives_uuid ON media_drives(uuid);
        CREATE INDEX IF NOT EXISTS idx_media_drives_serial ON media_drives(serial);
        CREATE INDEX IF NOT EXISTS idx_media_import_ledger_run ON media_import_ledger(run_id);
        CREATE INDEX IF NOT EXISTS idx_authorized_peers_api_key ON authorized_peers(api_key);
        CREATE INDEX IF NOT EXISTS idx_peer_audit_log_peer ON peer_audit_log(peer_id);
        CREATE INDEX IF NOT EXISTS idx_peer_audit_log_created ON peer_audit_log(created_at);
        CREATE INDEX IF NOT EXISTS idx_pairing_token ON pairing_requests(token);
        CREATE INDEX IF NOT EXISTS idx_pairing_status ON pairing_requests(status);
      `);
      console.log('[migration-0] Created baseline schema');
    }
  },

  {
    version: 1,
    description: 'Ensure backup_run_files table exists for import detail tracking',
    up(db) {
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='backup_run_files'").get();
      if (!exists) {
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
        db.exec(`CREATE INDEX idx_backup_run_files_run ON backup_run_files(run_id)`);
        console.log('[migration-1] Created backup_run_files table');
      }
    }
  },

  {
    version: 2,
    description: 'Add file_date column to backup_run_files for photo date tracking',
    up(db) {
      const cols = db.prepare("PRAGMA table_info(backup_run_files)").all();
      if (!cols.find(c => c.name === 'file_date')) {
        db.exec(`ALTER TABLE backup_run_files ADD COLUMN file_date TEXT`);
        console.log('[migration-2] Added file_date column to backup_run_files');
      }
    }
  },

  {
    version: 3,
    description: 'Add last_seen_ip column to authorized_peers for connectivity checks',
    up(db) {
      const cols = db.prepare("PRAGMA table_info(authorized_peers)").all();
      if (!cols.find(c => c.name === 'last_seen_ip')) {
        db.exec(`ALTER TABLE authorized_peers ADD COLUMN last_seen_ip TEXT`);
        console.log('[migration-3] Added last_seen_ip column to authorized_peers');
      }
    }
  },

  {
    version: 4,
    description: 'Add pairing_requests table for peer-to-peer handshake flow',
    up(db) {
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pairing_requests'").get();
      if (!exists) {
        db.exec(`
          CREATE TABLE pairing_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            direction TEXT NOT NULL,
            token TEXT NOT NULL UNIQUE,
            remote_instance TEXT NOT NULL,
            remote_url TEXT NOT NULL,
            remote_ssh_pubkey TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            peer_id INTEGER REFERENCES authorized_peers(id),
            api_key TEXT,
            error TEXT,
            remote_storage_limit INTEGER,
            remote_allowed_path TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            expires_at TEXT DEFAULT (datetime('now', '+10 minutes'))
          )
        `);
        db.exec(`CREATE INDEX idx_pairing_token ON pairing_requests(token)`);
        db.exec(`CREATE INDEX idx_pairing_status ON pairing_requests(status)`);
        console.log('[migration-4] Created pairing_requests table');
      }
    }
  },

  {
    version: 5,
    description: 'Add remote_storage_limit and remote_allowed_path to pairing_requests',
    up(db) {
      const cols = db.prepare("PRAGMA table_info(pairing_requests)").all();
      if (!cols.find(c => c.name === 'remote_storage_limit')) {
        db.exec(`ALTER TABLE pairing_requests ADD COLUMN remote_storage_limit INTEGER`);
        console.log('[migration-5] Added remote_storage_limit to pairing_requests');
      }
      if (!cols.find(c => c.name === 'remote_allowed_path')) {
        db.exec(`ALTER TABLE pairing_requests ADD COLUMN remote_allowed_path TEXT`);
        console.log('[migration-5] Added remote_allowed_path to pairing_requests');
      }
    }
  },

  {
    version: 6,
    description: 'Add Noise XX handshake columns to pairing_requests and authorized_peers',
    up(db) {
      // pairing_requests: store ephemeral pubkeys, static pubkeys, and ephemeral secret (initiator only)
      const prCols = db.prepare("PRAGMA table_info(pairing_requests)").all();
      const prNew = [
        ['handshake_version', 'INTEGER DEFAULT 1'],
        ['remote_ephemeral_pubkey', 'TEXT'],
        ['remote_static_pubkey', 'TEXT'],
        ['ephemeral_secret', 'TEXT'],       // initiator stores its ephemeral privkey here until callback
        ['remote_fingerprint', 'TEXT'],
      ];
      for (const [col, type] of prNew) {
        if (!prCols.find(c => c.name === col)) {
          db.exec(`ALTER TABLE pairing_requests ADD COLUMN ${col} ${type}`);
        }
      }

      // authorized_peers: store remote static identity pubkey for future re-pairing verification
      const apCols = db.prepare("PRAGMA table_info(authorized_peers)").all();
      if (!apCols.find(c => c.name === 'static_pubkey')) {
        db.exec(`ALTER TABLE authorized_peers ADD COLUMN static_pubkey TEXT`);
      }

      console.log('[migration-6] Added Noise XX handshake columns');
    }
  },

  {
    version: 7,
    description: 'Add notify_mode and notify_on_start columns—global/custom/silent notification per job',
    up(db) {
      const tables = ['ssd_backup_configs', 'hyper_backup_jobs', 'rclone_jobs'];
      for (const table of tables) {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all();
        if (!cols.find(c => c.name === 'notify_mode')) {
          db.exec(`ALTER TABLE ${table} ADD COLUMN notify_mode TEXT NOT NULL DEFAULT 'global'`);
        }
        if (!cols.find(c => c.name === 'notify_on_start')) {
          db.exec(`ALTER TABLE ${table} ADD COLUMN notify_on_start INTEGER NOT NULL DEFAULT 1`);
        }
      }
      console.log('[migration-7] Added notify_mode and notify_on_start to job tables');
    }
  },
  {
    version: 8,
    description: 'Add exclude_patterns column to ssd_backup_configs for user-defined rsync excludes',
    up(db) {
      const cols = db.prepare('PRAGMA table_info(ssd_backup_configs)').all();
      if (!cols.find(c => c.name === 'exclude_patterns')) {
        db.exec(`ALTER TABLE ssd_backup_configs ADD COLUMN exclude_patterns TEXT`);
      }
      console.log('[migration-8] Added exclude_patterns to ssd_backup_configs');
    }
  },

  {
    version: 9,
    description: 'Add general settings: timezone, date_format, time_format, hidden_drives',
    up(db) {
      const upsert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
      upsert.run('timezone', process.env.TZ || 'UTC');
      upsert.run('date_format', 'system');
      upsert.run('time_format', 'system');
      upsert.run('hidden_drives', '[]');
      console.log('[migration-9] Added general settings: timezone, date_format, time_format, hidden_drives');
    }
  },

  {
    version: 10,
    description: 'Add hidden_remote_drives setting for filtering remote peer browsing',
    up(db) {
      const upsert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
      upsert.run('hidden_remote_drives', '[]');
      console.log('[migration-10] Added hidden_remote_drives setting');
    }
  },

  {
    version: 11,
    description: 'Add run_files_retention_days setting to cap backup_run_files growth',
    up(db) {
      const upsert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
      upsert.run('run_files_retention_days', '30');
      console.log('[migration-11] Added run_files_retention_days setting (default 30)');
    }
  },

  {
    version: 12,
    description: 'Add ssd_allow_empty_source safeguard setting (off by default)',
    up(db) {
      const upsert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
      upsert.run('ssd_allow_empty_source', '0');
      console.log('[migration-12] Added ssd_allow_empty_source setting (default 0 = guard enabled)');
    }
  },

  {
    version: 13,
    description: 'Bind Hyper Backup jobs to stable peer static identities',
    up(db) {
      const cols = db.prepare('PRAGMA table_info(hyper_backup_jobs)').all();
      if (!cols.find(c => c.name === 'peer_static_pubkey')) {
        db.exec('ALTER TABLE hyper_backup_jobs ADD COLUMN peer_static_pubkey TEXT');
      }
      db.exec(`
        UPDATE hyper_backup_jobs
        SET peer_static_pubkey = (
          SELECT pr.remote_static_pubkey
          FROM pairing_requests pr
          WHERE pr.direction = 'outgoing'
            AND pr.status = 'accepted'
            AND pr.remote_url = hyper_backup_jobs.remote_url
            AND pr.remote_static_pubkey IS NOT NULL
          ORDER BY pr.id DESC
          LIMIT 1
        )
        WHERE peer_static_pubkey IS NULL
      `);
      console.log('[migration-13] Bound paired Hyper Backup jobs to static peer identities');
    }
  },

  {
    version: 14,
    description: 'Bind Hyper Backup run records to stable peer static identities',
    up(db) {
      const cols = db.prepare('PRAGMA table_info(backup_runs)').all();
      if (!cols.find(c => c.name === 'peer_static_pubkey')) {
        db.exec('ALTER TABLE backup_runs ADD COLUMN peer_static_pubkey TEXT');
      }
      db.exec(`
        UPDATE backup_runs
        SET peer_static_pubkey = (
          SELECT hj.peer_static_pubkey
          FROM hyper_backup_jobs hj
          WHERE hj.id = backup_runs.config_id
        )
        WHERE feature = 'hyper-backup' AND peer_static_pubkey IS NULL
      `);
      console.log('[migration-14] Bound Hyper Backup runs to static peer identities');
    }
  },

  {
    version: 15,
    description: 'Disable unsafe delete-after-import until per-file verification exists',
    up(db) {
      db.exec('UPDATE media_drives SET delete_after_import = 0 WHERE delete_after_import != 0');
      console.log('[migration-15] Disabled delete-after-import for existing drives');
    }
  },

  {
    version: 16,
    description: 'Add durable per-file media import verification and deletion ledger',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS media_import_ledger (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id INTEGER NOT NULL REFERENCES backup_runs(id) ON DELETE CASCADE,
          source_path TEXT NOT NULL,
          outcome TEXT NOT NULL,
          source_size INTEGER,
          source_mtime TEXT,
          source_sha256 TEXT,
          error TEXT,
          verified_at TEXT,
          deleted_at TEXT,
          deletion_error TEXT,
          UNIQUE(run_id, source_path)
        );
        CREATE INDEX IF NOT EXISTS idx_media_import_ledger_run ON media_import_ledger(run_id);
      `);
      console.log('[migration-16] Added media import verification ledger');
    }
  },

  {
    version: 17,
    description: 'Migrate Hyper Backup SSH jobs from root to the restricted account',
    up(db) {
      db.prepare("UPDATE hyper_backup_jobs SET ssh_user = 'redman-backup' WHERE ssh_user IS NULL OR ssh_user = 'root'").run();
      console.log('[migration-17] Migrated Hyper Backup jobs to redman-backup SSH user');
    }
  },

  {
    version: 18,
    description: 'Add hashed and encrypted peer credential storage',
    up(db) {
      const peerCols = db.prepare('PRAGMA table_info(authorized_peers)').all();
      if (!peerCols.find(column => column.name === 'api_key_hash')) {
        db.exec('ALTER TABLE authorized_peers ADD COLUMN api_key_hash TEXT');
      }
      const pairingCols = db.prepare('PRAGMA table_info(pairing_requests)').all();
      if (!pairingCols.find(column => column.name === 'api_key_encrypted')) {
        db.exec('ALTER TABLE pairing_requests ADD COLUMN api_key_encrypted TEXT');
      }
      const jobCols = db.prepare('PRAGMA table_info(hyper_backup_jobs)').all();
      if (!jobCols.find(column => column.name === 'remote_api_key_encrypted')) {
        db.exec('ALTER TABLE hyper_backup_jobs ADD COLUMN remote_api_key_encrypted TEXT');
      }
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_authorized_peers_api_key_hash ON authorized_peers(api_key_hash)');
      console.log('[migration-18] Added protected peer credential columns');
    }
  },

  {
    version: 19,
    description: 'Route Docker access through the internal socket proxy',
    up(db) {
      db.prepare(`
        UPDATE settings SET value = 'http://docker-socket-proxy:2375', updated_at = datetime('now')
        WHERE key = 'docker_socket' AND value = '/var/run/docker.sock'
      `).run();
      console.log('[migration-19] Migrated Docker endpoint to socket proxy');
    }
  },

  {
    version: 20,
    description: 'Add bounded run history and peer audit retention settings',
    up(db) {
      const upsert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
      upsert.run('run_history_retention_days', '365');
      upsert.run('peer_audit_retention_days', '30');
      upsert.run('peer_security_audit_retention_days', '365');
      console.log('[migration-20] Added run history and peer audit retention settings');
    }
  },

  {
    version: 21,
    description: 'Add auditable restore outcomes and verification timestamps',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS restore_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          config_id INTEGER NOT NULL,
          snapshot_timestamp TEXT NOT NULL,
          file_path TEXT NOT NULL,
          restored_to TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'running',
          verified_at TEXT,
          error_message TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          completed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_restore_events_config ON restore_events(config_id, completed_at DESC);
      `);
      console.log('[migration-21] Added restore outcome audit trail');
    }
  },

  {
    version: 22,
    description: 'Add local and proxy identity, credential, session, recovery, and audit tables',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS auth_users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          provider TEXT NOT NULL CHECK (provider IN ('local', 'proxy')),
          provider_subject TEXT NOT NULL,
          username TEXT NOT NULL COLLATE NOCASE,
          display_name TEXT,
          email TEXT,
          role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin', 'viewer')),
          enabled INTEGER NOT NULL DEFAULT 1,
          failed_attempts INTEGER NOT NULL DEFAULT 0,
          locked_until TEXT,
          last_login_at TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          UNIQUE(provider, provider_subject),
          UNIQUE(username)
        );
        CREATE TABLE IF NOT EXISTS auth_credentials (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
          credential_type TEXT NOT NULL CHECK (credential_type IN ('password')),
          secret_hash TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          UNIQUE(user_id, credential_type)
        );
        CREATE TABLE IF NOT EXISTS auth_sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL UNIQUE,
          csrf_token_hash TEXT NOT NULL,
          ip_address TEXT,
          user_agent TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          last_seen_at TEXT DEFAULT (datetime('now')),
          idle_expires_at TEXT NOT NULL,
          absolute_expires_at TEXT NOT NULL,
          revoked_at TEXT
        );
        CREATE TABLE IF NOT EXISTS auth_recovery_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'used', 'expired', 'revoked')),
          expires_at TEXT NOT NULL,
          used_at TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS auth_audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER REFERENCES auth_users(id) ON DELETE SET NULL,
          actor_user_id INTEGER REFERENCES auth_users(id) ON DELETE SET NULL,
          event TEXT NOT NULL,
          details TEXT,
          ip_address TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_auth_users_provider_subject ON auth_users(provider, provider_subject);
        CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id, revoked_at);
        CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions(idle_expires_at, absolute_expires_at);
        CREATE INDEX IF NOT EXISTS idx_auth_recovery_user ON auth_recovery_events(user_id, status);
        CREATE INDEX IF NOT EXISTS idx_auth_audit_created ON auth_audit_log(created_at);
      `);
      db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('auth_audit_retention_days', '365')").run();
      console.log('[migration-22] Added native identity and session schema');
    }
  },

  {
    version: 23,
    description: 'Absorb legacy inline schema repairs into the numbered migration path',
    up(db) {
      const columns = table => db.prepare(`PRAGMA table_info(${table})`).all();
      const hasColumn = (table, column) => columns(table).some(entry => entry.name === column);

      if (!hasColumn('ssd_backup_configs', 'retention_days')) {
        db.exec('ALTER TABLE ssd_backup_configs ADD COLUMN retention_days INTEGER NOT NULL DEFAULT 30');
      }
      const deltaColumns = [
        ['delta_versioning', 'INTEGER NOT NULL DEFAULT 0'],
        ['delta_threshold', 'INTEGER NOT NULL DEFAULT 50'],
        ['delta_max_chain', 'INTEGER NOT NULL DEFAULT 10'],
        ['delta_keyframe_days', 'INTEGER NOT NULL DEFAULT 7'],
      ];
      for (const [name, definition] of deltaColumns) {
        if (!hasColumn('ssd_backup_configs', name)) {
          db.exec(`ALTER TABLE ssd_backup_configs ADD COLUMN ${name} ${definition}`);
        }
      }
      if (!hasColumn('ssd_backup_configs', 'retention_policy')) {
        db.exec('ALTER TABLE ssd_backup_configs ADD COLUMN retention_policy TEXT');
      }
      const configs = db.prepare(`
        SELECT id, retention_days FROM ssd_backup_configs WHERE retention_policy IS NULL
      `).all();
      const updatePolicy = db.prepare('UPDATE ssd_backup_configs SET retention_policy = ? WHERE id = ?');
      for (const config of configs) {
        updatePolicy.run(JSON.stringify({
          hourly: 24,
          daily: config.retention_days || 7,
          weekly: 30,
          monthly: 90,
          quarterly: 365,
        }), config.id);
      }

      if (!hasColumn('authorized_peers', 'storage_limit_bytes')) {
        db.exec('ALTER TABLE authorized_peers ADD COLUMN storage_limit_bytes INTEGER NOT NULL DEFAULT 0');
      }

      const legacyPeerKey = db.prepare("SELECT value FROM settings WHERE key = 'peer_api_key'").get()?.value;
      if (legacyPeerKey) {
        db.prepare(`
          INSERT OR IGNORE INTO authorized_peers (name, api_key, allowed_path_prefix)
          VALUES ('Migrated peer', ?, '/')
        `).run(legacyPeerKey);
        db.prepare("DELETE FROM settings WHERE key = 'peer_api_key'").run();
      }

      db.exec('CREATE INDEX IF NOT EXISTS idx_backup_run_files_run ON backup_run_files(run_id)');
      console.log('[migration-23] Consolidated legacy inline schema repairs');
    }
  },

  {
    version: 24,
    description: 'Retire legacy ntfy URL and token setting aliases',
    up(db) {
      const get = key => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
      const upsert = db.prepare(`
        INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
      `);

      const legacyUrl = get('ntfy_url');
      const currentServer = get('ntfy_server');
      if (legacyUrl && (!currentServer || currentServer === 'https://ntfy.sh')) {
        upsert.run('ntfy_server', legacyUrl);
      }

      const legacyToken = get('ntfy_token');
      const currentToken = get('ntfy_auth_token');
      if (legacyToken && !currentToken) {
        upsert.run('ntfy_auth_token', legacyToken);
        if (!get('ntfy_auth_type') || get('ntfy_auth_type') === 'none') {
          upsert.run('ntfy_auth_type', 'token');
        }
      }

      db.prepare("DELETE FROM settings WHERE key IN ('ntfy_url', 'ntfy_token')").run();
      console.log('[migration-24] Retired legacy ntfy setting aliases');
    }
  },

  {
    version: 25,
    description: 'Track peer SSH key identity and disable unsafe legacy access grants',
    up(db) {
      const columns = db.prepare('PRAGMA table_info(authorized_peers)').all();
      if (!columns.some(column => column.name === 'ssh_public_key')) {
        db.exec('ALTER TABLE authorized_peers ADD COLUMN ssh_public_key TEXT');
      }
      db.exec(`
        UPDATE authorized_peers
        SET ssh_public_key = (
          SELECT remote_ssh_pubkey FROM pairing_requests
          WHERE pairing_requests.peer_id = authorized_peers.id
            AND remote_ssh_pubkey IS NOT NULL
          ORDER BY pairing_requests.id DESC LIMIT 1
        )
        WHERE ssh_public_key IS NULL
      `);
      db.prepare(`
        UPDATE authorized_peers SET enabled = 0
        WHERE enabled = 1 AND (
          allowed_path_prefix = '/'
          OR storage_limit_bytes <= 0
          OR (static_pubkey IS NOT NULL AND ssh_public_key IS NULL)
        )
      `).run();
      console.log('[migration-25] Added peer SSH key identity and disabled unsafe legacy grants');
    }
  },

  {
    version: 26,
    description: 'Add indexes for bounded retention batches',
    up(db) {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_backup_runs_started_at ON backup_runs(started_at);
        CREATE INDEX IF NOT EXISTS idx_backup_runs_completed_at ON backup_runs(completed_at);
        CREATE INDEX IF NOT EXISTS idx_peer_audit_action_created ON peer_audit_log(action, created_at);
        CREATE INDEX IF NOT EXISTS idx_auth_sessions_revoked ON auth_sessions(revoked_at);
        CREATE INDEX IF NOT EXISTS idx_auth_sessions_absolute ON auth_sessions(absolute_expires_at);
        CREATE INDEX IF NOT EXISTS idx_auth_recovery_created ON auth_recovery_events(created_at);
      `);
      console.log('[migration-26] Added bounded-retention indexes');
    }
  },

  {
    version: 27,
    description: 'Record the per-run database backup integrity verification outcome',
    up(db) {
      // ALTER TABLE ADD COLUMN is a metadata-only change in SQLite, so this
      // stays bounded regardless of how much run history is retained.
      const columns = db.prepare('PRAGMA table_info(backup_runs)').all().map(column => column.name);
      if (!columns.includes('db_backup_status')) {
        db.exec('ALTER TABLE backup_runs ADD COLUMN db_backup_status TEXT');
      }
      console.log('[migration-27] Added database backup integrity verification column');
    }
  },
  {
    version: 28,
    description: 'Record the reciprocal backup offer exchanged during pairing',
    up(db) {
      // ALTER TABLE ADD COLUMN is metadata-only in SQLite, so this stays bounded
      // regardless of how much pairing history is retained.
      const columns = db.prepare('PRAGMA table_info(pairing_requests)').all().map(column => column.name);
      if (!columns.includes('reciprocal_path')) {
        db.exec('ALTER TABLE pairing_requests ADD COLUMN reciprocal_path TEXT');
      }
      if (!columns.includes('reciprocal_limit_bytes')) {
        db.exec('ALTER TABLE pairing_requests ADD COLUMN reciprocal_limit_bytes INTEGER');
      }
      if (!columns.includes('reciprocal_accepted')) {
        db.exec('ALTER TABLE pairing_requests ADD COLUMN reciprocal_accepted INTEGER NOT NULL DEFAULT 0');
      }
      console.log('[migration-28] Added reciprocal pairing offer columns');
    }
  },
  {
    version: 29,
    description: 'Track externally scheduled jobs that report in by heartbeat',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS external_jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          slug TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          host TEXT,
          cron_expression TEXT,
          grace_seconds INTEGER NOT NULL DEFAULT 900,
          enabled INTEGER NOT NULL DEFAULT 1,
          ingest_token_hash TEXT NOT NULL,
          last_reported_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS external_job_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id INTEGER NOT NULL REFERENCES external_jobs(id) ON DELETE CASCADE,
          status TEXT NOT NULL,
          exit_code INTEGER,
          duration_seconds INTEGER,
          message TEXT,
          reported_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_external_job_runs_job_reported
          ON external_job_runs(job_id, reported_at);
        CREATE INDEX IF NOT EXISTS idx_external_job_runs_reported
          ON external_job_runs(reported_at);
      `);
      console.log('[migration-29] Added external job heartbeat tables');
    }
  },
  {
    version: 30,
    description: 'Persist notifiable events so the UI has a history, not just a live feed',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL,
          category TEXT NOT NULL,
          severity TEXT NOT NULL,
          subject TEXT,
          title TEXT NOT NULL,
          body TEXT,
          detail TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
        CREATE INDEX IF NOT EXISTS idx_events_severity_created ON events(severity, created_at);
        CREATE INDEX IF NOT EXISTS idx_events_category_created ON events(category, created_at);
      `);
      console.log('[migration-30] Added event history table');
    }
  },
  {
    version: 31,
    description: 'Let a heartbeat carry the identity of the message that delivered it',
    up(db) {
      // ALTER TABLE ADD COLUMN is metadata-only in SQLite, so this stays bounded
      // however much run history is retained.
      const columns = db.prepare('PRAGMA table_info(external_job_runs)').all().map(column => column.name);
      if (!columns.includes('source_ref')) {
        db.exec('ALTER TABLE external_job_runs ADD COLUMN source_ref TEXT');
      }
      // Partial index: heartbeats delivered over HTTP leave source_ref NULL and
      // are unaffected, while a relayed message can only ever be recorded once.
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_external_job_runs_source_ref
          ON external_job_runs(source_ref) WHERE source_ref IS NOT NULL;
      `);
      console.log('[migration-31] Added relayed heartbeat de-duplication');
    }
  },
  {
    version: 32,
    description: 'Let a media import source be a folder rather than only a removable drive',
    up(db) {
      const columns = db.prepare('PRAGMA table_info(media_drives)').all().map(column => column.name);
      // Existing rows are all removable drives read as plain folders, so both
      // defaults describe what the table already held.
      if (!columns.includes('source_kind')) {
        db.exec("ALTER TABLE media_drives ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'drive'");
      }
      if (!columns.includes('import_mode')) {
        db.exec("ALTER TABLE media_drives ADD COLUMN import_mode TEXT NOT NULL DEFAULT 'folder'");
      }
      console.log('[migration-32] Added folder-backed media import sources');
    }
  },
];

// Derived rather than declared: a copy of this number kept somewhere else only
// tells you what the schema was when someone last remembered to update it.
export const LATEST_SCHEMA_VERSION = migrations[migrations.length - 1].version;

/**
 * Run all pending migrations in order.
 * Creates the schema_migrations tracking table if it doesn't exist.
 * Each migration runs inside a transaction for atomicity.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{ ran: number, current: number }} Number of migrations executed and current version
 */
export function runMigrations(db) {
  // Create tracking table
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Determine current version
  const latest = db.prepare('SELECT MAX(version) as v FROM schema_migrations').get();
  const currentVersion = latest?.v ?? -1;

  // Run pending migrations
  let ran = 0;
  for (const migration of migrations) {
    if (migration.version <= currentVersion) continue;

    const preflight = assertMigrationWorkloadBounded(db, migration.version);
    if (Object.keys(preflight.tableMaxRowIds).length > 0) {
      console.log(`[migration-${migration.version}] Preflight: ${JSON.stringify(preflight.tableMaxRowIds)}`);
    }
    console.log(`[migration-${migration.version}] Running: ${migration.description}`);
    const tx = db.transaction(() => {
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
        .run(migration.version, migration.description);
    });
    tx();
    ran++;
    console.log(`[migration-${migration.version}] ✅ Complete`);
  }

  const newVersion = migrations.length > 0 ? migrations[migrations.length - 1].version : currentVersion;

  if (ran > 0) {
    console.log(`[migrations] Ran ${ran} migration(s). Schema now at version ${newVersion}`);
  }

  return { ran, current: Math.max(currentVersion, newVersion) };
}

/**
 * Get the current schema version without running anything.
 * @param {import('better-sqlite3').Database} db
 * @returns {number}
 */
export function getSchemaVersion(db) {
  try {
    const row = db.prepare('SELECT MAX(version) as v FROM schema_migrations').get();
    return row?.v || 0;
  } catch {
    return 0; // Table doesn't exist yet
  }
}

/**
 * Validate that all expected migrations have been applied.
 * Returns a list of missing migrations (useful for diagnostics).
 * @param {import('better-sqlite3').Database} db
 * @returns {{ ok: boolean, missing: number[], applied: number[] }}
 */
export function validateMigrations(db) {
  try {
    const applied = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(r => r.version);
    const expected = migrations.map(m => m.version);
    const missing = expected.filter(v => !applied.includes(v));
    return { ok: missing.length === 0, missing, applied };
  } catch {
    return { ok: migrations.length === 0, missing: migrations.map(m => m.version), applied: [] };
  }
}

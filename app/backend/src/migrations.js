// RedMan — Formal Migration System
// Tracks schema version and runs numbered migrations in order.
// Migrations are additive-only: new columns, new tables, new indexes.
// Removing columns or tables requires a major version bump + contract update.
//
// Usage: import and call runMigrations(db) during startup in db.js

// Each migration has a version number, description, and up() function.
// Migrations MUST be idempotent — they run table/column existence checks internally.
// Once a migration is released, it must NEVER be modified.
const migrations = [
  // ── v1.0.0 baseline ──
  // All tables created in seed.js / db.js inline migrations.
  // No formal migrations needed for the initial schema.

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
];

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
  const currentVersion = latest?.v || 0;

  // Run pending migrations
  let ran = 0;
  for (const migration of migrations) {
    if (migration.version <= currentVersion) continue;

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

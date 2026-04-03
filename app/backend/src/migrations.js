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

  // ── Template for future migrations ──
  // {
  //   version: 2,
  //   description: 'Add xyz column to abc table',
  //   up(db) {
  //     const cols = db.prepare("PRAGMA table_info(abc)").all();
  //     if (!cols.find(c => c.name === 'xyz')) {
  //       db.exec(`ALTER TABLE abc ADD COLUMN xyz TEXT`);
  //       console.log('[migration-2] Added xyz column to abc');
  //     }
  //   }
  // },
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

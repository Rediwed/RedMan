import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runMigrations, getSchemaVersion } from '../app/backend/src/migrations.js';

const require = createRequire(resolve(import.meta.dirname, '../app/package.json'));
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec(`
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT);
  INSERT INTO settings (key, value) VALUES ('peer_api_key', 'legacy-peer-key');
  INSERT INTO settings (key, value) VALUES ('ntfy_url', 'https://notify.example.test');
  INSERT INTO settings (key, value) VALUES ('ntfy_token', 'legacy-notify-token');
  CREATE TABLE ssd_backup_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    source_path TEXT NOT NULL,
    dest_path TEXT NOT NULL
  );
  INSERT INTO ssd_backup_configs (name, source_path, dest_path) VALUES ('Legacy', '/source', '/dest');
  CREATE TABLE authorized_peers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    api_key TEXT NOT NULL UNIQUE,
    allowed_path_prefix TEXT NOT NULL DEFAULT '/',
    storage_limit_bytes INTEGER NOT NULL DEFAULT 0,
    static_pubkey TEXT,
    enabled INTEGER NOT NULL DEFAULT 1
  );
  INSERT INTO authorized_peers
    (name, api_key, allowed_path_prefix, storage_limit_bytes, static_pubkey)
  VALUES ('Paired without SSH key', 'paired-without-ssh', '/mnt/user/backups/peer', 1000000, 'static-pubkey');
  CREATE TABLE backup_run_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    file_path TEXT NOT NULL,
    action TEXT NOT NULL
  );
`);

runMigrations(db);
assert.equal(getSchemaVersion(db), 28);
const ssdColumns = new Set(db.prepare('PRAGMA table_info(ssd_backup_configs)').all().map(column => column.name));
for (const column of ['retention_days', 'delta_versioning', 'delta_threshold', 'delta_max_chain', 'delta_keyframe_days', 'retention_policy']) {
  assert.ok(ssdColumns.has(column), `Missing legacy SSD column ${column}`);
}
const runColumns = new Set(db.prepare('PRAGMA table_info(backup_runs)').all().map(column => column.name));
assert.ok(runColumns.has('db_backup_status'), 'Missing database backup verification column');
assert.equal(db.prepare("SELECT storage_limit_bytes FROM authorized_peers WHERE api_key = 'legacy-peer-key'").get().storage_limit_bytes, 0);
assert.equal(db.prepare("SELECT enabled FROM authorized_peers WHERE api_key = 'legacy-peer-key'").get().enabled, 0);
assert.equal(db.prepare("SELECT enabled FROM authorized_peers WHERE api_key = 'paired-without-ssh'").get().enabled, 0);
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM settings WHERE key = 'peer_api_key'").get().count, 0);
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM authorized_peers WHERE api_key = 'legacy-peer-key'").get().count, 1);
assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'ntfy_server'").get().value, 'https://notify.example.test');
assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'ntfy_auth_token'").get().value, 'legacy-notify-token');
assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'ntfy_auth_type'").get().value, 'token');
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM settings WHERE key IN ('ntfy_url', 'ntfy_token')").get().count, 0);
assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_backup_run_files_run'").get());
assert.doesNotThrow(() => JSON.parse(db.prepare('SELECT retention_policy FROM ssd_backup_configs WHERE id = 1').get().retention_policy));
db.close();
console.log('Legacy schema migration: inline repairs consolidated in migration 23');
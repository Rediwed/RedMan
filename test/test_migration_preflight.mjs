import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import {
  STARTUP_MIGRATION_MIN_FREE_BYTES,
  STARTUP_MIGRATION_ROW_LIMITS,
  assertMigrationWorkloadBounded,
} from '../app/backend/src/migrations.js';

const require = createRequire(resolve(import.meta.dirname, '../app/package.json'));
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec(`
  CREATE TABLE backup_runs (id INTEGER PRIMARY KEY);
  CREATE TABLE hyper_backup_jobs (id INTEGER PRIMARY KEY);
  CREATE TABLE peer_audit_log (id INTEGER PRIMARY KEY);
  CREATE TABLE auth_sessions (id INTEGER PRIMARY KEY);
  CREATE TABLE auth_recovery_events (id INTEGER PRIMARY KEY);
  INSERT INTO backup_runs VALUES (1);
`);

assert.deepEqual(assertMigrationWorkloadBounded(db, 14).tableMaxRowIds, {
  backup_runs: 1,
  hyper_backup_jobs: 0,
});
db.prepare('INSERT INTO backup_runs VALUES (?)').run(STARTUP_MIGRATION_ROW_LIMITS.history + 1);
assert.throws(() => assertMigrationWorkloadBounded(db, 14), /controlled offline migration/);
db.prepare('DELETE FROM backup_runs WHERE id > 1').run();
db.exec('CREATE TABLE container_metrics (id INTEGER PRIMARY KEY); INSERT INTO container_metrics VALUES (1000000001);');
assert.throws(
  () => assertMigrationWorkloadBounded(db, 0, { availableBytes: STARTUP_MIGRATION_MIN_FREE_BYTES }),
  /container_metrics rowid.*controlled offline migration/,
);
db.prepare('DELETE FROM container_metrics').run();
db.prepare('INSERT INTO backup_runs VALUES (?)').run(STARTUP_MIGRATION_ROW_LIMITS.files + 1);
db.exec(`
  CREATE TABLE backup_run_files (id INTEGER PRIMARY KEY, run_id INTEGER);
  INSERT INTO backup_run_files VALUES (1000001, 1);
`);
assert.throws(
  () => assertMigrationWorkloadBounded(db, 23, { availableBytes: STARTUP_MIGRATION_MIN_FREE_BYTES }),
  /backup_run_files rowid.*controlled offline migration/,
);
db.exec('CREATE INDEX idx_backup_run_files_run ON backup_run_files(run_id)');
assert.doesNotThrow(
  () => assertMigrationWorkloadBounded(db, 23, { availableBytes: STARTUP_MIGRATION_MIN_FREE_BYTES }),
);
db.prepare('DELETE FROM backup_runs WHERE id > 1').run();
assert.throws(
  () => assertMigrationWorkloadBounded(db, 26, { availableBytes: STARTUP_MIGRATION_MIN_FREE_BYTES - 1 }),
  /at least 1 GiB free/,
);
assert.doesNotThrow(() => assertMigrationWorkloadBounded(db, 26, { availableBytes: STARTUP_MIGRATION_MIN_FREE_BYTES }));
assert.throws(
  () => assertMigrationWorkloadBounded(db, 12, { availableBytes: 0 }),
  /at least 1 GiB free/,
);
assert.deepEqual(
  assertMigrationWorkloadBounded(db, 12, { availableBytes: STARTUP_MIGRATION_MIN_FREE_BYTES }),
  { tableMaxRowIds: {}, availableBytes: STARTUP_MIGRATION_MIN_FREE_BYTES },
);

db.close();
console.log('Migration preflight: cheap rowid caps and free-space floor fail closed before startup work');
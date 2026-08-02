import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import {
  pruneDatabaseTelemetry,
  runDatabaseRetentionBatches,
} from '../app/backend/src/services/databaseRetention.js';

const require = createRequire(resolve(import.meta.dirname, '../app/package.json'));
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE ssd_backup_configs (id INTEGER PRIMARY KEY);
  CREATE TABLE backup_runs (
    id INTEGER PRIMARY KEY, status TEXT, started_at TEXT, completed_at TEXT
  );
  CREATE TABLE backup_run_files (
    id INTEGER PRIMARY KEY, run_id INTEGER REFERENCES backup_runs(id) ON DELETE CASCADE
  );
  CREATE TABLE peer_audit_log (
    id INTEGER PRIMARY KEY, action TEXT, created_at TEXT
  );
  CREATE TABLE container_metrics (id INTEGER PRIMARY KEY, recorded_at TEXT);
  CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE auth_audit_log (id INTEGER PRIMARY KEY, created_at TEXT);
  CREATE TABLE auth_sessions (id INTEGER PRIMARY KEY, revoked_at TEXT, absolute_expires_at TEXT);
  CREATE TABLE auth_recovery_events (id INTEGER PRIMARY KEY, status TEXT, expires_at TEXT, created_at TEXT);
  CREATE TABLE pairing_requests (
    id INTEGER PRIMARY KEY, direction TEXT, status TEXT, error TEXT,
    expires_at TEXT, updated_at TEXT
  );
  CREATE TABLE external_jobs (id INTEGER PRIMARY KEY);
  CREATE TABLE external_job_runs (
    id INTEGER PRIMARY KEY,
    job_id INTEGER REFERENCES external_jobs(id) ON DELETE CASCADE,
    reported_at TEXT
  );

  INSERT INTO backup_runs VALUES (1, 'completed', datetime('now', '-400 days'), datetime('now', '-400 days'));
  INSERT INTO backup_runs VALUES (2, 'completed', datetime('now', '-10 days'), datetime('now', '-10 days'));
  INSERT INTO backup_run_files VALUES (1, 1);
  INSERT INTO backup_run_files VALUES (2, 2);
  INSERT INTO peer_audit_log VALUES (1, 'auth_success', datetime('now', '-31 days'));
  INSERT INTO peer_audit_log VALUES (2, 'auth_failure', datetime('now', '-31 days'));
  INSERT INTO peer_audit_log VALUES (3, 'auth_failure', datetime('now', '-366 days'));
  INSERT INTO container_metrics VALUES (1, datetime('now', '-25 hours'));
  INSERT INTO container_metrics VALUES (2, datetime('now', '-1 hour'));
  INSERT INTO cache VALUES ('version_stats:999', '{}');
  INSERT INTO auth_audit_log VALUES (1, datetime('now', '-366 days'));
  INSERT INTO auth_sessions VALUES (1, datetime('now', '-8 days'), datetime('now', '-9 days'));
  INSERT INTO auth_recovery_events VALUES (1, 'used', datetime('now', '-40 days'), datetime('now', '-40 days'));
  INSERT INTO pairing_requests VALUES (1, 'incoming', 'pending', NULL, datetime('now', '-1 minute'), datetime('now', '-1 minute'));
  INSERT INTO pairing_requests VALUES (2, 'incoming', 'expired', NULL, datetime('now', '-2 hours'), datetime('now', '-2 hours'));
  INSERT INTO external_jobs VALUES (1);
  INSERT INTO external_job_runs VALUES (1, 1, datetime('now', '-200 days'));
  INSERT INTO external_job_runs VALUES (2, 1, datetime('now', '-190 days'));
`);

const removed = pruneDatabaseTelemetry(db, {
  runFileDays: 30,
  runHistoryDays: 365,
  routineAuditDays: 30,
  securityAuditDays: 365,
  metricsHours: 24,
  authAuditDays: 365,
});

assert.deepEqual(removed, {
  runFiles: 1,
  runs: 1,
  routineAudit: 1,
  securityAudit: 1,
  metrics: 1,
  summaries: 1,
  authAudit: 1,
  authSessions: 1,
  authRecovery: 1,
  pairingExpired: 1,
  pairingHistory: 1,
  externalRuns: 1,
});
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM backup_runs').get().count, 1);
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM peer_audit_log').get().count, 1);
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM container_metrics').get().count, 1);
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM pairing_requests WHERE status = 'expired'").get().count, 1);
// The newest heartbeat per job always survives, so pruning can never make a
// reporting job look like it never checked in.
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM external_job_runs').get().count, 1);
assert.equal(db.prepare('SELECT MAX(id) AS id FROM external_job_runs').get().id, 2);

const insertRun = db.prepare("INSERT INTO backup_runs VALUES (?, 'completed', datetime('now', '-400 days'), datetime('now', '-400 days'))");
const insertFile = db.prepare('INSERT INTO backup_run_files VALUES (?, ?)');
const insertMetric = db.prepare("INSERT INTO container_metrics VALUES (?, datetime('now', '-25 hours'))");
for (let index = 10; index < 15; index += 1) {
  insertRun.run(index);
  insertFile.run(index, index);
  insertMetric.run(index);
}

const firstBatch = pruneDatabaseTelemetry(db, {
  runFileDays: 30,
  runHistoryDays: 365,
  routineAuditDays: 30,
  securityAuditDays: 365,
  metricsHours: 24,
  authAuditDays: 365,
}, { batchSize: 2 });
assert.equal(firstBatch.runFiles, 2);
assert.equal(firstBatch.runs, 2);
assert.equal(firstBatch.metrics, 2);
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM backup_run_files').get().count, 4);

const capped = await runDatabaseRetentionBatches(db, {}, {
  batchSize: 1,
  maxBatches: 1,
  yieldMs: 0,
});
assert.equal(capped.complete, false);
assert.equal(capped.batches, 1);
assert.ok(Object.values(capped.totals).every(count => count <= 1));

const timed = await runDatabaseRetentionBatches(db, {}, {
  batchSize: 1,
  maxBatches: 100,
  maxDurationMs: 1,
  yieldMs: 10,
});
assert.equal(timed.complete, false);
assert.equal(timed.timedOut, true);
assert.ok(timed.batches < 100);

const completed = await runDatabaseRetentionBatches(db, {}, {
  batchSize: 2,
  maxBatches: 10,
  yieldMs: 0,
});
assert.equal(completed.complete, true);
assert.ok(completed.batches >= 1);
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM backup_run_files').get().count, 1);
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM container_metrics').get().count, 1);

const schedulerSource = readFileSync(resolve(import.meta.dirname, '../app/backend/src/services/scheduler.js'), 'utf8');
const startRetention = schedulerSource.slice(
  schedulerSource.indexOf('export function startRunFileRetention'),
  schedulerSource.indexOf('export function stopRunFileRetention'),
);
assert.match(schedulerSource, /retentionTimer = setTimeout/);
assert.match(startRetention, /scheduleRetention\(RETENTION_START_DELAY_MS\)/);
assert.doesNotMatch(startRetention, /pruneDatabaseTelemetry\(db\)/);
assert.doesNotMatch(schedulerSource, /RETENTION_RETRY_MS/);
assert.match(schedulerSource, /RETENTION_RUN_FILE_BATCH_SIZE = 1_000/);
// A backlog re-runs sooner, but never faster than a 30s budget per 15 minutes,
// and a failed cycle still falls back to the full interval.
assert.match(schedulerSource, /RETENTION_BACKLOG_INTERVAL_MS = 15 \* 60 \* 1000/);
assert.match(schedulerSource, /scheduleRetention\(result\.complete \? RETENTION_INTERVAL_MS : RETENTION_BACKLOG_INTERVAL_MS\)/);
assert.match(schedulerSource, /scheduleRetention\(RETENTION_INTERVAL_MS\);\s*\}\);/);
assert.match(schedulerSource, /RETENTION_MAX_BATCHES = 25/);
assert.match(schedulerSource, /scheduleRetention\(RETENTION_INTERVAL_MS\)/);
const dockerSource = readFileSync(resolve(import.meta.dirname, '../app/backend/src/services/docker.js'), 'utf8');
assert.doesNotMatch(dockerSource, /DELETE FROM container_metrics/);
db.close();
console.log('Database retention: tiered bounded batches, resumability, and delayed startup passed');
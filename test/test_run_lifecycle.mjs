import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import {
  cancelFeatureRun,
  getRunDetail,
  getRunProgress,
  listFeatureRuns,
  normalizePagination,
  startClaimedRun,
} from '../app/backend/src/services/runLifecycle.js';

const require = createRequire(resolve(import.meta.dirname, '../app/package.json'));
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec(`
  CREATE TABLE backup_runs (
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
  CREATE TABLE backup_run_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    file_path TEXT NOT NULL,
    action TEXT NOT NULL
  );
`);

assert.deepEqual(normalizePagination({ page: '-2', limit: '999' }), { page: 1, limit: 100, offset: 0 });

const launches = [];
const first = startClaimedRun({
  db,
  feature: 'ssd-backup',
  configId: '7',
  execute: (configId, runId) => {
    launches.push({ configId, runId });
    return Promise.resolve();
  },
});
assert.equal(first.claimed, true);
assert.deepEqual(launches, [{ configId: 7, runId: first.runId }]);
const duplicate = startClaimedRun({
  db,
  feature: 'ssd-backup',
  configId: 7,
  execute: () => assert.fail('duplicate claim launched executor'),
});
assert.deepEqual(duplicate, { claimed: false, runId: first.runId });

const other = startClaimedRun({
  db,
  feature: 'rclone',
  configId: 7,
  execute: () => Promise.resolve(),
});
assert.equal(other.claimed, true);

db.prepare("UPDATE backup_runs SET status = 'completed' WHERE id = ?").run(first.runId);
db.prepare('INSERT INTO backup_run_files (run_id, file_path, action) VALUES (?, ?, ?)').run(first.runId, '/a.jpg', 'copied');
db.prepare('INSERT INTO backup_run_files (run_id, file_path, action) VALUES (?, ?, ?)').run(first.runId, '/b.jpg', 'error');

const pagination = normalizePagination({ page: '1', limit: '1' });
const listed = listFeatureRuns(db, { feature: 'ssd-backup', configId: 7, ...pagination });
assert.equal(listed.total, 1);
assert.equal(listed.runs[0].id, first.runId);
assert.equal(listed.totalPages, 1);

assert.equal(getRunProgress(db, 'hyper-backup', first.runId, () => null), null);
const progress = getRunProgress(db, 'ssd-backup', first.runId, id => ({ id, percent: 50 }));
assert.deepEqual(progress.liveProgress, { id: first.runId, percent: 50 });

const detail = getRunDetail(db, {
  feature: 'ssd-backup',
  runId: first.runId,
  query: { action: 'copied', fileLimit: '1' },
  getActiveRun: () => null,
  includeActionCounts: true,
});
assert.equal(detail.totalFiles, 1);
assert.equal(detail.files[0].file_path, '/a.jpg');
assert.deepEqual(detail.actionCounts, [{ action: 'copied', count: 1 }, { action: 'error', count: 1 }]);

const crossFeatureCancel = cancelFeatureRun(db, {
  feature: 'ssd-backup',
  runId: other.runId,
  cancelProcess: () => assert.fail('cross-feature cancellation reached process'),
});
assert.deepEqual(crossFeatureCancel, { ok: false, statusCode: 404, error: 'Run not found' });

const missingProcess = cancelFeatureRun(db, {
  feature: 'rclone',
  runId: other.runId,
  cancelProcess: () => false,
});
assert.equal(missingProcess.error, 'Could not cancel — process not found');
assert.equal(db.prepare('SELECT status FROM backup_runs WHERE id = ?').get(other.runId).status, 'running');

const cancelled = cancelFeatureRun(db, {
  feature: 'rclone',
  runId: other.runId,
  cancelProcess: () => true,
});
assert.equal(cancelled.ok, true);
assert.deepEqual(
  db.prepare('SELECT status, error_message FROM backup_runs WHERE id = ?').get(other.runId),
  { status: 'cancelled', error_message: 'Cancelled by user' },
);

db.close();
console.log('Run lifecycle: claims, ownership, pagination, progress, detail, and cancellation passed');
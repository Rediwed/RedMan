import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { getJobHealth } from '../app/backend/src/services/jobHealth.js';

const require = createRequire(resolve(import.meta.dirname, '../app/package.json'));
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec(`
  CREATE TABLE backup_runs (
    id INTEGER PRIMARY KEY, feature TEXT, config_id INTEGER, status TEXT,
    completed_at TEXT, files_copied INTEGER, files_failed INTEGER, error_message TEXT
  );
  CREATE TABLE restore_events (
    id INTEGER PRIMARY KEY, config_id INTEGER, snapshot_timestamp TEXT, file_path TEXT,
    restored_to TEXT, status TEXT, verified_at TEXT
  );
  INSERT INTO backup_runs VALUES (1, 'ssd-backup', 7, 'completed', '2026-07-15 10:00:00', 10, 0, NULL);
  INSERT INTO backup_runs VALUES (2, 'ssd-backup', 7, 'failed', '2026-07-16 10:00:00', 0, 1, 'disk full');
  INSERT INTO restore_events VALUES (3, 7, '2026-07-15T09-00-00', 'a.txt', '/source/a.txt', 'verified', '2026-07-16T12:00:00.000Z');
`);

const health = getJobHealth(db, {
  feature: 'ssd-backup', configId: 7, cronExpression: '0 * * * *', enabled: true,
  includeRestore: true, now: new Date('2026-07-17T12:00:00.000Z'),
});
assert.equal(health.state, 'attention');
assert.equal(health.stale, true);
assert.equal(health.lastSuccess.id, 1);
assert.equal(health.lastIssue.id, 2);
assert.equal(health.lastVerifiedRestore.id, 3);
assert.ok(health.nextRun);

const paused = getJobHealth(db, {
  feature: 'ssd-backup', configId: 7, cronExpression: '0 * * * *', enabled: false,
});
assert.equal(paused.state, 'paused');
assert.equal(paused.stale, false);
db.close();
console.log('Job health projection: success, issue, staleness, restore, and next run passed');
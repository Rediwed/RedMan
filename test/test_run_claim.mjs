import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { claimBackupRun } from '../app/backend/src/services/runClaim.js';

const require = createRequire(resolve(import.meta.dirname, '../app/package.json'));
const Database = require('better-sqlite3');
const db = new Database(':memory:');

db.exec(`
  CREATE TABLE backup_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feature TEXT NOT NULL,
    config_id INTEGER NOT NULL,
    peer_static_pubkey TEXT,
    status TEXT NOT NULL
  )
`);

const first = claimBackupRun(db, 'ssd-backup', 1);
assert.equal(first.claimed, true);

const duplicate = claimBackupRun(db, 'ssd-backup', '1');
assert.deepEqual(duplicate, { claimed: false, runId: first.runId });

const otherConfig = claimBackupRun(db, 'ssd-backup', 2);
assert.equal(otherConfig.claimed, true);

const otherFeature = claimBackupRun(db, 'rclone', 1);
assert.equal(otherFeature.claimed, true);

db.prepare("UPDATE backup_runs SET status = 'completed' WHERE id = ?").run(first.runId);
const afterCompletion = claimBackupRun(db, 'ssd-backup', 1);
assert.equal(afterCompletion.claimed, true);
assert.notEqual(afterCompletion.runId, first.runId);

db.close();
console.log('Transactional run claims: 5 cases passed');
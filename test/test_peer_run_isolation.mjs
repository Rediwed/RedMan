import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import {
  failRunningHyperRunsForPeer,
  getPeerOwnedHyperRun,
} from '../app/backend/src/services/peerRunIsolation.js';

const require = createRequire(resolve(import.meta.dirname, '../app/package.json'));
const Database = require('better-sqlite3');
const db = new Database(':memory:');

db.exec(`
  CREATE TABLE hyper_backup_jobs (
    id INTEGER PRIMARY KEY,
    peer_static_pubkey TEXT
  );
  CREATE TABLE backup_runs (
    id INTEGER PRIMARY KEY,
    feature TEXT NOT NULL,
    config_id INTEGER NOT NULL,
    peer_static_pubkey TEXT,
    status TEXT NOT NULL,
    completed_at TEXT,
    error_message TEXT
  );
  INSERT INTO hyper_backup_jobs VALUES (1, 'peer-a-key'), (2, 'peer-b-key'), (3, NULL);
  INSERT INTO backup_runs VALUES
    (1, 'hyper-backup', 1, 'peer-a-key', 'running', NULL, NULL),
    (2, 'hyper-backup', 2, 'peer-b-key', 'running', NULL, NULL),
    (3, 'hyper-backup', 3, NULL, 'running', NULL, NULL),
    (4, 'ssd-backup', 1, 'peer-a-key', 'running', NULL, NULL);
`);

  assert.equal(getPeerOwnedHyperRun(db, 1, 'peer-a-key')?.id, 1);
  assert.equal(getPeerOwnedHyperRun(db, 1, 'peer-b-key'), null);
  assert.equal(getPeerOwnedHyperRun(db, 4, 'peer-a-key'), null);
  assert.equal(getPeerOwnedHyperRun(db, 1, null), null);
assert.equal(failRunningHyperRunsForPeer(db, 'peer-a-key', 'Peer A'), 1);
assert.equal(db.prepare('SELECT status FROM backup_runs WHERE id = 1').get().status, 'failed');
assert.equal(db.prepare('SELECT status FROM backup_runs WHERE id = 2').get().status, 'running');
assert.equal(db.prepare('SELECT status FROM backup_runs WHERE id = 3').get().status, 'running');
assert.equal(db.prepare('SELECT status FROM backup_runs WHERE id = 4').get().status, 'running');
assert.equal(failRunningHyperRunsForPeer(db, null, 'Unknown'), 0);

db.close();
console.log('Peer shutdown run isolation: passed');
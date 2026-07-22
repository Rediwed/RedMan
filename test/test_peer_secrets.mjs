import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const fixture = resolve(import.meta.dirname, 'data', `peer-secrets-${process.pid}`);
mkdirSync(fixture, { recursive: true });
process.env.DB_PATH = resolve(fixture, 'redman.db');

const {
  assertPeerSecretMigrationBounded,
  decryptPeerApiKey,
  encryptPeerApiKey,
  hashPeerApiKey,
  migratePeerSecrets,
  PEER_SECRET_MIGRATION_MIN_FREE_BYTES,
} = await import('../app/backend/src/services/peerSecrets.js');
const require = createRequire(resolve(import.meta.dirname, '../app/package.json'));
const Database = require('better-sqlite3');
const db = new Database(':memory:');

db.exec(`
  CREATE TABLE authorized_peers (
    id INTEGER PRIMARY KEY, api_key TEXT NOT NULL UNIQUE, api_key_hash TEXT
  );
  CREATE TABLE pairing_requests (
    id INTEGER PRIMARY KEY, api_key TEXT, api_key_encrypted TEXT
  );
  CREATE TABLE hyper_backup_jobs (
    id INTEGER PRIMARY KEY, remote_api_key TEXT NOT NULL, remote_api_key_encrypted TEXT
  );
  INSERT INTO authorized_peers VALUES (1, 'incoming-plaintext', NULL);
  INSERT INTO pairing_requests VALUES (1, 'outgoing-plaintext', NULL);
  INSERT INTO hyper_backup_jobs VALUES (1, 'job-plaintext', NULL);
`);

try {
  const encrypted = encryptPeerApiKey('round-trip-secret');
  assert.equal(decryptPeerApiKey(encrypted), 'round-trip-secret');
  assert.notEqual(encrypted, 'round-trip-secret');

  migratePeerSecrets(db);
  const incoming = db.prepare('SELECT * FROM authorized_peers WHERE id = 1').get();
  assert.equal(incoming.api_key_hash, hashPeerApiKey('incoming-plaintext'));
  assert.equal(incoming.api_key.includes('incoming-plaintext'), false);

  const pairing = db.prepare('SELECT * FROM pairing_requests WHERE id = 1').get();
  assert.equal(pairing.api_key, null);
  assert.equal(decryptPeerApiKey(pairing.api_key_encrypted), 'outgoing-plaintext');

  const job = db.prepare('SELECT * FROM hyper_backup_jobs WHERE id = 1').get();
  assert.equal(job.remote_api_key, 'encrypted:v1');
  assert.equal(decryptPeerApiKey(job.remote_api_key_encrypted), 'job-plaintext');

  migratePeerSecrets(db);
  assert.equal(decryptPeerApiKey(db.prepare('SELECT api_key_encrypted FROM pairing_requests').pluck().get()), 'outgoing-plaintext');
  db.prepare("INSERT INTO authorized_peers VALUES (2, 'second-plaintext', NULL)").run();
  db.prepare("INSERT INTO authorized_peers VALUES (3, 'third-plaintext', NULL)").run();
  assert.throws(() => assertPeerSecretMigrationBounded(db, { maxRows: 1 }), /controlled offline migration/);
  assert.throws(() => migratePeerSecrets(db, { maxRows: 1 }), /controlled offline migration/);
  assert.throws(
    () => assertPeerSecretMigrationBounded(db, { availableBytes: PEER_SECRET_MIGRATION_MIN_FREE_BYTES - 1 }),
    /at least 1 GiB free/,
  );
  db.prepare('DELETE FROM authorized_peers WHERE id IN (2, 3)').run();
  console.log('Peer secret hashing, encryption, and idempotent migration: passed');
} finally {
  db.close();
  rmSync(fixture, { recursive: true, force: true });
}
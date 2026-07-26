import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import {
  findPairingByStaticKey,
  findPairingByUrl,
  resolvePeerBinding,
  syncJobRemoteUrl,
} from '../app/backend/src/services/peerBinding.js';

const require = createRequire(resolve(import.meta.dirname, '../app/package.json'));
const Database = require('better-sqlite3');
const db = new Database(':memory:');

db.exec(`
  CREATE TABLE pairing_requests (
    id INTEGER PRIMARY KEY,
    direction TEXT NOT NULL,
    status TEXT NOT NULL,
    remote_instance TEXT,
    remote_url TEXT,
    remote_static_pubkey TEXT,
    api_key_encrypted TEXT
  );
  CREATE TABLE hyper_backup_jobs (
    id INTEGER PRIMARY KEY,
    remote_url TEXT,
    peer_static_pubkey TEXT,
    remote_api_key_encrypted TEXT,
    updated_at TEXT
  );
  INSERT INTO pairing_requests VALUES
    (1, 'outgoing', 'accepted', 'Peer A', 'http://10.10.0.2:8091', 'peer-a-identity', 'enc:old-key'),
    (2, 'outgoing', 'accepted', 'Peer A', 'http://10.10.0.9:8091', 'peer-a-identity', 'enc:new-key'),
    (3, 'outgoing', 'accepted', 'Rebuilt', 'http://10.10.0.2:8091', 'other-identity', 'enc:other-key'),
    (4, 'outgoing', 'pending',  'Later',   'http://10.10.0.3:8091', 'later-identity', 'enc:pending'),
    (5, 'incoming', 'accepted', 'Inbound', 'http://10.10.0.4:8091', 'inbound-identity', 'enc:inbound');
`);

// Only accepted outgoing pairings with a stored credential are candidates
assert.equal(findPairingByStaticKey(db, 'later-identity'), null);
assert.equal(findPairingByStaticKey(db, 'inbound-identity'), null);
assert.equal(findPairingByStaticKey(db, null), null);
assert.equal(findPairingByUrl(db, null), null);

// The newest accepted pairing for an identity wins, even after the peer moved
assert.equal(findPairingByStaticKey(db, 'peer-a-identity').id, 2);
assert.equal(findPairingByUrl(db, 'http://10.10.0.2:8091').id, 3);

// Re-pairing rotates the key and may move the peer: the job follows both
const rePaired = resolvePeerBinding(db, {
  id: 1, remote_url: 'http://10.10.0.2:8091',
  peer_static_pubkey: 'peer-a-identity', remote_api_key_encrypted: 'enc:stale-job-key',
});
assert.equal(rePaired.source, 'identity');
assert.equal(rePaired.apiKeyEncrypted, 'enc:new-key');
assert.equal(rePaired.remoteUrl, 'http://10.10.0.9:8091');
assert.equal(rePaired.peerName, 'Peer A');

// A job bound to an identity never adopts a different peer answering on the
// same address — it keeps its own credential instead
const strangerAtSameUrl = resolvePeerBinding(db, {
  id: 2, remote_url: 'http://10.10.0.2:8091',
  peer_static_pubkey: 'unpaired-identity', remote_api_key_encrypted: 'enc:job-key',
});
assert.equal(strangerAtSameUrl.source, 'job');
assert.equal(strangerAtSameUrl.apiKeyEncrypted, 'enc:job-key');
assert.equal(strangerAtSameUrl.remoteUrl, 'http://10.10.0.2:8091');

// Legacy jobs without an identity still resolve by address
const legacy = resolvePeerBinding(db, {
  id: 3, remote_url: 'http://10.10.0.2:8091',
  peer_static_pubkey: null, remote_api_key_encrypted: 'enc:job-key',
});
assert.equal(legacy.source, 'url');
assert.equal(legacy.apiKeyEncrypted, 'enc:other-key');

// Manually configured destinations keep using their own credential
const manual = resolvePeerBinding(db, {
  id: 4, remote_url: 'http://10.10.0.50:8091',
  peer_static_pubkey: null, remote_api_key_encrypted: 'enc:manual-key',
});
assert.equal(manual.source, 'job');
assert.equal(manual.remoteUrl, 'http://10.10.0.50:8091');

// Nothing to resolve at all is an explicit, actionable failure
assert.throws(() => resolvePeerBinding(db, {
  id: 5, remote_url: 'http://10.10.0.50:8091',
  peer_static_pubkey: 'gone-identity', remote_api_key_encrypted: null,
}), /no longer paired/);
assert.throws(() => resolvePeerBinding(db, {
  id: 6, remote_url: 'http://10.10.0.50:8091',
  peer_static_pubkey: null, remote_api_key_encrypted: null,
}), /credential is unavailable/);

// The cached address follows the pairing so the SSH host fallback stays correct
db.prepare('INSERT INTO hyper_backup_jobs VALUES (1, ?, ?, ?, NULL)')
  .run('http://10.10.0.2:8091', 'peer-a-identity', 'enc:stale-job-key');
const job = db.prepare('SELECT * FROM hyper_backup_jobs WHERE id = 1').get();
assert.equal(syncJobRemoteUrl(db, job, 'http://10.10.0.9:8091'), true);
assert.equal(job.remote_url, 'http://10.10.0.9:8091');
assert.equal(db.prepare('SELECT remote_url FROM hyper_backup_jobs WHERE id = 1').get().remote_url,
  'http://10.10.0.9:8091');
assert.equal(syncJobRemoteUrl(db, job, 'http://10.10.0.9:8091'), false);
assert.equal(syncJobRemoteUrl(db, job, null), false);

db.close();
console.log('Peer binding resolution: passed');

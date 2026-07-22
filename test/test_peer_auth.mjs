import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { peerAuth } from '../app/backend/src/middleware/auth.js';
import { hashPeerApiKey, hashedPeerKeyMarker } from '../app/backend/src/services/peerSecrets.js';

const require = createRequire(resolve(import.meta.dirname, '../app/package.json'));
const Database = require('better-sqlite3');
const db = new Database(':memory:');

db.exec(`
  CREATE TABLE authorized_peers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    api_key TEXT NOT NULL UNIQUE,
    api_key_hash TEXT,
    allowed_path_prefix TEXT NOT NULL,
    storage_limit_bytes INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_seen_at TEXT,
    last_seen_ip TEXT
  );
  CREATE TABLE peer_audit_log (
    id INTEGER PRIMARY KEY,
    peer_id INTEGER,
    peer_name TEXT,
    action TEXT NOT NULL,
    details TEXT,
    ip_address TEXT
  );
`);

const apiKeyHash = hashPeerApiKey('quota-key');
db.prepare(`
  INSERT INTO authorized_peers (id, name, api_key, api_key_hash, allowed_path_prefix, storage_limit_bytes)
  VALUES (1, 'quota-peer', ?, ?, '/backups/quota-peer', 1048576)
`).run(hashedPeerKeyMarker(apiKeyHash), apiKeyHash);

const req = {
  headers: { authorization: 'Bearer quota-key' },
  socket: { remoteAddress: '127.0.0.1' },
};
const res = {
  statusCode: null,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  },
};
let nextCalled = false;
const authenticate = peerAuth(db);

authenticate(req, res, () => {
  nextCalled = true;
});

assert.equal(nextCalled, true);
assert.equal(req.peer.id, 1);
assert.equal(req.peer.allowed_path_prefix, '/backups/quota-peer');
assert.equal(req.peer.storage_limit_bytes, 1048576);
assert.equal(res.statusCode, null);

authenticate(req, res, () => {});
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM peer_audit_log WHERE action = 'auth_success'").get().count, 1);

db.close();
console.log('Peer auth quota projection: passed');
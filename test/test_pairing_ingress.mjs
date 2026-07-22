import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  MAX_ACTIVE_INCOMING_PAIRINGS,
  MAX_INCOMING_PAIRING_ROWS,
  storeIncomingPairingRequest,
} from '../app/backend/src/services/pairingIngress.js';

const require = createRequire(resolve(import.meta.dirname, '../app/package.json'));
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec(`
  CREATE TABLE pairing_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    direction TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    remote_instance TEXT,
    remote_url TEXT,
    remote_ssh_pubkey TEXT,
    status TEXT NOT NULL,
    handshake_version INTEGER,
    remote_ephemeral_pubkey TEXT,
    remote_static_pubkey TEXT,
    remote_fingerprint TEXT,
    expires_at TEXT DEFAULT (datetime('now', '+10 minutes'))
  );
`);

const request = index => ({
  token: index.toString(16).padStart(64, '0'),
  instance: `Peer ${index}`,
  callbackUrl: 'http://192.168.1.20:8091',
  sshPublicKey: 'ssh-ed25519 dGVzdA== redman@test',
  handshakeVersion: 3,
  ephemeralPublicKey: 'A'.repeat(44),
  staticPublicKey: 'B'.repeat(44),
  fingerprint: 'AAAA:BBBB:CCCC:DDDD',
});

for (let index = 1; index <= MAX_ACTIVE_INCOMING_PAIRINGS; index += 1) {
  assert.equal(storeIncomingPairingRequest(db, request(index)).ok, true);
}
const activeRejected = storeIncomingPairingRequest(db, request(MAX_ACTIVE_INCOMING_PAIRINGS + 1));
assert.equal(activeRejected.status, 429);

db.prepare("UPDATE pairing_requests SET expires_at = datetime('now', '-1 minute')").run();
assert.equal(storeIncomingPairingRequest(db, request(MAX_ACTIVE_INCOMING_PAIRINGS + 1)).ok, true);
db.prepare("UPDATE pairing_requests SET expires_at = datetime('now', '-1 minute')").run();
for (let index = MAX_ACTIVE_INCOMING_PAIRINGS + 2; index <= MAX_INCOMING_PAIRING_ROWS; index += 1) {
  assert.equal(storeIncomingPairingRequest(db, request(index)).ok, true);
  db.prepare("UPDATE pairing_requests SET expires_at = datetime('now', '-1 minute') WHERE token = ?")
    .run(request(index).token);
}
const totalRejected = storeIncomingPairingRequest(db, request(MAX_INCOMING_PAIRING_ROWS + 1));
assert.equal(totalRejected.status, 503);
assert.equal(storeIncomingPairingRequest(db, request(1)).status, 409);

const pairingSource = readFileSync(resolve(import.meta.dirname, '../app/backend/src/services/pairing.js'), 'utf8');
const pendingSection = pairingSource.slice(pairingSource.indexOf('export function getPendingIncoming'), pairingSource.indexOf('export function getAllPairingRequests'));
assert.doesNotMatch(pendingSection, /UPDATE pairing_requests/);
assert.match(pendingSection, /expires_at >= datetime\('now'\)/);
const outgoingStatusSection = pairingSource.slice(pairingSource.indexOf('export function getOutgoingPairingStatus'), pairingSource.indexOf('export function handlePairingCallback'));
assert.doesNotMatch(outgoingStatusSection, /UPDATE pairing_requests/);
const callbackExpirySection = pairingSource.slice(pairingSource.indexOf('export function handlePairingCallback'), pairingSource.indexOf('// ── Receiver side'));
assert.doesNotMatch(callbackExpirySection.slice(0, callbackExpirySection.indexOf('// Recover our ephemeral secret key')), /UPDATE pairing_requests/);
const peerApiSource = readFileSync(resolve(import.meta.dirname, '../app/backend/src/peerApi.js'), 'utf8');
assert.match(peerApiSource, /express\.json\(\{ limit: '32kb', strict: true \}\)/);
assert.match(peerApiSource, /windowMs: 10 \* 60 \* 1000/);
assert.match(peerApiSource, /max: 30/);

db.close();
console.log('Pairing ingress: active/total caps, read-only pending view, body limit, and dedicated rate limit passed');
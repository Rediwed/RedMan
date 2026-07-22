import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import {
  assertFingerprintConfirmed,
  findExistingPeer,
  isPairingExpired,
} from '../app/backend/src/services/pairingState.js';

assert.equal(isPairingExpired('2026-01-01 00:00:00', new Date('2026-01-01T00:00:01Z')), true);
assert.equal(isPairingExpired('2026-01-01 00:00:02', new Date('2026-01-01T00:00:01Z')), false);

const require = createRequire(resolve(import.meta.dirname, '../app/package.json'));
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec(`
  CREATE TABLE authorized_peers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    static_pubkey TEXT
  );
  INSERT INTO authorized_peers VALUES
    (1, 'RedMan', 'peer-a-key'),
    (2, 'RedMan', 'peer-b-key'),
    (3, 'Legacy RedMan', NULL);
`);

assert.equal(findExistingPeer(db, 'peer-a-key', 'RedMan').id, 1);
assert.equal(findExistingPeer(db, 'peer-b-key', 'RedMan').id, 2);
assert.equal(findExistingPeer(db, 'new-key', 'RedMan'), null);
assert.equal(findExistingPeer(db, 'new-key', 'Legacy RedMan').id, 3);
assert.equal(assertFingerprintConfirmed('ABCD:1234:EF56:7890', 'abcd 1234 ef56 7890'), true);
assert.throws(() => assertFingerprintConfirmed('ABCD:1234:EF56:7890', 'ABCD:1234:EF56:0000'), /does not match/);

db.close();
console.log('Pairing state, identity, and fingerprint confirmation: 8 cases passed');
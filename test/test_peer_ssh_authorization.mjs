import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { reconcilePeerSshAuthorization, reconcilePeerSshAuthorizationsAtStartup } from '../app/backend/src/services/peerSshAuthorization.js';

const key = `ssh-ed25519 ${Buffer.from('peer-ssh-key').toString('base64')} peer@test`;
const peer = { ssh_public_key: key };
const calls = [];
const actions = {
  replaceKeyAuthorization(previous, next, restriction) {
    calls.push({ action: 'replace', previous, next, restriction });
    return { restricted: true };
  },
  revokeKey(publicKey) {
    calls.push({ action: 'revoke', publicKey });
    return { revoked: true };
  },
};

assert.deepEqual(reconcilePeerSshAuthorization({}, { enabled: false }, actions), { managed: false, external: true });
assert.throws(() => reconcilePeerSshAuthorization({ static_pubkey: 'paired' }, { enabled: true }, actions), /re-pair/);
assert.equal(reconcilePeerSshAuthorization(peer, {
  enabled: true,
  allowedPathPrefix: '/mnt/user/backups/peer',
  sourceIp: '100.90.128.2',
}, actions).restricted, true);
assert.deepEqual(calls[0], {
  action: 'replace',
  previous: key,
  next: key,
  restriction: { allowedPathPrefix: '/mnt/user/backups/peer', sourceIp: '100.90.128.2' },
});
assert.equal(reconcilePeerSshAuthorization(peer, { enabled: false }, actions).revoked, true);
assert.deepEqual(calls[1], { action: 'revoke', publicKey: key });
assert.throws(() => reconcilePeerSshAuthorization(peer, { enabled: false }, {
  revokeKey() { throw new Error('host file read-only'); },
}), /host file read-only/);

const require = createRequire(resolve(import.meta.dirname, '../app/package.json'));
const Database = require('better-sqlite3');
const database = new Database(':memory:');
database.exec(`
  CREATE TABLE authorized_peers (
    id INTEGER PRIMARY KEY, static_pubkey TEXT, ssh_public_key TEXT,
    allowed_path_prefix TEXT, storage_limit_bytes INTEGER,
    last_seen_ip TEXT, enabled INTEGER, updated_at TEXT
  );
`);
const insert = database.prepare('INSERT INTO authorized_peers VALUES (?, ?, ?, ?, ?, ?, 1, NULL)');
insert.run(1, 'paired', key, '/mnt/user/backups/peer', 1024, '100.90.128.2');
insert.run(2, 'paired-no-key', null, '/mnt/user/backups/peer', 1024, null);
insert.run(3, 'unsafe-root', key, '/', 1024, null);
insert.run(4, null, null, '/mnt/user/manual', 1024, null);
const startupCalls = [];
const startup = reconcilePeerSshAuthorizationsAtStartup(database, {
  replaceKeyAuthorization(previous, next, restriction) {
    startupCalls.push({ previous, next, restriction });
    return { hostManaged: true };
  },
});
assert.deepEqual(startup, { scanned: 4, managed: 1, disabled: 2 });
assert.equal(startupCalls.length, 1);
assert.deepEqual(
  database.prepare('SELECT id, enabled FROM authorized_peers ORDER BY id').all(),
  [{ id: 1, enabled: 1 }, { id: 2, enabled: 0 }, { id: 3, enabled: 0 }, { id: 4, enabled: 1 }],
);
database.close();

console.log('Peer SSH authorization: scope replacement, disable/delete revocation, and fail-closed errors passed');
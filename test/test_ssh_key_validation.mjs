import assert from 'node:assert/strict';
import {
  buildRestrictedAuthorizedKey,
  normalizeSshPublicKey,
  removeAuthorizedKeyContent,
  toRrsyncPath,
  upsertAuthorizedKeyContent,
} from '../app/backend/src/services/sshKeyValidation.js';

const encodedKey = Buffer.from('redman-ed25519-test-key').toString('base64');
const validKey = `ssh-ed25519 ${encodedKey} redman@test`;

assert.equal(normalizeSshPublicKey(`  ${validKey}  `), validKey);
assert.throws(
  () => normalizeSshPublicKey(`${validKey}\nssh-ed25519 ${encodedKey} attacker@test`),
  /exactly one line/,
);
assert.throws(() => normalizeSshPublicKey('ssh-rsa AAAA attacker@test'), /valid Ed25519/);
assert.throws(() => normalizeSshPublicKey('ssh-ed25519 not_base64!'), /valid Ed25519/);
assert.throws(() => normalizeSshPublicKey(''), /Empty public key/);

const restricted = buildRestrictedAuthorizedKey(validKey, '/mnt/user/backups/Peer A', '100.90.128.2');
assert.match(restricted, /^restrict,from="100\.90\.128\.2",command="\/usr\/bin\/rrsync '\/mnt\/user\/backups\/Peer A'" ssh-ed25519 /);
assert.throws(() => buildRestrictedAuthorizedKey(validKey, '/', '100.90.128.2'), /non-root/);
assert.throws(() => buildRestrictedAuthorizedKey(validKey, '/mnt/user/backups/../escape', '100.90.128.2'), /non-root/);
assert.throws(() => buildRestrictedAuthorizedKey(validKey, "/mnt/user/backups/peer'escape", '100.90.128.2'), /non-root/);
assert.throws(() => buildRestrictedAuthorizedKey(validKey, '/mnt/user/backups/a', 'attacker\nkey'), /source IP/);

const oldEntry = `restrict,command="/old/rrsync '/old/path'" ${validKey}\n`;
const updated = upsertAuthorizedKeyContent(oldEntry, restricted, validKey);
assert.equal(updated.includes('/old/path'), false);
assert.equal(updated.match(/ssh-ed25519/g).length, 1);
assert.equal(removeAuthorizedKeyContent(updated, validKey), '');
assert.equal(removeAuthorizedKeyContent(`ssh-ed25519 ${Buffer.from('other-key').toString('base64')} other@test\n${updated}`, validKey).includes('other@test'), true);

// rrsync resolves every request under the prefix it was given, so sending the
// full absolute path applies the prefix twice: the transfer then fails with
// mkdir "/mnt/user/cross-site/mnt/user/cross-site/appdata".
assert.equal(toRrsyncPath('/mnt/user/cross-site/appdata', '/mnt/user/cross-site'), '/appdata');
assert.equal(toRrsyncPath('/mnt/user/cross-site/a/b', '/mnt/user/cross-site'), '/a/b');
assert.equal(toRrsyncPath('/mnt/user/cross-site', '/mnt/user/cross-site'), '/');
assert.equal(toRrsyncPath('/mnt/user/cross-site/x', '/mnt/user/cross-site/'), '/x');
// An unrestricted peer keeps the absolute path.
assert.equal(toRrsyncPath('/mnt/user/backup', '/'), '/mnt/user/backup');
assert.equal(toRrsyncPath('/mnt/user/backup', null), '/mnt/user/backup');
// A sibling directory that merely shares the prefix string is not inside it.
assert.throws(() => toRrsyncPath('/mnt/user/cross-site-other/x', '/mnt/user/cross-site'), /outside the rrsync prefix/);
assert.throws(() => toRrsyncPath('/etc/shadow', '/mnt/user/cross-site'), /outside the rrsync prefix/);

console.log('SSH public key validation, restriction, replacement, and revocation passed');
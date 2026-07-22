import assert from 'node:assert/strict';
import { validatePairingAccess } from '../app/backend/src/services/peerAccessPolicy.js';

assert.deepEqual(validatePairingAccess('/mnt/user/backups/peer-a', 1073741824), {
  allowedPathPrefix: '/mnt/user/backups/peer-a',
  storageLimitBytes: 1073741824,
});
assert.throws(() => validatePairingAccess('/', 1073741824), /explicit backup directory/);
assert.throws(() => validatePairingAccess('relative/path', 1073741824), /explicit backup directory/);
assert.throws(() => validatePairingAccess('/mnt/user/backups/peer-a', 0), /finite storage limit/);
assert.throws(() => validatePairingAccess('/mnt/user/backups/peer-a', Number.NaN), /finite storage limit/);

console.log('Peer acceptance access policy: 5 cases passed');
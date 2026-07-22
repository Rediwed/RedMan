import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(import.meta.dirname, '../app/frontend/src/pages/HyperBackupPage.jsx'), 'utf8');
assert.match(source, /const attempt = \+\+pairingAttempt\.current/);
assert.match(source, /pollPairingStatus\(result\.id, peer, result\.local_fingerprint, attempt\)/);
assert.match(source, /pairingAttempt\.current !== attempt/);
assert.match(source, /pairingAttempt\.current\+\+/);
assert.match(source, /onClick=\{\(\) => startPairing\(pairingPeer\)\}>Try Again/);
console.log('Pairing retry UI: fresh attempt generation and stale-poll rejection passed');
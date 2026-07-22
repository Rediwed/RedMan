import assert from 'node:assert/strict';
import {
	validatePrivatePeerBaseUrl,
	validateSignedCallbackUrl,
} from '../app/backend/src/services/peerUrlPolicy.js';

assert.equal(validateSignedCallbackUrl('http://192.168.1.20:8091'), 'http://192.168.1.20:8091');
assert.equal(validateSignedCallbackUrl('http://100.90.128.2:8095/'), 'http://100.90.128.2:8095');
assert.equal(validateSignedCallbackUrl('http://[fd00::2]:8091'), 'http://[fd00::2]:8091');
assert.throws(() => validateSignedCallbackUrl('http://169.254.169.254/latest/meta-data'), /path/);
assert.throws(() => validateSignedCallbackUrl('http://8.8.8.8:8091'), /private IP/);
assert.throws(() => validateSignedCallbackUrl('http://peer.local:8091'), /numeric private IP/);
assert.throws(() => validateSignedCallbackUrl('file:///etc/passwd'), /HTTP or HTTPS/);
assert.throws(() => validateSignedCallbackUrl('http://user:pass@192.168.1.20:8091'), /credentials/);
assert.equal(validatePrivatePeerBaseUrl('http://10.0.0.2:8091'), 'http://10.0.0.2:8091');
assert.throws(() => validatePrivatePeerBaseUrl('https://example.com'), /numeric private IP/);

console.log('Private peer and signed callback URL policy: 10 cases passed');
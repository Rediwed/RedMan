import assert from 'node:assert/strict';
import {
  detectInterfaceCallbackIp,
  resolveCallbackUrl,
} from '../app/backend/src/services/callbackAddress.js';

const bridgeOnly = {
  lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
  eth0: [{ family: 'IPv4', address: '172.19.0.2', internal: false }],
};

const lanInterfaces = {
  lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
  br0: [{ family: 'IPv4', address: '10.10.0.9', internal: false }],
};

// ── Interface detection ───────────────────────────────────────────

assert.equal(detectInterfaceCallbackIp(lanInterfaces), '10.10.0.9');
assert.equal(detectInterfaceCallbackIp(bridgeOnly), null, 'Docker bridge addresses are not callback candidates');
assert.equal(detectInterfaceCallbackIp({
  eth0: [{ family: 'IPv4', address: '169.254.10.5', internal: false }],
}), null, 'link-local is not a callback candidate');
assert.equal(detectInterfaceCallbackIp({}), null, 'no interfaces means no candidate');

// ── Resolution order ──────────────────────────────────────────────

assert.equal(resolveCallbackUrl({
  peerPort: '8091',
  explicitUrl: 'http://10.10.20.4:8091/',
  peerHost: '10.10.0.9',
  interfaces: lanInterfaces,
}), 'http://10.10.20.4:8091', 'explicit setting wins and is normalised');

assert.equal(resolveCallbackUrl({
  peerPort: '8091',
  peerHost: '10.10.20.4',
  interfaces: lanInterfaces,
}), 'http://10.10.20.4:8091', 'PEER_HOST beats interface guessing');

assert.equal(resolveCallbackUrl({
  peerPort: '8091',
  peerHost: null,
  interfaces: lanInterfaces,
}), 'http://10.10.0.9:8091', 'host interfaces are the last automatic source');

assert.equal(resolveCallbackUrl({
  peerPort: '9091',
  peerHost: '10.10.20.4',
}), 'http://10.10.20.4:9091', 'the configured peer port is preserved');

assert.equal(resolveCallbackUrl({
  peerHost: '10.10.20.4',
}), 'http://10.10.20.4:8091', 'the peer port falls back to 8091');

assert.equal(resolveCallbackUrl({
  peerPort: '8091',
  peerHost: 'fd00::5',
}), 'http://[fd00::5]:8091', 'IPv6 hosts are bracketed');

// ── Failure modes ─────────────────────────────────────────────────

assert.throws(
  () => resolveCallbackUrl({ peerPort: '8091', peerHost: null, interfaces: bridgeOnly }),
  /Could not determine a private callback IP[\s\S]*PEER_HOST[\s\S]*Peer API URL/,
  'a bridge-only container gets an actionable error naming both fixes',
);

assert.throws(
  () => resolveCallbackUrl({ peerPort: '8091', explicitUrl: 'https://redman.example.com' }),
  /private IP/,
  'a public explicit URL is rejected before it is signed',
);

assert.throws(
  () => resolveCallbackUrl({ peerPort: '8091', explicitUrl: 'http://10.10.20.4:8091/api' }),
  /must not contain a path/,
  'an explicit URL with a path is rejected before it is signed',
);

for (const badPort of ['8091x', '0', '99999', '-1']) {
  assert.throws(
    () => resolveCallbackUrl({ peerPort: badPort, peerHost: '10.10.20.4' }),
    /Peer API port must be an integer/,
    `invalid peer port must be rejected explicitly: ${badPort}`,
  );
}

console.log('Callback address: explicit > PEER_HOST > interfaces, with bridge-only hosts failing loudly');

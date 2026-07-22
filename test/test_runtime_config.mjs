import assert from 'node:assert/strict';
import { getRuntimeConfig, requirePeerHost } from '../app/backend/src/services/runtimeConfig.js';

assert.deepEqual(getRuntimeConfig({}), {
  mainPort: 8090,
  peerApiPort: 8091,
  peerHost: null,
  sshUser: 'redman-backup',
  sshPort: 22,
});
assert.deepEqual(getRuntimeConfig({
  NODE_ENV: 'production',
  PORT: '9000',
  PEER_API_PORT: '9001',
  PEER_HOST: '100.90.128.2',
  SSH_USER: 'redman-backup',
  SSH_PORT: '2222',
}), {
  mainPort: 9000,
  peerApiPort: 9001,
  peerHost: '100.90.128.2',
  sshUser: 'redman-backup',
  sshPort: 2222,
});

assert.throws(() => getRuntimeConfig({ PORT: '8090oops' }), /PORT must be an integer/);
assert.throws(() => getRuntimeConfig({ PORT: '8091', PEER_API_PORT: '8091' }), /different ports/);
assert.throws(() => getRuntimeConfig({ NODE_ENV: 'production' }), /PEER_HOST must be set/);
assert.throws(() => getRuntimeConfig({ PEER_HOST: '0.0.0.0' }), /wildcard/);
assert.throws(() => getRuntimeConfig({ PEER_HOST: 'ssh://host/path' }), /numeric private IP/);
assert.throws(() => getRuntimeConfig({ PEER_HOST: 'redman.internal' }), /numeric private IP/);
assert.throws(() => getRuntimeConfig({ PEER_HOST: '8.8.8.8' }), /numeric private IP/);
assert.throws(() => getRuntimeConfig({ SSH_USER: '-oProxyCommand=bad' }), /SSH_USER/);
assert.throws(() => getRuntimeConfig({ SSH_USER: 'root' }), /non-root/);
assert.throws(() => requirePeerHost({ peerHost: null }), error => error.status === 503 && /PEER_HOST/.test(error.message));
assert.equal(requirePeerHost({ peerHost: '100.90.128.2' }), '100.90.128.2');

console.log('Runtime config: canonical ports, peer host, and SSH defaults validated');
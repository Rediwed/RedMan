import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const fixture = resolve(import.meta.dirname, 'data', `auth-startup-${process.pid}`);
mkdirSync(fixture, { recursive: true });
const entrypoint = resolve(import.meta.dirname, '../app/backend/src/index.js');

function start(extraEnv, name) {
  const cleanParentEnv = { ...process.env };
  for (const key of [
    'AUTH_MODE',
    'AUTH_DISABLED',
    'REDMAN_LOCAL_DEV',
    'REDMAN_PUBLIC_ORIGIN',
    'TRUSTED_PROXIES',
    'PEER_HOST',
    'PROXY_AUTO_PROVISION_ROLE',
    'REDMAN_BOOTSTRAP_TOKEN',
  ]) delete cleanParentEnv[key];
  const env = {
    ...cleanParentEnv,
    NODE_ENV: 'production',
    DB_PATH: resolve(fixture, `${name}.db`),
    PORT: '18190',
    PEER_API_PORT: '18191',
    PEER_HOST: '127.0.0.1',
    ...extraEnv,
  };
  if (extraEnv.PEER_HOST === null) delete env.PEER_HOST;
  const result = spawnSync(process.execPath, [entrypoint], {
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { code: result.status, output: `${result.stdout}\n${result.stderr}` };
}

try {
  const missingMode = start({}, 'missing-mode');
  assert.notEqual(missingMode.code, 0);
  assert.match(missingMode.output, /AUTH_MODE must be explicitly set/);
  assert.doesNotMatch(missingMode.output, /RedMan running on/);

  const missingOrigin = start({ AUTH_MODE: 'local' }, 'missing-origin');
  assert.notEqual(missingOrigin.code, 0);
  assert.match(missingOrigin.output, /REDMAN_PUBLIC_ORIGIN/);
  assert.doesNotMatch(missingOrigin.output, /RedMan running on/);

  const missingPeerHost = start({
    AUTH_MODE: 'proxy',
    REDMAN_PUBLIC_ORIGIN: 'https://redman.example.com',
    TRUSTED_PROXIES: '127.0.0.1/32',
    PEER_HOST: null,
  }, 'missing-peer-host');
  assert.notEqual(missingPeerHost.code, 0);
  assert.match(missingPeerHost.output, /PEER_HOST must be set in production/);
  assert.doesNotMatch(missingPeerHost.output, /RedMan running on/);

  console.log('Startup configuration: missing auth mode, origin, or peer host fails before listening');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

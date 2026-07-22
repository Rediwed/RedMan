import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const authUrl = pathToFileURL(resolve(import.meta.dirname, '../app/backend/src/middleware/auth.js')).href;
const childCode = `
  import { autheliaAuth } from '${authUrl}';
  const req = {
    headers: { 'remote-user': 'test-user' },
    socket: { remoteAddress: '127.0.0.1' },
  };
  const result = { next: false, status: null };
  const res = {
    status(code) { result.status = code; return this; },
    json() { return this; },
  };
  autheliaAuth(req, res, () => { result.next = true; });
  console.log(JSON.stringify(result));
`;

function evaluate(trustedProxies) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', childCode], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      AUTH_DISABLED: 'false',
      TRUSTED_PROXIES: trustedProxies,
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

assert.deepEqual(evaluate(''), { next: false, status: 401 });
assert.deepEqual(evaluate('127.0.0.1/8'), { next: true, status: null });
assert.deepEqual(evaluate('*'), { next: true, status: null });

console.log('Forward-auth proxy trust: 3 modes passed');
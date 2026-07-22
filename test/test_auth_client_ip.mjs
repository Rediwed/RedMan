import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const authUrl = pathToFileURL(resolve(import.meta.dirname, '../app/backend/src/middleware/auth.js')).href;
const code = `
  import { getAuthClientIp } from '${authUrl}';
  const trusted = getAuthClientIp({
    headers: { 'x-forwarded-for': '198.51.100.99, 203.0.113.45, 172.20.0.5' },
    socket: { remoteAddress: '172.20.0.5' },
  });
  const untrusted = getAuthClientIp({
    headers: { 'x-forwarded-for': '203.0.113.45' },
    socket: { remoteAddress: '192.168.50.25' },
  });
  console.log(JSON.stringify({ trusted, untrusted }));
`;
const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
  env: { ...process.env, TRUSTED_PROXIES: '172.20.0.5/32' },
  encoding: 'utf8',
});
assert.equal(result.status, 0, result.stderr);
const values = JSON.parse(result.stdout.trim());
assert.deepEqual(values, { trusted: '203.0.113.45', untrusted: '192.168.50.25' });
console.log('Authentication client IP: trusted XFF and untrusted socket source passed');
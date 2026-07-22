import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildImmichUploadInvocation } from '../app/backend/src/services/immichCommand.js';
import { createImmichRetryDirectory, removeImmichRetryDirectory } from '../app/backend/src/services/immichRetry.js';

const apiKey = 'secret-immich-api-key';
const invocation = buildImmichUploadInvocation({
  serverUrl: 'http://192.168.50.20:2283',
  apiKey,
  logPath: '/app/backend/data/import-logs/run-1.log',
  sourcePath: '/mnt/disks/camera',
});

assert.equal(invocation.args.some(argument => argument.includes(apiKey)), false);
assert.equal(invocation.args.some(argument => argument.startsWith('--api-key')), false);
assert.equal(invocation.env.IMMICH_GO_UPLOAD_API_KEY, apiKey);
assert.equal(invocation.args.at(-1), '/mnt/disks/camera');
assert.throws(() => buildImmichUploadInvocation({}), /requires server/);

const fixture = mkdtempSync(join(tmpdir(), 'redman-immich-retry-test-'));
try {
  const [first, second] = await Promise.all([
    createImmichRetryDirectory(1, fixture),
    createImmichRetryDirectory(2, fixture),
  ]);
  assert.notEqual(first, second);
  assert.equal(statSync(first).mode & 0o777, 0o700);
  assert.equal(statSync(second).mode & 0o777, 0o700);
  await Promise.all([removeImmichRetryDirectory(first), removeImmichRetryDirectory(second)]);
  await assert.rejects(createImmichRetryDirectory('invalid', fixture), /positive integer/);
} finally {
  await rm(fixture, { recursive: true, force: true });
}

console.log('Immich invocation and retry isolation: secret-safe args, unique mode-0700 directories, and scoped cleanup passed');
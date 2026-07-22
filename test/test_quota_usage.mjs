import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getQuotaUsage, invalidateQuotaUsage } from '../app/backend/src/services/quotaUsage.js';

const fixture = resolve(import.meta.dirname, 'data', `quota-usage-${process.pid}`);
mkdirSync(fixture, { recursive: true });
writeFileSync(resolve(fixture, 'payload.bin'), Buffer.alloc(4096));

try {
  const first = await getQuotaUsage(fixture);
  assert.equal(first.cached, false);
  assert.ok(first.usedBytes >= 4096);

  writeFileSync(resolve(fixture, 'payload.bin'), Buffer.alloc(16384));
  const cached = await getQuotaUsage(fixture);
  assert.equal(cached.cached, true);
  assert.equal(cached.usedBytes, first.usedBytes);

  invalidateQuotaUsage(fixture);
  const refreshed = await getQuotaUsage(fixture);
  assert.equal(refreshed.cached, false);
  assert.ok(refreshed.usedBytes > first.usedBytes);
  console.log('Quota usage cache: reuse and invalidation passed');
} finally {
  invalidateQuotaUsage();
  rmSync(fixture, { recursive: true, force: true });
}
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assertLocalSourceHasEntries,
  assertRemoteSourceHasEntries,
} from '../app/backend/src/services/sourceHealth.js';

const fixture = resolve(import.meta.dirname, 'data', `source-health-${process.pid}`);
mkdirSync(fixture, { recursive: true });

try {
  await assert.rejects(() => assertLocalSourceHasEntries(fixture), /empty/);
  writeFileSync(resolve(fixture, 'file.txt'), 'content');
  await assert.doesNotReject(() => assertLocalSourceHasEntries(fixture));
  await assert.rejects(() => assertLocalSourceHasEntries(resolve(fixture, 'missing')), /inaccessible/);
  assert.throws(() => assertRemoteSourceHasEntries([]), /empty/);
  assert.doesNotThrow(() => assertRemoteSourceHasEntries([{ Path: 'file.txt' }]));
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

console.log('Destructive sync source health: 5 cases passed');
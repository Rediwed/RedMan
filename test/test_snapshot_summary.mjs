import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  getOrCreateSnapshotSummary,
  readSnapshotSummary,
  refreshSnapshotSummary,
} from '../app/backend/src/services/snapshotSummary.js';

const fixture = resolve(import.meta.dirname, 'data', `snapshot-summary-${process.pid}`);
mkdirSync(resolve(fixture, 'nested'), { recursive: true });
writeFileSync(resolve(fixture, 'full.txt'), '12345');
writeFileSync(resolve(fixture, 'nested', 'changed.txt.rdelta'), '12');
const manifest = {
  files: {
    'full.txt': { type: 'full', originalSize: 5 },
    'nested/changed.txt': { type: 'delta', originalSize: 20, deltaSize: 2 },
  },
};

try {
  const summary = await refreshSnapshotSummary(fixture, manifest);
  assert.equal(summary.fileCount, 2);
  assert.equal(summary.diskSize, 7);
  assert.equal(summary.originalSize, 25);
  assert.deepEqual(await readSnapshotSummary(fixture), summary);

  writeFileSync(resolve(fixture, 'ignored-after-summary.txt'), 'not counted until refresh');
  assert.deepEqual(await getOrCreateSnapshotSummary(fixture, manifest), summary);

  rmSync(resolve(fixture, '_summary.json'));
  await assert.rejects(
    refreshSnapshotSummary(fixture, manifest, { scanLimit: 1 }),
    /scan exceeded 1 entries/,
  );
  const incomplete = await getOrCreateSnapshotSummary(fixture, manifest, {
    scanLimit: 1,
    cacheIncomplete: true,
  });
  assert.equal(incomplete.incomplete, true);
  assert.equal(incomplete.fileCount, null);
  assert.deepEqual(await getOrCreateSnapshotSummary(fixture, manifest), incomplete);
  console.log('Snapshot summary persistence: accounting, cached reads, and bounded legacy scans passed');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
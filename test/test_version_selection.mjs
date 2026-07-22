import assert from 'node:assert/strict';
import {
  applyVersionOverlay,
  getNewerVersions,
  parseVersionTimestamp,
} from '../app/backend/src/services/versionSelection.js';

const snapshots = [
  '2026-01-01T00-00-04',
  '2026-01-01T00-00-02',
  'not-a-snapshot',
  '2026-01-01T00-00-01',
  '2026-01-01T00-00-03',
];

const revisions = new Map([
  ['2026-01-01T00-00-02', 'revision-1'],
  ['2026-01-01T00-00-03', 'revision-2'],
  ['2026-01-01T00-00-04', 'revision-3'],
]);

function resolveOverlay(timestamp) {
  const entries = new Map([
    ['document.txt', { name: 'document.txt', source: 'current', content: 'revision-4' }],
  ]);

  for (const version of getNewerVersions(snapshots, timestamp)) {
    applyVersionOverlay(entries, 'document.txt', {
      name: 'document.txt',
      source: 'version',
      versionTimestamp: version,
      content: revisions.get(version),
    });
  }

  return entries.get('document.txt');
}

assert.deepEqual(getNewerVersions(snapshots, '2026-01-01T00-00-01'), [
  '2026-01-01T00-00-02',
  '2026-01-01T00-00-03',
  '2026-01-01T00-00-04',
]);

assert.equal(resolveOverlay('2026-01-01T00-00-01').content, 'revision-1');
assert.equal(resolveOverlay('2026-01-01T00-00-02').content, 'revision-2');
assert.equal(resolveOverlay('2026-01-01T00-00-03').content, 'revision-3');
assert.equal(resolveOverlay('2026-01-01T00-00-04').content, 'revision-4');
assert.equal(
  parseVersionTimestamp('2026-07-17T12-34-56').toISOString(),
  '2026-07-17T12:34:56.000Z',
);

console.log('Version selection regression: 4 snapshots passed');
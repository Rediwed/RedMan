import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { clearScan, startScan } from '../app/backend/src/services/driveScanner.js';

const fixture = resolve(import.meta.dirname, 'data', `drive-scan-${process.pid}`);
mkdirSync(resolve(fixture, 'DCIM', '100CANON'), { recursive: true });
writeFileSync(resolve(fixture, 'DCIM', '100CANON', 'photo.cr2'), 'photo');

function scan(driveId, mountPath) {
  return new Promise(resolveScan => {
    startScan(driveId, mountPath, { onComplete: resolveScan });
  });
}

try {
  const completed = await scan(1, fixture);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.photos, 1);
  assert.equal(completed.detectedCamera, 'Canon');

  const failed = await scan(2, resolve(fixture, 'missing'));
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /Cannot read drive root/);
  console.log('Drive scan completion callbacks: success and failure passed');
} finally {
  clearScan(1);
  clearScan(2);
  rmSync(fixture, { recursive: true, force: true });
}
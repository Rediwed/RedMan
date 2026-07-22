import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const fixture = mkdtempSync(join(tmpdir(), 'redman-temp-cleanup-'));
process.env.DB_PATH = resolve(fixture, 'redman.db');
const {
  cleanupOrphanedTempFiles,
  cleanupTempFile,
  registerTempFile,
} = await import('../app/backend/src/services/deltaVersion.js');
const { default: db } = await import('../app/backend/src/db.js');

try {
  const tempDirectory = join(fixture, 'delta-temp');
  mkdirSync(tempDirectory, { mode: 0o700 });
  const staleFiles = Array.from({ length: 4 }, (_, index) => join(tempDirectory, `redman-delta-stale-${index}`));
  const activeFile = join(tempDirectory, 'redman-delta-active');
  const freshFile = join(tempDirectory, 'redman-delta-fresh');
  const unrelatedFile = join(tempDirectory, 'unrelated');
  const oldDate = new Date(Date.now() - 7200_000);

  for (const file of [...staleFiles, activeFile]) {
    writeFileSync(file, 'old');
    utimesSync(file, oldDate, oldDate);
  }
  writeFileSync(freshFile, 'fresh');
  writeFileSync(unrelatedFile, 'unrelated');
  registerTempFile(activeFile);

  const capped = await cleanupOrphanedTempFiles({
    tempDirectory,
    scanLimit: 2,
    deleteLimit: 1,
    cutoff: Date.now() - 3600_000,
  });
  assert.ok(capped.scanned <= 2);
  assert.ok(capped.deleted <= 1);
  assert.equal(capped.complete, false);

  const completed = await cleanupOrphanedTempFiles({
    tempDirectory,
    scanLimit: 100,
    deleteLimit: 100,
    cutoff: Date.now() - 3600_000,
  });
  assert.equal(completed.complete, true);
  assert.equal(completed.deleted, staleFiles.length - capped.deleted);
  assert.equal(await cleanupTempFile(activeFile), undefined);

  const source = await import('node:fs/promises').then(({ readFile }) =>
    readFile(resolve(import.meta.dirname, '../app/backend/src/services/deltaVersion.js'), 'utf8'));
  const cleanupSection = source.slice(source.indexOf('export async function cleanupOrphanedTempFiles'), source.indexOf('// ── rdiff subprocess helpers'));
  assert.match(cleanupSection, /opendir\(tempDirectory\)/);
  assert.doesNotMatch(cleanupSection, /readdir\(tmpdir\(\)\)/);
  console.log('Temp cleanup: private directory, bounded scan/delete, and active-file preservation passed');
} finally {
  db.close();
  rmSync(fixture, { recursive: true, force: true });
}
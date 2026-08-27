import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertStagedArchiveSafe,
  defaultOnlineStagingPath,
  removePartialDownload,
  requiredOnlineImportBytes,
  validateOnlineMediaSourceInput,
} from '../app/backend/src/services/onlineMediaImport.js';

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
assert.equal(requiredOnlineImportBytes(100 * MiB), 612 * MiB);
assert.equal(requiredOnlineImportBytes(10 * GiB), 11 * GiB);
assert.throws(() => requiredOnlineImportBytes(-1), /non-negative/);

const sandbox = mkdtempSync(join(tmpdir(), 'redman-online-import-'));
try {
  const databasePath = join(sandbox, 'data', 'redman.db');
  mkdirSync(join(sandbox, 'data'));
  const automaticPath = defaultOnlineStagingPath('google_drive', 'Takeout', databasePath);
  assert.equal(automaticPath.startsWith(join(sandbox, 'data', 'media-import-staging')), true);
  const automatic = validateOnlineMediaSourceInput({
    name: 'Automatic', remote_name: 'google_drive', remote_path: 'Takeout',
  }, { roots: [sandbox], databasePath });
  assert.equal(automatic.stagingPath, realpathSync(automaticPath));
  assert.equal(statSync(join(sandbox, 'data')).mode & 0o777, 0o700);
  assert.equal(statSync(join(sandbox, 'data', 'media-import-staging')).mode & 0o777, 0o700);

  const source = validateOnlineMediaSourceInput({
    name: 'Google Photos', path: join(sandbox, 'ignored-custom-staging'),
    remote_name: 'google_drive',
    remote_path: '/Takeout/Google Photos/',
  }, { roots: [sandbox], databasePath });
  assert.deepEqual(source, {
    name: 'Google Photos',
    remoteName: 'google_drive',
    remotePath: 'Takeout/Google Photos',
    stagingPath: realpathSync(defaultOnlineStagingPath('google_drive', 'Takeout/Google Photos', databasePath)),
  });
  const staging = source.stagingPath;
  const safeArchive = join(staging, 'takeout.zip');
  writeFileSync(safeArchive, 'safe');
  assert.equal(assertStagedArchiveSafe(safeArchive, staging, 4), safeArchive);

  const partialArchive = join(staging, 'takeout.zip.partial');
  writeFileSync(partialArchive, 'partial');
  const partialInfo = statSync(partialArchive);
  assert.equal(removePartialDownload(partialArchive, staging, {
    dev: partialInfo.dev, ino: partialInfo.ino,
  }, 'test-run'), true);
  assert.equal(existsSync(partialArchive), false);
  assert.equal(removePartialDownload(partialArchive, staging, {
    dev: partialInfo.dev, ino: partialInfo.ino,
  }, 'test-run'), false);

  const replacedPartial = join(staging, 'replaced.zip.partial');
  writeFileSync(replacedPartial, 'replacement');
  assert.throws(
    () => removePartialDownload(replacedPartial, staging, { dev: partialInfo.dev, ino: partialInfo.ino }, 'test-run'),
    /changed before cleanup/,
  );
  assert.equal(existsSync(replacedPartial), true);

  const outsideArchive = join(sandbox, 'outside.zip');
  writeFileSync(outsideArchive, 'safe');
  const linkedArchive = join(staging, 'linked.zip');
  symlinkSync(outsideArchive, linkedArchive);
  assert.throws(
    () => assertStagedArchiveSafe(linkedArchive, staging, 4),
    /not a regular file|resolves elsewhere/,
  );
  assert.throws(
    () => removePartialDownload(linkedArchive, staging, { dev: partialInfo.dev, ino: partialInfo.ino }, 'test-run'),
    /outside the online import staging folder|not a regular file|resolves elsewhere/,
  );
  assert.equal(existsSync(outsideArchive), true);
  assert.throws(() => validateOnlineMediaSourceInput({
    name: 'Traversal', path: staging, remote_name: 'drive', remote_path: '../Takeout',
  }, { roots: [sandbox], databasePath }), /valid Google Takeout folder/);
} finally {
  await rm(sandbox, { recursive: true, force: true });
}

console.log('Online media import: confined staging, safe remote paths, and bounded free-space reserve passed');
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, statSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildImmichUploadInvocation } from '../app/backend/src/services/immichCommand.js';
import { applyImmichLogProgress, watchImmichLogProgress } from '../app/backend/src/services/immichImport.js';
import { createImmichRetryDirectory, removeImmichRetryDirectory } from '../app/backend/src/services/immichRetry.js';
import {
  resolveImportSourcePaths, countTakeoutArchives, supportsDriveSideEffects,
  isTakeoutArchiveName, listTakeoutArchives, assertSourceReadable, validateFolderSourceInput,
} from '../app/backend/src/services/mediaImportSources.js';
import {
  discoverRemoteTakeoutFolder, findTakeoutFolderCandidates,
} from '../app/backend/src/services/rclone.js';
import { normalizePath } from '../app/backend/src/middleware/validation.js';

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

const logProgress = { scanned: 0, uploaded: 0, duplicates: 0, errors: 0 };
assert.equal(applyImmichLogProgress('INF uploaded successfully file=Takeout:a.jpg', logProgress), true);
assert.equal(applyImmichLogProgress('INF server has duplicate file=Takeout:b.jpg', logProgress), true);
assert.equal(applyImmichLogProgress('INF server asset upgraded file=Takeout:c.jpg', logProgress), true);
assert.equal(applyImmichLogProgress('INF server has same file=Takeout:d.jpg', logProgress), true);
assert.equal(applyImmichLogProgress('ERR upload failed file=Takeout:e.jpg error=network', logProgress), true);
assert.equal(applyImmichLogProgress('ERR unrelated diagnostic without a file outcome', logProgress), false);
assert.equal(applyImmichLogProgress('INF Upload errors: 5', logProgress), false);
assert.equal(applyImmichLogProgress('INF unrelated message', logProgress), false);
assert.deepEqual(logProgress, { scanned: 5, uploaded: 2, duplicates: 2, errors: 1 });

const progressLogDir = mkdtempSync(join(tmpdir(), 'redman-progress-log-test-'));
try {
  const progressLog = join(progressLogDir, 'run.log');
  writeFileSync(progressLog, '');
  const watchedProgress = { scanned: 0, uploaded: 0, duplicates: 0, errors: 0 };
  const stopWatching = watchImmichLogProgress(progressLog, watchedProgress);
  const lines = Array.from({ length: 8_000 }, (_, index) => (
    index % 2 === 0
      ? `INF uploaded successfully file=Takeout:file-${index}.jpg\n`
      : `INF server has duplicate file=Takeout:file-${index}.jpg\n`
  ));
  appendFileSync(progressLog, lines.join(''));
  await stopWatching();
  assert.deepEqual(watchedProgress, { scanned: 8_000, uploaded: 4_000, duplicates: 4_000, errors: 0 });
} finally {
  await rm(progressLogDir, { recursive: true, force: true });
}

// A takeout is read with a different immich-go command, and dropping
// --include-unmatched silently skips every photo whose sidecar is missing.
const takeout = buildImmichUploadInvocation({
  serverUrl: 'http://192.168.50.20:2283',
  apiKey,
  logPath: '/app/backend/data/import-logs/run-2.log',
  sourcePaths: ['/mnt/user/takeout/takeout-001.zip', '/mnt/user/takeout/takeout-002.zip'],
  mode: 'google-photos',
});
assert.deepEqual(takeout.args.slice(0, 2), ['upload', 'from-google-photos']);
assert.equal(takeout.args.includes('--include-unmatched'), true);
assert.deepEqual(takeout.args.slice(-2), [
  '/mnt/user/takeout/takeout-001.zip',
  '/mnt/user/takeout/takeout-002.zip',
]);
assert.equal(takeout.args.some(argument => argument.includes(apiKey)), false);
assert.equal(invocation.args.includes('--include-unmatched'), false);
assert.throws(() => buildImmichUploadInvocation({
  serverUrl: 'http://immich',
  apiKey,
  logPath: '/tmp/run.log',
  sourcePath: '/mnt/user/takeout',
  mode: 'from-google-photos',
}), /Unsupported Immich upload mode/);

// Archives are handed over in numeric order, since immich-go matches sidecars
// across archive boundaries as it reads.
const listing = () => ['takeout-010.zip', 'takeout-002.zip', 'notes.txt', 'takeout-001.ZIP']
  .filter(name => name.toLowerCase().endsWith('.zip'));
const takeoutSource = { mount_path: '/mnt/user/takeout', import_mode: 'google-photos' };
assert.deepEqual(
  resolveImportSourcePaths(takeoutSource, listing),
  ['/mnt/user/takeout/takeout-001.ZIP', '/mnt/user/takeout/takeout-002.zip', '/mnt/user/takeout/takeout-010.zip'],
);
// The count comes from the same resolution as the upload, so an uppercase
// extension cannot import fine while the UI reports nothing to import.
assert.equal(countTakeoutArchives(takeoutSource, listing), 3);
// An extracted takeout has no archives; the folder itself is the source.
assert.deepEqual(resolveImportSourcePaths(takeoutSource, () => []), ['/mnt/user/takeout']);
assert.equal(countTakeoutArchives(takeoutSource, () => []), 0);
assert.deepEqual(
  resolveImportSourcePaths({ mount_path: '/mnt/disks/camera', import_mode: 'folder' }, listing),
  ['/mnt/disks/camera'],
);
assert.equal(countTakeoutArchives({ mount_path: '/mnt/disks/camera', import_mode: 'folder' }, listing), 0);
assert.equal(isTakeoutArchiveName('takeout-001.zip'), true);
assert.equal(isTakeoutArchiveName('takeout-002.TGZ'), true);
assert.equal(isTakeoutArchiveName('takeout-003.tar.gz'), true);
assert.equal(isTakeoutArchiveName('takeout-004.tar'), false);
assert.deepEqual(findTakeoutFolderCandidates([
  { Name: 'Photos', IsDir: true },
  { Name: 'Takeout', IsDir: true },
  { Name: 'Takeout', IsDir: true },
  { Name: 'Google Takeout', IsDir: true },
  { Name: 'Takeout\n', IsDir: true },
  { Name: 'takeout.zip', IsDir: false },
]), ['Takeout', 'Google Takeout']);

const discoveryCalls = [];
assert.deepEqual(await discoverRemoteTakeoutFolder('gdrive', {
  listDirectories: async (remoteName, options) => {
    discoveryCalls.push(['directories', remoteName, options.timeoutMs <= 20000, options.processKey]);
    return [{ Name: 'Takeout', IsDir: true }, { Name: 'Other', IsDir: true }];
  },
  listArchives: async (remoteName, remotePath, options) => {
    discoveryCalls.push(['archives', remoteName, remotePath, options.timeoutMs <= 20000, options.processKey]);
    return [{ path: 'takeout-001.zip', size: 10 }];
  },
  processKey: 'test-discovery',
}), { path: 'Takeout', archiveCount: 1 });
assert.deepEqual(discoveryCalls, [
  ['directories', 'gdrive', true, 'test-discovery'],
  ['archives', 'gdrive', 'Takeout', true, 'test-discovery'],
]);
await assert.rejects(discoverRemoteTakeoutFolder('gdrive', {
  listDirectories: async () => [{ Name: 'Photos', IsDir: true }],
}), /No Takeout folder was found/);

// Deleting sources and ejecting hardware only apply to a removable drive.
assert.equal(supportsDriveSideEffects({ source_kind: 'drive' }), true);
assert.equal(supportsDriveSideEffects({ source_kind: 'folder' }), false);

// A path carrying a NUL byte is refused by the validator itself rather than
// relying on a downstream syscall to reject the truncated remainder.
assert.equal(normalizePath('/mnt/user/takeout\0/etc'), null);

const sandbox = mkdtempSync(join(tmpdir(), 'redman-media-source-test-'));
const escape = mkdtempSync(join(tmpdir(), 'redman-outside-'));
try {
  const roots = { roots: [sandbox] };
  const takeoutDir = join(sandbox, 'takeout');
  mkdirSync(takeoutDir);
  writeFileSync(join(takeoutDir, 'takeout-002.zip'), '');
  writeFileSync(join(takeoutDir, 'takeout-001.zip'), '');
  writeFileSync(join(takeoutDir, 'takeout-003.tgz'), '');
  writeFileSync(join(takeoutDir, 'takeout-004.tar.gz'), '');
  writeFileSync(join(takeoutDir, 'readme.txt'), '');
  mkdirSync(join(takeoutDir, 'nested.zip'));

  // A directory named like an archive is not one.
  assert.deepEqual(listTakeoutArchives(takeoutDir).sort(), [
    'takeout-001.zip', 'takeout-002.zip', 'takeout-003.tgz', 'takeout-004.tar.gz',
  ]);
  assert.deepEqual(listTakeoutArchives(join(sandbox, 'absent')), []);

  const declared = validateFolderSourceInput({ name: 'Takeout', path: takeoutDir, import_mode: 'google-photos' }, roots);
  assert.equal(declared.importMode, 'google-photos');

  // A folder outside every root stays out, and so does a symlink pointing there.
  const link = join(sandbox, 'link-out');
  symlinkSync(escape, link);
  assert.throws(
    () => validateFolderSourceInput({ name: 'Escape', path: link, import_mode: 'folder' }, roots),
    /storage roots/,
  );

  // The same check runs again at import time, because the folder that was
  // declared can be replaced by a link to somewhere else afterwards.
  const swapped = join(sandbox, 'swapped');
  symlinkSync(escape, swapped);
  assert.throws(
    () => assertSourceReadable({ source_kind: 'folder', mount_path: swapped }, roots),
    /resolves elsewhere/,
  );
  assert.throws(
    () => assertSourceReadable({ source_kind: 'folder', mount_path: join(sandbox, 'gone') }, roots),
    /no longer exists/,
  );
  assert.equal(assertSourceReadable({ source_kind: 'folder', mount_path: declared.path }, roots), declared.path);
  // A removable drive is not held to the storage roots; it never was.
  assert.equal(
    assertSourceReadable({ source_kind: 'drive', mount_path: '/mnt/disks/camera' }, roots),
    '/mnt/disks/camera',
  );
} finally {
  await rm(sandbox, { recursive: true, force: true });
  await rm(escape, { recursive: true, force: true });
}

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

console.log('Immich invocation and retry isolation: secret-safe args, takeout mode and ordering, unique mode-0700 directories, and scoped cleanup passed');
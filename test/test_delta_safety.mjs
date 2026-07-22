import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';

const fixture = resolve(import.meta.dirname, 'data', `delta-safety-${process.pid}`);
const fakeBin = resolve(fixture, 'bin');
mkdirSync(fakeBin, { recursive: true });
const fakeRdiff = resolve(fakeBin, 'rdiff');
writeFileSync(fakeRdiff, `#!/bin/sh
set -eu
case "$1" in
  signature) cat "$2" ;;
  delta) cp "$3" "$4" ;;
  patch) cp "$3" "$4" ;;
  *) exit 2 ;;
esac
`);
chmodSync(fakeRdiff, 0o755);
process.env.PATH = `${fakeBin}:${process.env.PATH}`;
process.env.DB_PATH = resolve(fixture, 'redman.db');

const { default: db } = await import('../app/backend/src/db.js');
const {
  cleanupTempFile,
  deltaifySnapshot,
  readManifest,
  reconstructFile,
} = await import('../app/backend/src/services/deltaVersion.js');
const { pruneVersions } = await import('../app/backend/src/services/versionBrowser.js');

function createConfig(name, sourcePath, destinationPath) {
  mkdirSync(sourcePath, { recursive: true });
  mkdirSync(destinationPath, { recursive: true });
  const result = db.prepare(`
    INSERT INTO ssd_backup_configs (
      name, source_path, dest_path, versioning_enabled, delta_versioning,
      delta_threshold, retention_policy
    ) VALUES (?, ?, ?, 1, 1, -1, ?)
  `).run(name, sourcePath, destinationPath, JSON.stringify({
    hourly: 0,
    daily: 0,
    weekly: 30,
    monthly: 0,
    quarterly: 0,
  }));
  return Number(result.lastInsertRowid);
}

function writeManifest(directory, files) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, '_manifest.json'), JSON.stringify({ files }));
}

const originalNow = Date.now;
try {
  const conversionDestination = resolve(fixture, 'conversion-destination');
  const conversionConfig = createConfig(
    'Atomic conversion',
    resolve(fixture, 'conversion-source'),
    conversionDestination,
  );
  const conversionTimestamp = '2026-07-20T12-00-00';
  const conversionVersion = resolve(conversionDestination, '.versions', conversionTimestamp);
  mkdirSync(conversionVersion, { recursive: true });
  writeFileSync(resolve(conversionDestination, 'document.txt'), 'current revision');
  writeFileSync(resolve(conversionVersion, 'document.txt'), 'retained revision');

  await deltaifySnapshot(conversionConfig, conversionTimestamp);
  const convertedManifest = await readManifest(conversionVersion);
  assert.equal(convertedManifest.files['document.txt'].type, 'delta');
  assert.equal(existsSync(resolve(conversionVersion, 'document.txt')), false);
  assert.equal(existsSync(resolve(conversionVersion, 'document.txt.rdelta')), true);
  const reconstructed = await reconstructFile(
    conversionDestination,
    resolve(conversionDestination, '.versions'),
    conversionTimestamp,
    'document.txt',
  );
  assert.equal(readFileSync(reconstructed.path, 'utf8'), 'retained revision');
  if (reconstructed.isTemp) await cleanupTempFile(reconstructed.path);

  Date.now = () => new Date('2026-07-29T12:00:00Z').getTime();
  const pruneDestination = resolve(fixture, 'prune-destination');
  const pruneConfig = createConfig('Dependency pruning', resolve(fixture, 'prune-source'), pruneDestination);
  const versionsDir = resolve(pruneDestination, '.versions');
  const older = '2026-07-19T12-00-00';
  const intermediate = '2026-07-20T12-00-00';
  const weeklyKeeper = '2026-07-21T12-00-00';
  const deleting = '2026-07-27T12-00-00';
  const newest = '2026-07-28T12-00-00';
  writeManifest(resolve(versionsDir, newest), {});
  writeManifest(resolve(versionsDir, weeklyKeeper), {});
  writeManifest(resolve(versionsDir, deleting), {
    'document.txt': { type: 'full', originalSize: 13 },
  });
  writeFileSync(resolve(versionsDir, deleting, 'document.txt'), 'base revision');
  writeManifest(resolve(versionsDir, intermediate), {
    'document.txt': { type: 'delta', originalSize: 21, deltaSize: 21, base: deleting },
  });
  writeFileSync(resolve(versionsDir, intermediate, 'document.txt.rdelta'), 'intermediate revision');
  writeManifest(resolve(versionsDir, older), {
    'document.txt': { type: 'delta', originalSize: 17, deltaSize: 17, base: intermediate },
  });
  writeFileSync(resolve(versionsDir, older, 'document.txt.rdelta'), 'retained revision');

  const pruneResult = await pruneVersions(pruneConfig);
  assert.equal(pruneResult.pruned, 2);
  assert.equal(existsSync(resolve(versionsDir, deleting)), false);
  assert.equal(existsSync(resolve(versionsDir, intermediate)), false);
  assert.equal(readFileSync(resolve(versionsDir, older, 'document.txt'), 'utf8'), 'retained revision');
  assert.equal((await readManifest(resolve(versionsDir, older))).files['document.txt'].type, 'full');
  assert.equal(existsSync(resolve(versionsDir, older, 'document.txt.rdelta')), false);

  const failureDestination = resolve(fixture, 'failure-destination');
  const failureConfig = createConfig('Fail-closed pruning', resolve(fixture, 'failure-source'), failureDestination);
  const failureVersions = resolve(failureDestination, '.versions');
  writeManifest(resolve(failureVersions, newest), {});
  writeManifest(resolve(failureVersions, weeklyKeeper), {});
  writeManifest(resolve(failureVersions, deleting), {
    'document.txt': { type: 'full', originalSize: 13 },
  });
  writeFileSync(resolve(failureVersions, deleting, 'document.txt'), 'base revision');
  writeManifest(resolve(failureVersions, intermediate), {
    'document.txt': { type: 'delta', originalSize: 17, deltaSize: 17, base: deleting },
  });

  await assert.rejects(pruneVersions(failureConfig), /Delta file missing/);
  assert.equal(existsSync(resolve(failureVersions, deleting)), true);

  console.log('Delta safety: atomic publication and fail-closed dependency pruning passed');
} finally {
  Date.now = originalNow;
  db.close();
  rmSync(fixture, { recursive: true, force: true });
}
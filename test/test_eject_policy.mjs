import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const fixture = resolve(import.meta.dirname, 'data', `eject-policy-${process.pid}`);
const helper = resolve(fixture, 'eject-helper.sh');
mkdirSync(fixture, { recursive: true });
process.env.DB_PATH = resolve(fixture, 'redman.db');
const { ejectDrive, isEjectSupported } = await import('../app/backend/src/services/immichImport.js');
writeFileSync(helper, '#!/bin/sh\nexit 0\n');
chmodSync(helper, 0o700);

try {
  assert.equal(isEjectSupported(), false);
  assert.equal(ejectDrive('/mnt/disks/camera').unsupported, true);
  assert.equal(isEjectSupported(helper), true);
  assert.deepEqual(ejectDrive('/mnt/disks/camera', helper), { ok: true });
  console.log('Drive eject helper policy: unsupported and configured cases passed');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
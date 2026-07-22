import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const fixture = resolve(import.meta.dirname, 'data', `db-backup-policy-${process.pid}`);
const destination = resolve(fixture, 'destination');
process.env.DB_PATH = resolve(fixture, 'redman.db');
mkdirSync(destination, { recursive: true });

const { backupDatabase } = await import('../app/backend/src/services/dbBackup.js');
const { default: db } = await import('../app/backend/src/db.js');
const backupDir = resolve(destination, '.versions', '_db_backups');
const start = Date.UTC(2026, 0, 1, 0, 0, 0);
const listBackups = () => readdirSync(backupDir).filter(filename => /^redman-.*\.db$/.test(filename));

try {
  const first = await backupDatabase(destination, { force: true, now: start });
  assert(first);

  const skipped = await backupDatabase(destination, { now: Date.now() });
  assert.equal(skipped, null);
  assert.equal(listBackups().length, 1);

  for (let index = 1; index <= 6; index++) {
    const path = await backupDatabase(destination, { force: true, now: start + index * 60_000 });
    assert(path);
  }
  assert.equal(listBackups().length, 5);
  assert.deepEqual(readdirSync(backupDir), listBackups());

  writeFileSync(resolve(backupDir, 'redman-extra-a.db'), 'excess');
  writeFileSync(resolve(backupDir, 'redman-extra-b.db'), 'excess');
  assert.equal(await backupDatabase(destination, { now: Date.now() }), null);
  assert.equal(listBackups().length, 5);

  await assert.rejects(
    backupDatabase(destination, { minimumIntervalMs: 24 * 60 * 60_000 + 1 }),
    /backup interval must be between/,
  );
  const cancelledBackup = new AbortController();
  cancelledBackup.abort(new Error('test cancellation'));
  await assert.rejects(
    backupDatabase(destination, { force: true, signal: cancelledBackup.signal }),
    /test cancellation/,
  );
  assert.equal(listBackups().length, 5);

  console.log('Automatic database backup interval and rotation: passed');
} finally {
  db.close();
  rmSync(fixture, { recursive: true, force: true });
}
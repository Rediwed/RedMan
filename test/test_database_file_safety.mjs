import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  applyPendingDatabaseRestore,
  createOnlineDatabaseBackup,
  getPendingRestorePath,
  stageDatabaseRestore,
  validateSqliteDatabase,
  validateSqliteDatabaseAsync,
  rotatePreRestoreCopies,
} from '../app/backend/src/services/databaseFileSafety.js';

const require = createRequire(resolve(import.meta.dirname, '../app/package.json'));
const Database = require('better-sqlite3');
const fixture = resolve(import.meta.dirname, 'data', `database-safety-${process.pid}`);
const activePath = resolve(fixture, 'redman.db');
const backupPath = resolve(fixture, 'online-backup.db');
const candidatePath = resolve(fixture, 'candidate.db');
mkdirSync(fixture, { recursive: true });

function createDatabase(filePath, marker, rows = 1) {
  const database = new Database(filePath);
  database.pragma('journal_mode = WAL');
  database.exec('CREATE TABLE state (marker TEXT); CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT)');
  database.prepare('INSERT INTO state VALUES (?)').run(marker);
  const insert = database.prepare('INSERT INTO items (value) VALUES (?)');
  const insertRows = database.transaction(() => {
    for (let index = 0; index < rows; index++) insert.run(`row-${index}`);
  });
  insertRows();
  return database;
}

try {
  const active = createDatabase(activePath, 'active', 5000);
  const backupPromise = createOnlineDatabaseBackup(active, backupPath);
  active.prepare('INSERT INTO items (value) VALUES (?)').run('concurrent-write');
  await backupPromise;
  assert.equal(statSync(backupPath).mode & 0o777, 0o600);
  assert.equal(statSync(fixture).mode & 0o777, 0o700);
  assert.equal(validateSqliteDatabase(backupPath), true);
  assert.equal(await validateSqliteDatabaseAsync(backupPath), true);
  await assert.rejects(validateSqliteDatabaseAsync(backupPath, 999), /timeout must be between/);
  const cancelledValidation = new AbortController();
  cancelledValidation.abort(new Error('test cancellation'));
  await assert.rejects(
    validateSqliteDatabaseAsync(backupPath, { signal: cancelledValidation.signal }),
    /test cancellation/,
  );
  const onlineBackup = new Database(backupPath, { readonly: true });
  assert.equal(onlineBackup.prepare('SELECT marker FROM state').pluck().get(), 'active');
  assert(onlineBackup.prepare('SELECT COUNT(*) FROM items').pluck().get() >= 5000);
  onlineBackup.close();
  active.close();

  const candidate = createDatabase(candidatePath, 'restored', 3);
  candidate.close();
  const cancelledStage = new AbortController();
  cancelledStage.abort(new Error('restore staging cancelled'));
  await assert.rejects(
    stageDatabaseRestore(candidatePath, resolve(fixture, 'cancelled.db'), { signal: cancelledStage.signal }),
    /restore staging cancelled/,
  );
  assert.equal(existsSync(getPendingRestorePath(resolve(fixture, 'cancelled.db'))), false);

  const blockedDirectory = resolve(fixture, 'blocked-restore');
  const blockedActivePath = resolve(blockedDirectory, 'redman.db');
  const blockedCandidatePath = resolve(blockedDirectory, 'candidate.db');
  mkdirSync(blockedDirectory, { recursive: true });
  const blockedActive = createDatabase(blockedActivePath, 'must-survive', 2);
  blockedActive.close();
  const blockedCandidate = createDatabase(blockedCandidatePath, 'candidate', 2);
  blockedCandidate.close();
  const blockedPendingPath = await stageDatabaseRestore(blockedCandidatePath, blockedActivePath);
  chmodSync(blockedDirectory, 0o500);
  try {
    assert.throws(() => applyPendingDatabaseRestore(blockedActivePath, 987654321), /EACCES|EPERM|permission|readonly/i);
  } finally {
    chmodSync(blockedDirectory, 0o700);
  }
  assert.equal(existsSync(blockedActivePath), true);
  assert.equal(existsSync(blockedPendingPath), true);
  const blockedSurvivor = new Database(blockedActivePath, { readonly: true });
  assert.equal(blockedSurvivor.prepare('SELECT marker FROM state').pluck().get(), 'must-survive');
  blockedSurvivor.close();

  const pendingPath = await stageDatabaseRestore(candidatePath, activePath);
  assert.equal(pendingPath, getPendingRestorePath(activePath));
  assert.equal(existsSync(pendingPath), true);

  const beforeRestart = new Database(activePath, { readonly: true });
  assert.equal(beforeRestart.prepare('SELECT marker FROM state').pluck().get(), 'active');
  beforeRestart.close();

  const applied = applyPendingDatabaseRestore(activePath, 1234567890);
  assert.equal(applied.restored, activePath);
  assert.equal(existsSync(pendingPath), false);
  assert.equal(existsSync(`${activePath}-wal`), false);
  assert.equal(existsSync(`${activePath}-shm`), false);
  assert.equal(statSync(activePath).mode & 0o777, 0o600);
  assert.equal(statSync(applied.previousSavedAs).mode & 0o777, 0o600);

  const restored = new Database(activePath, { readonly: true });
  assert.equal(restored.prepare('SELECT marker FROM state').pluck().get(), 'restored');
  restored.close();

  const previous = new Database(applied.previousSavedAs, { readonly: true });
  assert.equal(previous.prepare('SELECT marker FROM state').pluck().get(), 'active');
  previous.close();

  for (const timestamp of [1, 2, 3, 4, 5]) {
    writeFileSync(resolve(fixture, `redman-pre-restore-${timestamp}.db`), 'fixture');
    writeFileSync(resolve(fixture, `redman-pre-restore-${timestamp}.db-wal`), 'fixture');
    statSync(resolve(fixture, `redman-pre-restore-${timestamp}.db`));
  }
  assert.equal(rotatePreRestoreCopies(activePath, 3), 6);
  assert.equal(existsSync(resolve(fixture, 'redman-pre-restore-1.db')), false);
  assert.equal(existsSync(resolve(fixture, 'redman-pre-restore-3.db')), false);
  assert.equal(existsSync(resolve(fixture, 'redman-pre-restore-4.db')), true);
  assert.equal(statSync(resolve(fixture, 'redman-pre-restore-4.db')).mode & 0o777, 0o600);

  // Backups are staged beside the live database and only copied to the (slow)
  // destination once validated, so neither directory keeps temporary residue.
  const liveDirectory = resolve(fixture, 'staged-live');
  const remoteDirectory = resolve(fixture, 'staged-remote');
  mkdirSync(liveDirectory, { recursive: true });
  const stagedLive = createDatabase(resolve(liveDirectory, 'redman.db'), 'staged', 200);
  const stagedBackupPath = resolve(remoteDirectory, 'redman-staged.db');
  await createOnlineDatabaseBackup(stagedLive, stagedBackupPath);
  assert.deepEqual(readdirSync(remoteDirectory), ['redman-staged.db']);
  assert.equal(readdirSync(liveDirectory).some(entry => entry.endsWith('.tmp')), false);
  assert.equal(statSync(stagedBackupPath).mode & 0o777, 0o600);
  assert.equal(await validateSqliteDatabaseAsync(stagedBackupPath), true);

  const cancelledBackup = new AbortController();
  cancelledBackup.abort(new Error('backup cancelled'));
  await assert.rejects(
    createOnlineDatabaseBackup(stagedLive, resolve(remoteDirectory, 'redman-cancelled.db'), { signal: cancelledBackup.signal }),
    /backup cancelled/,
  );
  assert.equal(existsSync(resolve(remoteDirectory, 'redman-cancelled.db')), false);
  assert.equal(readdirSync(remoteDirectory).some(entry => entry.endsWith('.tmp')), false);
  assert.equal(readdirSync(liveDirectory).some(entry => entry.endsWith('.tmp')), false);
  stagedLive.close();

  console.log('WAL-safe database backup and staged restore: passed');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
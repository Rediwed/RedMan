import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildMediaImportLedger,
  deleteVerifiedMediaSources,
  persistMediaImportLedger,
} from '../app/backend/src/services/mediaImportLedger.js';

const require = createRequire(resolve(import.meta.dirname, '../app/package.json'));
const Database = require('better-sqlite3');
const fixture = resolve(import.meta.dirname, 'data', `media-ledger-${process.pid}`);
const mountPath = resolve(fixture, 'drive');
const logPath = resolve(fixture, 'run.log');
mkdirSync(mountPath, { recursive: true });

const successful = Array.from({ length: 6 }, (_, index) => `ok-${index}.jpg`);
const failed = Array.from({ length: 4 }, (_, index) => `failed-${index}.jpg`);
for (const file of [...successful, ...failed]) writeFileSync(resolve(mountPath, file), file);
writeFileSync(logPath, [
  ...successful.slice(0, 4).map(file => `INF uploaded successfully file=Drive:${file}`),
  ...successful.slice(4).map(file => `INF server has duplicate file=Drive:${file}`),
  ...failed.map(file => `ERR server error file=Drive:${file} error=upload rejected`),
].join('\n'));

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE backup_runs (id INTEGER PRIMARY KEY);
  CREATE TABLE backup_run_files (
    id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL, file_path TEXT NOT NULL,
    action TEXT NOT NULL, size INTEGER, error TEXT, file_date TEXT
  );
  CREATE TABLE media_import_ledger (
    id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL, source_path TEXT NOT NULL,
    outcome TEXT NOT NULL, source_size INTEGER, source_mtime TEXT,
    source_sha256 TEXT, error TEXT, verified_at TEXT, deleted_at TEXT,
    deletion_error TEXT, UNIQUE(run_id, source_path)
  );
  INSERT INTO backup_runs VALUES (1);
`);

try {
  const entries = await buildMediaImportLedger([logPath], mountPath);
  assert.equal(entries.length, 10);
  persistMediaImportLedger(db, 1, entries);

  writeFileSync(resolve(mountPath, successful[0]), 'changed after upload');
  const result = await deleteVerifiedMediaSources(db, 1, mountPath);
  assert.deepEqual(result, { deleted: 5, preserved: 1, candidates: 6 });

  for (const file of successful.slice(1)) assert.equal(existsSync(resolve(mountPath, file)), false);
  assert.equal(existsSync(resolve(mountPath, successful[0])), true);
  for (const file of failed) assert.equal(existsSync(resolve(mountPath, file)), true);
  assert.equal(db.prepare('SELECT COUNT(*) FROM media_import_ledger WHERE deleted_at IS NOT NULL').pluck().get(), 5);
  assert.equal(db.prepare('SELECT COUNT(*) FROM media_import_ledger WHERE deletion_error IS NOT NULL').pluck().get(), 1);
  assert.equal(db.prepare("SELECT COUNT(*) FROM media_import_ledger WHERE outcome = 'error'").pluck().get(), 4);

  console.log('Media import ledger: 6 verified, 4 failed, only safe files deleted');
} finally {
  db.close();
  rmSync(fixture, { recursive: true, force: true });
}
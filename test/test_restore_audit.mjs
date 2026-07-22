import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const fixture = resolve(import.meta.dirname, 'data', `restore-audit-${process.pid}`);
const source = resolve(fixture, 'source');
const destination = resolve(fixture, 'destination');
mkdirSync(source, { recursive: true });
mkdirSync(destination, { recursive: true });
writeFileSync(resolve(source, 'document.txt'), 'old');
writeFileSync(resolve(destination, 'document.txt'), 'protected revision');
process.env.DB_PATH = resolve(fixture, 'redman.db');

const { default: db } = await import('../app/backend/src/db.js');
const { restoreFile } = await import('../app/backend/src/services/versionBrowser.js');

try {
  const config = db.prepare(`
    INSERT INTO ssd_backup_configs (name, source_path, dest_path) VALUES (?, ?, ?)
  `).run('Restore audit fixture', source, destination);
  const result = await restoreFile(Number(config.lastInsertRowid), '2026-07-17T12-00-00', 'document.txt', { verify: true });
  assert.equal(result.verified, true);
  assert.equal(readFileSync(resolve(source, 'document.txt'), 'utf8'), 'protected revision');

  const event = db.prepare('SELECT * FROM restore_events WHERE id = ?').get(result.restoreEventId);
  assert.equal(event.status, 'verified');
  assert.ok(event.verified_at);
  assert.equal(event.snapshot_timestamp, '2026-07-17T12-00-00');

  const blockedSource = resolve(source, 'blocked');
  const blockedDestination = resolve(destination, 'blocked');
  mkdirSync(blockedSource, { recursive: true });
  mkdirSync(blockedDestination, { recursive: true });
  writeFileSync(resolve(blockedSource, 'document.txt'), 'current revision must survive');
  writeFileSync(resolve(blockedDestination, 'document.txt'), 'restored revision');
  chmodSync(blockedSource, 0o500);
  try {
    await assert.rejects(
      restoreFile(Number(config.lastInsertRowid), '2026-07-17T12-00-00', 'blocked/document.txt', { verify: true }),
      /EACCES|EPERM|permission/i,
    );
  } finally {
    chmodSync(blockedSource, 0o700);
  }
  assert.equal(readFileSync(resolve(blockedSource, 'document.txt'), 'utf8'), 'current revision must survive');
  const failedEvent = db.prepare('SELECT * FROM restore_events ORDER BY id DESC LIMIT 1').get();
  assert.equal(failedEvent.status, 'failed');

  console.log('Restore audit: atomic verified replacement and failure preservation passed');
} finally {
  db.close();
  rmSync(fixture, { recursive: true, force: true });
}
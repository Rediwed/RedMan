import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const fixture = resolve(import.meta.dirname, 'data', `restore-drill-${process.pid}`);
const source = resolve(fixture, 'source');
const destination = resolve(fixture, 'destination');
const drill = resolve(fixture, 'drill');
const snapshot = '2026-08-01T00-00-00';
const requested = '2026-07-31T00-00-00';

mkdirSync(source, { recursive: true });
mkdirSync(resolve(destination, '.versions', snapshot), { recursive: true });
mkdirSync(drill, { recursive: true });

// Newest state lives at the destination root; the older revision sits in the snapshot.
writeFileSync(resolve(destination, 'notes.txt'), 'revision-3');
writeFileSync(resolve(destination, '.versions', snapshot, 'notes.txt'), 'revision-1');
writeFileSync(resolve(source, 'notes.txt'), 'live source');

process.env.DB_PATH = resolve(fixture, 'redman.db');
process.env.REDMAN_STORAGE_ROOTS = fixture;
process.env.REDMAN_MEDIA_ROOT = fixture;

const { default: db } = await import('../app/backend/src/db.js');
const { restoreFile } = await import('../app/backend/src/services/versionBrowser.js');

try {
  const inserted = db.prepare(`
    INSERT INTO ssd_backup_configs (name, source_path, dest_path) VALUES (?, ?, ?)
  `).run('Restore drill', source, destination);
  const configId = Number(inserted.lastInsertRowid);

  const drilled = await restoreFile(configId, requested, 'notes.txt', { destinationRoot: drill });
  assert.equal(drilled.verified, true);
  assert.equal(drilled.overwroteSource, false);
  assert.equal(drilled.to, resolve(drill, 'notes.txt'));
  assert.equal(readFileSync(resolve(drill, 'notes.txt'), 'utf8'), 'revision-1');

  // The whole point of a drill: recovery is proven and live data is left alone.
  assert.equal(readFileSync(resolve(source, 'notes.txt'), 'utf8'), 'live source');
  assert.equal(readFileSync(resolve(destination, 'notes.txt'), 'utf8'), 'revision-3');

  const event = db.prepare('SELECT * FROM restore_events ORDER BY id DESC LIMIT 1').get();
  assert.equal(event.status, 'verified');
  assert.ok(event.verified_at);
  assert.equal(event.restored_to, resolve(drill, 'notes.txt'));

  await assert.rejects(
    restoreFile(configId, requested, 'notes.txt', { destinationRoot: '/etc' }),
    /outside the folders RedMan may write to/,
  );
  await assert.rejects(
    restoreFile(configId, requested, 'notes.txt', { destinationRoot: destination }),
    /overlaps the backup destination/,
  );
  await assert.rejects(
    restoreFile(configId, requested, 'notes.txt', { destinationRoot: resolve(fixture, 'absent') }),
    /Restore folder does not exist/,
  );
  await assert.rejects(
    restoreFile(configId, requested, 'notes.txt', { destinationRoot: 'relative/path' }),
    /absolute path/,
  );
  await assert.rejects(
    restoreFile(configId, requested, '../escape.txt', { destinationRoot: drill }),
    /outside the backup root/,
  );

  // A failed drill must not leave a half-written file behind.
  assert.equal(readFileSync(resolve(drill, 'notes.txt'), 'utf8'), 'revision-1');

  // Without a drill folder the restore still overwrites the source, as before.
  const overwritten = await restoreFile(configId, requested, 'notes.txt');
  assert.equal(overwritten.overwroteSource, true);
  assert.equal(readFileSync(resolve(source, 'notes.txt'), 'utf8'), 'revision-1');

  console.log('Restore drill: alternate destination verified, source untouched, unsafe folders rejected');
} finally {
  db.close();
  rmSync(fixture, { recursive: true, force: true });
}

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const fixture = resolve(import.meta.dirname, 'data', `restore-drill-folder-${process.pid}`);
const source = resolve(fixture, 'source');
const destination = resolve(fixture, 'destination');
const drill = resolve(fixture, 'drill');
const snapshot = '2026-08-01T00-00-00';
const requested = '2026-07-31T00-00-00';

mkdirSync(resolve(source, 'letters'), { recursive: true });
mkdirSync(resolve(destination, 'letters', 'archive'), { recursive: true });
mkdirSync(resolve(destination, '.versions', snapshot, 'letters'), { recursive: true });
mkdirSync(drill, { recursive: true });

// Current destination state, plus one file whose older revision lives in the snapshot.
writeFileSync(resolve(destination, 'letters', 'one.txt'), 'one-new');
writeFileSync(resolve(destination, 'letters', 'two.txt'), 'two-unchanged');
writeFileSync(resolve(destination, 'letters', 'archive', 'three.txt'), 'three-unchanged');
writeFileSync(resolve(destination, '.versions', snapshot, 'letters', 'one.txt'), 'one-old');

// Live source must survive the drill untouched.
writeFileSync(resolve(source, 'letters', 'one.txt'), 'live one');

process.env.DB_PATH = resolve(fixture, 'redman.db');
process.env.REDMAN_STORAGE_ROOTS = fixture;
process.env.REDMAN_MEDIA_ROOT = fixture;

const { default: db } = await import('../app/backend/src/db.js');
const { startRestoreDrill, getActiveRestoreDrill } = await import('../app/backend/src/services/restoreDrill.js');

const settled = async (runId) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    const run = db.prepare('SELECT * FROM backup_runs WHERE id = ?').get(runId);
    if (run && run.status !== 'running') return run;
    await new Promise(done => setTimeout(done, 25));
  }
  throw new Error('Restore drill did not settle');
};

try {
  const inserted = db.prepare(`
    INSERT INTO ssd_backup_configs (name, source_path, dest_path) VALUES (?, ?, ?)
  `).run('Folder drill', source, destination);
  const configId = Number(inserted.lastInsertRowid);

  const started = startRestoreDrill(configId, { timestamp: requested, path: 'letters', destinationRoot: drill });
  assert.equal(started.existing, false);
  assert.ok(getActiveRestoreDrill(started.runId));

  const run = await settled(started.runId);
  assert.equal(run.status, 'completed');
  assert.equal(run.feature, 'restore-drill');
  assert.equal(run.files_total, 3);
  assert.equal(run.files_copied, 3);
  assert.equal(run.files_failed, 0);

  // The whole tree came back, including the nested folder and the older revision.
  assert.equal(readFileSync(resolve(drill, 'letters/one.txt'), 'utf8'), 'one-old');
  assert.equal(readFileSync(resolve(drill, 'letters/two.txt'), 'utf8'), 'two-unchanged');
  assert.equal(readFileSync(resolve(drill, 'letters/archive/three.txt'), 'utf8'), 'three-unchanged');

  // The point of a drill: nothing live was touched.
  assert.equal(readFileSync(resolve(source, 'letters/one.txt'), 'utf8'), 'live one');
  assert.equal(readFileSync(resolve(destination, 'letters/one.txt'), 'utf8'), 'one-new');

  // One audit row for the folder, not one per file.
  const events = db.prepare('SELECT * FROM restore_events').all();
  assert.equal(events.length, 1);
  assert.equal(events[0].status, 'verified');
  assert.equal(events[0].file_path, 'letters');
  assert.equal(events[0].restored_to, drill);

  assert.throws(
    () => startRestoreDrill(configId, { timestamp: requested, path: '', destinationRoot: destination }),
    /overlaps the backup destination/,
  );
  assert.throws(
    () => startRestoreDrill(configId, { timestamp: requested, path: '', destinationRoot: source }),
    /must differ from the backup source/,
  );
  assert.throws(
    () => startRestoreDrill(configId, { timestamp: requested, path: '../escape', destinationRoot: drill }),
    /outside the backup root/,
  );

  console.log('Folder restore drill: whole tree verified into a scratch folder, live data untouched');
} finally {
  db.close();
  rmSync(fixture, { recursive: true, force: true });
}

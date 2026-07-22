import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const fixture = resolve(import.meta.dirname, 'data', `version-verification-${process.pid}`);
mkdirSync(fixture, { recursive: true });
process.env.DB_PATH = resolve(fixture, 'redman.db');

const { default: db } = await import('../app/backend/src/db.js');
const {
  getActiveVersionVerification,
  startVersionVerification,
  stopActiveVersionVerifications,
} = await import('../app/backend/src/services/versionVerification.js');

try {
  const config = db.prepare(`
    INSERT INTO ssd_backup_configs (name, source_path, dest_path) VALUES (?, ?, ?)
  `).run('Verification test', fixture, fixture);
  const started = startVersionVerification(Number(config.lastInsertRowid));
  assert.equal(started.status, 'running');
  assert.equal(started.existing, false);

  await stopActiveVersionVerifications();
  const run = db.prepare('SELECT * FROM backup_runs WHERE id = ?').get(started.runId);
  assert.ok(['completed', 'cancelled'].includes(run.status));
  assert.equal(getActiveVersionVerification(started.runId), null);
  console.log('Background version verification: lifecycle and shutdown passed');
} finally {
  db.close();
  rmSync(fixture, { recursive: true, force: true });
}
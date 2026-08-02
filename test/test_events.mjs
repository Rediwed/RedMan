// Verifies the event history contract: what happened is recorded independently
// of whether it was delivered, progress noise stays out, and filters work.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const require = createRequire(resolve(import.meta.dirname, '../app/package.json'));
const Database = require('better-sqlite3');

const dir = mkdtempSync(join(tmpdir(), 'redman-events-'));
const dbPath = join(dir, 'test.db');
process.env.DB_PATH = dbPath;

const { runMigrations } = await import('../app/backend/src/migrations.js');
const bootstrap = new Database(dbPath);
runMigrations(bootstrap);
bootstrap.close();

// Imported after DB_PATH is set so the shared db.js opens the temp database.
const events = await import('../app/backend/src/services/events.js');
const notify = await import('../app/backend/src/services/notify.js');
const { pruneDatabaseTelemetry } = await import('../app/backend/src/services/databaseRetention.js');
const db = (await import('../app/backend/src/db.js')).default;

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

const setSetting = (key, value) =>
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);

check('an event is recorded with derived category and severity', () => {
  events.recordEvent('job_error', { title: 'Nightly — Failed', body: 'disk full', subject: 'Nightly' });
  const row = db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.type, 'job_error');
  assert.equal(row.category, 'backup');
  assert.equal(row.severity, 'error');
  assert.equal(row.subject, 'Nightly');
});

check('progress updates are never recorded', () => {
  const before = db.prepare('SELECT COUNT(*) AS c FROM events').get().c;
  events.recordEvent('job_progress', { title: '42%' });
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM events').get().c, before);
});

check('history survives with every delivery channel switched off', () => {
  setSetting('ntfy_enabled', 'false');
  setSetting('browser_notify_enabled', 'false');
  const before = db.prepare('SELECT COUNT(*) AS c FROM events').get().c;
  notify.notifyJobError('ssd-backup', 'Silent job', 'source unreachable');
  const after = db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 1').get();
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM events').get().c, before + 1);
  assert.equal(after.subject, 'Silent job');
  assert.equal(after.severity, 'error');
});

check('an unknown type falls back to priority-derived severity', () => {
  events.recordEvent('something_new', { title: 'Custom', priority: '4' });
  const row = db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.category, 'system');
  assert.equal(row.severity, 'error');
});

check('detail survives a round trip as structured data', () => {
  events.recordEvent('job_completed', { title: 'Done', detail: { files: 12, bytes: 3456 } });
  const listed = events.listEvents({ type: 'job_completed' });
  assert.deepEqual(listed.events[0].detail, { files: 12, bytes: 3456 });
});

check('filtering by severity and category narrows the result', () => {
  const errors = events.listEvents({ severity: 'error' });
  assert.ok(errors.total >= 3);
  assert.ok(errors.events.every(e => e.severity === 'error'));
  const backup = events.listEvents({ category: 'backup' });
  assert.ok(backup.events.every(e => e.category === 'backup'));
});

check('the summary reports counts and the most recent issue', () => {
  const summary = events.getEventSummary();
  assert.ok(summary.bySeverity.error >= 3);
  assert.ok(summary.latestIssue);
  assert.ok(['warning', 'error'].includes(summary.latestIssue.severity));
});

check('a logging failure never propagates to the caller', () => {
  db.exec('ALTER TABLE events RENAME TO events_hidden');
  assert.equal(events.recordEvent('job_error', { title: 'while broken' }), null);
  assert.doesNotThrow(() => notify.notifyJobError('ssd-backup', 'Job', 'error'));
  db.exec('ALTER TABLE events_hidden RENAME TO events');
});

check('retention removes old events but respects the batch limit', () => {
  db.prepare("UPDATE events SET created_at = datetime('now', '-200 days')").run();
  const removed = pruneDatabaseTelemetry(db, {}, { batchSize: 1_000 });
  assert.ok(removed.events > 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM events').get().c, 0);
});

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} event history checks passed`);

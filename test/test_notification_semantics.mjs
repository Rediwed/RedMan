import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const fixture = resolve(import.meta.dirname, 'data', `notification-semantics-${process.pid}`);
mkdirSync(fixture, { recursive: true });
process.env.DB_PATH = resolve(fixture, 'redman.db');

const { default: db } = await import('../app/backend/src/db.js');
const {
  addBrowserSubscriber,
  notifyBackupResult,
  removeBrowserSubscriber,
  shouldNotify,
} = await import('../app/backend/src/services/notify.js');

try {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('browser_notify_enabled', 'true')").run();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ntfy_on_job_error', 'true')").run();
  const events = [];
  const subscriber = addBrowserSubscriber(event => events.push(JSON.parse(event)));
  await notifyBackupResult('SSD Backup', 'Fixture', 'partial', {
    filesCopied: 9,
    filesFailed: 1,
  });
  removeBrowserSubscriber(subscriber);

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'job_partial');
  assert.match(events[0].title, /Partially Completed/);
  assert.match(events[0].body, /Files failed: 1/);
  assert.equal(shouldNotify({ notify_mode: 'custom', notify_on_failure: 1 }, 'partial'), true);
  assert.equal(shouldNotify({ notify_mode: 'silent' }, 'cancel'), false);
  console.log('Notification semantics: partial and cancellation policy passed');
} finally {
  db.close();
  rmSync(fixture, { recursive: true, force: true });
}
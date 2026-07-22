import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const fixture = resolve(import.meta.dirname, 'data', `notification-tracker-${process.pid}`);
mkdirSync(fixture, { recursive: true });
process.env.DB_PATH = resolve(fixture, 'redman.db');

const { default: db } = await import('../app/backend/src/db.js');
const {
  addBrowserSubscriber,
  createJobNotificationTracker,
  removeBrowserSubscriber,
} = await import('../app/backend/src/services/notify.js');

try {
  for (const [key, value] of [
    ['browser_notify_enabled', 'true'],
    ['ntfy_on_job_start', 'true'],
    ['ntfy_on_progress', 'true'],
    ['ntfy_progress_interval', '10'],
  ]) db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);

  const events = [];
  const subscriber = addBrowserSubscriber(event => events.push(JSON.parse(event)));
  const tracker = createJobNotificationTracker({
    job: { notify_mode: 'global' }, feature: 'Fixture', name: 'Run', runId: 9, startedAt: 0,
  });
  assert.equal(tracker.start(), true);
  assert.equal(tracker.progress({ percent: 10 }, 9_999), false);
  assert.equal(tracker.progress({ percent: 20 }, 10_000), true);
  assert.equal(tracker.progress({ percent: 30 }, 15_000), false);
  assert.equal(tracker.progress({ percent: 40 }, 20_000), true);
  tracker.close();
  assert.equal(tracker.progress({ percent: 50 }, 30_000), false);
  removeBrowserSubscriber(subscriber);

  assert.deepEqual(events.map(event => event.type), ['job_started', 'job_progress', 'job_progress']);
  console.log('Notification tracker: start, interval rate limit, and terminal cleanup passed');
} finally {
  db.close();
  rmSync(fixture, { recursive: true, force: true });
}
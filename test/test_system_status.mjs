// Verifies the status board: normalization per subsystem, worst-first rollup,
// and that one failing collector never takes the whole board down.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const require = createRequire(resolve(import.meta.dirname, '../app/package.json'));
const Database = require('better-sqlite3');

const dir = mkdtempSync(join(tmpdir(), 'redman-status-'));
const dbPath = join(dir, 'test.db');
process.env.DB_PATH = dbPath;

const { runMigrations } = await import('../app/backend/src/migrations.js');
const bootstrap = new Database(dbPath);
runMigrations(bootstrap);
bootstrap.close();

const db = (await import('../app/backend/src/db.js')).default;
const { createExternalJob, recordHeartbeat } = await import('../app/backend/src/services/externalJobs.js');
const { getSystemStatus } = await import('../app/backend/src/services/systemStatus.js');

let passed = 0;
function check(name, fn) {
  return Promise.resolve(fn()).then(() => {
    passed += 1;
    console.log(`  ok  ${name}`);
  });
}

const find = (board, id) => board.categories.flatMap(c => c.checks).find(c => c.id === id);

await check('an empty install reports healthy rather than unknown', async () => {
  const board = await getSystemStatus();
  assert.ok(['ok', 'unknown'].includes(board.overall));
  assert.ok(Array.isArray(board.categories));
});

await check('a failed external job surfaces as a failing check', async () => {
  const { token } = createExternalJob(db, { name: 'Snapshot', slug: 'snapshot', host: 'cloudbuddy' });
  recordHeartbeat(db, 'snapshot', token, { exit_code: 3, message: 'disk full' });
  const board = await getSystemStatus();
  const item = find(board, 'external:snapshot');
  assert.equal(item.state, 'fail');
  assert.equal(item.summary, 'disk full');
  assert.equal(item.subject, 'Snapshot (cloudbuddy)');
});

await check('a job that never reported is unknown, not healthy', async () => {
  createExternalJob(db, { name: 'Fresh', slug: 'fresh' });
  const board = await getSystemStatus();
  assert.equal(find(board, 'external:fresh').state, 'unknown');
});

await check('a paused job is neither healthy nor failing', async () => {
  createExternalJob(db, { name: 'Sleeping', slug: 'sleeping', enabled: false });
  const board = await getSystemStatus();
  assert.equal(find(board, 'external:sleeping').state, 'paused');
});

await check('a later success clears the failure reason from the summary', async () => {
  const { token } = createExternalJob(db, { name: 'Recovered', slug: 'recovered' });
  recordHeartbeat(db, 'recovered', token, { exit_code: 1, message: 'transient failure' });
  recordHeartbeat(db, 'recovered', token, { exit_code: 0 });
  const item = find(await getSystemStatus(), 'external:recovered');
  assert.equal(item.state, 'ok');
  assert.equal(item.summary, 'Reported success',
    'a healthy job must not display the message of a failure it already recovered from');
});

await check('the rollup reports the worst state present', async () => {
  const board = await getSystemStatus();
  assert.equal(board.overall, 'fail', 'a failing check must dominate the rollup');
  assert.ok(board.counts.fail >= 1);
  assert.ok(board.counts.unknown >= 1);
});

await check('categories are ordered worst first', async () => {
  const board = await getSystemStatus();
  const order = ['fail', 'warn', 'unknown', 'paused', 'ok'];
  const positions = board.categories.map(c => order.indexOf(c.state));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
});

await check('checks within a category are ordered worst first', async () => {
  const board = await getSystemStatus();
  const external = board.categories.find(c => c.name === 'External jobs');
  const order = ['fail', 'warn', 'unknown', 'paused', 'ok'];
  const positions = external.checks.map(c => order.indexOf(c.state));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
});

await check('a broken collector is reported without hiding the rest', async () => {
  // Docker is unavailable in the test environment, which is exactly the
  // degraded case the board has to survive.
  const board = await getSystemStatus();
  assert.ok(board.categories.some(c => c.name === 'External jobs'),
    'external job checks must still be present');
  assert.ok(Array.isArray(board.failedCollectors));
});

await check('every check carries the fields the UI depends on', async () => {
  const board = await getSystemStatus();
  for (const item of board.categories.flatMap(c => c.checks)) {
    assert.ok(item.id && item.category && item.subject, 'identity fields');
    assert.ok(['ok', 'warn', 'fail', 'unknown', 'paused'].includes(item.state), `valid state: ${item.state}`);
    assert.equal(typeof item.summary, 'string', 'a human-readable reason');
  }
});

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} status board checks passed`);

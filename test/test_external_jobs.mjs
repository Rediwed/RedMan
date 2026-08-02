// Verifies the external job heartbeat contract end to end against a temp DB:
// token auth, status inference, overdue detection, grace period, and retention.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const require = createRequire(resolve(import.meta.dirname, '../app/package.json'));
const Database = require('better-sqlite3');

import { runMigrations } from '../app/backend/src/migrations.js';
import {
  createExternalJob,
  recordHeartbeat,
  getExternalJob,
  listExternalJobs,
  regenerateIngestToken,
  pruneExternalJobRuns,
  listExternalJobRuns,
} from '../app/backend/src/services/externalJobs.js';

const dir = mkdtempSync(join(tmpdir(), 'redman-extjobs-'));
const db = new Database(join(dir, 'test.db'));
db.pragma('foreign_keys = ON');
runMigrations(db);

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

const { job, token } = createExternalJob(db, {
  name: 'Cloudbuddy OS snapshot',
  slug: 'cloudbuddy-snapshot',
  host: 'cloudbuddy',
  cron_expression: '0 3 * * 0',
  grace_seconds: 3600,
});

check('creating a job returns a token exactly once', () => {
  assert.ok(token && token.length > 20);
  assert.equal(job.slug, 'cloudbuddy-snapshot');
  assert.equal(job.health.neverReported, true);
});

check('the token hash is never exposed through the API shape', () => {
  assert.equal('ingest_token_hash' in job, false);
  assert.equal(listExternalJobs(db).some(j => 'ingest_token_hash' in j), false);
});

check('a wrong token is rejected', () => {
  assert.equal(recordHeartbeat(db, 'cloudbuddy-snapshot', 'not-the-token', {}), null);
});

check('an unknown slug is rejected the same way as a bad token', () => {
  assert.equal(recordHeartbeat(db, 'does-not-exist', token, {}), null);
});

check('exit code 0 is recorded as completed', () => {
  const result = recordHeartbeat(db, 'cloudbuddy-snapshot', token, { exit_code: 0, duration_seconds: 12 });
  assert.equal(result.status, 'completed');
  assert.equal(getExternalJob(db, job.id).health.state, 'healthy');
});

check('a non-zero exit code flips the job to attention', () => {
  recordHeartbeat(db, 'cloudbuddy-snapshot', token, { exit_code: 2, message: 'snapshot failed' });
  const health = getExternalJob(db, job.id).health;
  assert.equal(health.state, 'attention');
  assert.equal(health.lastIssue.exit_code, 2);
});

check('a later success clears the attention state', () => {
  recordHeartbeat(db, 'cloudbuddy-snapshot', token, { exit_code: 0 });
  assert.equal(getExternalJob(db, job.id).health.state, 'healthy');
});

check('a job that missed its window is reported overdue', () => {
  const stale = createExternalJob(db, {
    name: 'Stale daily job', slug: 'stale-daily', cron_expression: '0 4 * * *', grace_seconds: 0,
  });
  recordHeartbeat(db, 'stale-daily', stale.token, { exit_code: 0 });
  db.prepare("UPDATE external_job_runs SET reported_at = datetime('now', '-3 days') WHERE job_id = ?")
    .run(stale.job.id);
  const health = getExternalJob(db, stale.job.id).health;
  assert.equal(health.stale, true);
  assert.equal(health.state, 'attention');
  assert.ok(health.overdueSince);
});

check('the grace period suppresses a marginally late report', () => {
  const lenient = createExternalJob(db, {
    name: 'Lenient job', slug: 'lenient', cron_expression: '*/10 * * * *', grace_seconds: 86_400,
  });
  recordHeartbeat(db, 'lenient', lenient.token, { exit_code: 0 });
  db.prepare("UPDATE external_job_runs SET reported_at = datetime('now', '-30 minutes') WHERE job_id = ?")
    .run(lenient.job.id);
  assert.equal(getExternalJob(db, lenient.job.id).health.stale, false);
});

check('a job without a schedule is never called overdue', () => {
  const adhoc = createExternalJob(db, { name: 'Ad hoc', slug: 'ad-hoc' });
  recordHeartbeat(db, 'ad-hoc', adhoc.token, { exit_code: 0 });
  db.prepare("UPDATE external_job_runs SET reported_at = datetime('now', '-400 days') WHERE job_id = ?")
    .run(adhoc.job.id);
  const health = getExternalJob(db, adhoc.job.id).health;
  assert.equal(health.stale, false);
  assert.equal(health.state, 'healthy');
});

check('a disabled job reports as paused', () => {
  const paused = createExternalJob(db, {
    name: 'Paused', slug: 'paused-job', cron_expression: '0 * * * *', enabled: false,
  });
  assert.equal(getExternalJob(db, paused.job.id).health.state, 'paused');
});

check('regenerating the token invalidates the old one', () => {
  const fresh = regenerateIngestToken(db, job.id);
  assert.ok(fresh && fresh !== token);
  assert.equal(recordHeartbeat(db, 'cloudbuddy-snapshot', token, {}), null);
  assert.ok(recordHeartbeat(db, 'cloudbuddy-snapshot', fresh, { exit_code: 0 }));
});

check('retention keeps the newest run per job', () => {
  const before = listExternalJobRuns(db, { jobId: job.id }).total;
  assert.ok(before > 1);
  db.prepare("UPDATE external_job_runs SET reported_at = datetime('now', '-200 days') WHERE job_id = ?")
    .run(job.id);
  pruneExternalJobRuns(db, { days: 90 });
  const after = listExternalJobRuns(db, { jobId: job.id });
  assert.equal(after.total, 1, 'exactly the most recent run survives');
  assert.equal(getExternalJob(db, job.id).health.neverReported, false);
});

check('deleting a job cascades to its runs', () => {
  const doomed = createExternalJob(db, { name: 'Doomed', slug: 'doomed' });
  recordHeartbeat(db, 'doomed', doomed.token, { exit_code: 0 });
  db.prepare('DELETE FROM external_jobs WHERE id = ?').run(doomed.job.id);
  const orphans = db.prepare('SELECT COUNT(*) AS c FROM external_job_runs WHERE job_id = ?')
    .get(doomed.job.id).c;
  assert.equal(orphans, 0);
});

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} external job heartbeat checks passed`);

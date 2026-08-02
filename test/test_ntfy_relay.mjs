// Verifies the ntfy relay contract: how a line on the topic becomes a heartbeat,
// and — more importantly — when it must not.

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
  hashIngestToken,
  signRelayedHeartbeat,
  recordRelayedHeartbeat,
  getExternalJob,
} from '../app/backend/src/services/externalJobs.js';
import { parseRelayMessage, RELAY_PREFIX } from '../app/backend/src/services/ntfyRelay.js';

const dir = mkdtempSync(join(tmpdir(), 'redman-relay-'));
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
  name: 'CrowdSec health',
  slug: 'cloudbuddy-crowdsec-health',
  host: 'cloudbuddy',
  cron_expression: '*/10 * * * *',
  grace_seconds: 900,
});

const key = hashIngestToken(token);
const nowSeconds = () => Math.floor(Date.now() / 1000);

function signed(overrides = {}) {
  const fields = {
    slug: 'cloudbuddy-crowdsec-health',
    ts: nowSeconds(),
    exitCode: 0,
    duration: 4,
    message: 'all decisions applied',
    ...overrides,
  };
  return { ...fields, signature: signRelayedHeartbeat(key, fields) };
}

// ── Wire format ────────────────────────────────────────────────────

check('a well-formed line parses into its fields', () => {
  const parsed = parseRelayMessage(`${RELAY_PREFIX} my-job 1785690000 0 12 abc123 hello world`);
  assert.deepEqual(parsed, {
    slug: 'my-job',
    ts: 1785690000,
    exitCode: 0,
    duration: 12,
    signature: 'abc123',
    message: 'hello world',
  });
});

check('a message may contain spaces without escaping', () => {
  const parsed = parseRelayMessage(`${RELAY_PREFIX} j 1 0 1 sig pruned 4 images, freed 1.2 GB`);
  assert.equal(parsed.message, 'pruned 4 images, freed 1.2 GB');
});

check('absent exit code and duration are carried as null', () => {
  const parsed = parseRelayMessage(`${RELAY_PREFIX} j 1 - - sig `);
  assert.equal(parsed.exitCode, null);
  assert.equal(parsed.duration, null);
});

check('unrelated topic traffic is ignored rather than misread', () => {
  assert.equal(parseRelayMessage('Backup finished successfully'), null);
  assert.equal(parseRelayMessage(`${RELAY_PREFIX}-lookalike j 1 0 1 sig m`), null);
  assert.equal(parseRelayMessage(`${RELAY_PREFIX} too few fields`), null);
  assert.equal(parseRelayMessage(null), null);
});

check('a non-numeric exit code is rejected, not coerced to zero', () => {
  assert.equal(parseRelayMessage(`${RELAY_PREFIX} j 1 ok 1 sig m`), null);
});

// ── Verification ───────────────────────────────────────────────────

check('a correctly signed heartbeat is recorded', () => {
  const result = recordRelayedHeartbeat(db, { ...signed(), sourceRef: 'ntfy:t:aaa' });
  assert.equal(result.ok, true);
  assert.equal(result.duplicate, false);
  assert.equal(result.status, 'completed');
  assert.equal(getExternalJob(db, job.id).health.neverReported, false);
});

check('a forged signature is refused', () => {
  const result = recordRelayedHeartbeat(db, {
    ...signed({ exitCode: 0, message: 'all fine' }),
    signature: 'f'.repeat(64),
    sourceRef: 'ntfy:t:forged',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'bad-signature');
});

check('changing a signed field invalidates the signature', () => {
  const honest = signed({ exitCode: 1, message: 'crowdsec down' });
  // Someone on the topic flips a failure into a success but keeps the signature.
  const tampered = { ...honest, exitCode: 0, message: 'all good', sourceRef: 'ntfy:t:tampered' };
  const result = recordRelayedHeartbeat(db, tampered);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'bad-signature');
});

check('a signature from another job does not authenticate this one', () => {
  const other = createExternalJob(db, { name: 'Other', slug: 'other-job' });
  const otherKey = hashIngestToken(other.token);
  const fields = { slug: 'cloudbuddy-crowdsec-health', ts: nowSeconds(), exitCode: 0, duration: 1, message: 'x' };
  const result = recordRelayedHeartbeat(db, {
    ...fields,
    signature: signRelayedHeartbeat(otherKey, fields),
    sourceRef: 'ntfy:t:crosssign',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'bad-signature');
});

check('an unknown slug is refused', () => {
  const fields = { slug: 'no-such-job', ts: nowSeconds(), exitCode: 0, duration: 1, message: '' };
  const result = recordRelayedHeartbeat(db, { ...fields, signature: signRelayedHeartbeat(key, fields) });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unknown-job');
});

check('an old message cannot be replayed onto the topic', () => {
  const stale = signed({ ts: nowSeconds() - 7200 });
  const result = recordRelayedHeartbeat(db, { ...stale, sourceRef: 'ntfy:t:stale' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'stale');
});

check('a timestamp far in the future is refused too', () => {
  const ahead = signed({ ts: nowSeconds() + 7200 });
  const result = recordRelayedHeartbeat(db, { ...ahead, sourceRef: 'ntfy:t:ahead' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'stale');
});

// ── Idempotency ────────────────────────────────────────────────────

check('re-reading the same message does not record it twice', () => {
  const before = db.prepare('SELECT COUNT(*) AS c FROM external_job_runs').get().c;
  const fields = { ...signed({ message: 'second poll' }), sourceRef: 'ntfy:t:repeat' };
  const first = recordRelayedHeartbeat(db, fields);
  const second = recordRelayedHeartbeat(db, fields);
  const after = db.prepare('SELECT COUNT(*) AS c FROM external_job_runs').get().c;
  assert.equal(first.duplicate, false);
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(after, before + 1);
});

check('heartbeats delivered over HTTP keep working without a source reference', () => {
  const plain = createExternalJob(db, { name: 'Plain', slug: 'plain-job' });
  const fields = { slug: 'plain-job', ts: nowSeconds(), exitCode: 0, duration: 1, message: '' };
  recordRelayedHeartbeat(db, { ...fields, signature: signRelayedHeartbeat(hashIngestToken(plain.token), fields) });
  recordRelayedHeartbeat(db, { ...fields, signature: signRelayedHeartbeat(hashIngestToken(plain.token), fields) });
  const nulls = db.prepare(
    'SELECT COUNT(*) AS c FROM external_job_runs WHERE source_ref IS NULL AND job_id = ?'
  ).get(plain.job.id).c;
  // Two rows, both with a NULL reference: the unique index must tolerate that.
  assert.equal(nulls, 2);
});

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} ntfy relay checks passed`);

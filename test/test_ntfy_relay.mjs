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
  recordHeartbeat,
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
  const result = recordRelayedHeartbeat(db, signed());
  assert.equal(result.ok, true);
  assert.equal(result.duplicate, false);
  assert.equal(result.status, 'completed');
  assert.equal(getExternalJob(db, job.id).health.neverReported, false);
});

check('a forged signature is refused', () => {
  const result = recordRelayedHeartbeat(db, {
    ...signed({ exitCode: 0, message: 'all fine' }),
    signature: 'f'.repeat(64),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'bad-signature');
});

check('a signature with a character appended does not verify', () => {
  const honest = signed({ message: 'truncation guard' });
  const result = recordRelayedHeartbeat(db, { ...honest, signature: `${honest.signature}a` });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'bad-signature');
});

check('changing a signed field invalidates the signature', () => {
  const honest = signed({ exitCode: 1, message: 'crowdsec down' });
  // Someone on the topic flips a failure into a success but keeps the signature.
  const tampered = { ...honest, exitCode: 0, message: 'all good' };
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
  const result = recordRelayedHeartbeat(db, signed({ ts: nowSeconds() - 7200 }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'stale');
});

check('a timestamp far in the future is refused too', () => {
  const result = recordRelayedHeartbeat(db, signed({ ts: nowSeconds() + 7200 }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'stale');
});

// ── Idempotency and replay ─────────────────────────────────────────

check('re-reading the same message does not record it twice', () => {
  const before = db.prepare('SELECT COUNT(*) AS c FROM external_job_runs').get().c;
  const fields = signed({ message: 'second poll' });
  const first = recordRelayedHeartbeat(db, fields);
  const second = recordRelayedHeartbeat(db, fields);
  const after = db.prepare('SELECT COUNT(*) AS c FROM external_job_runs').get().c;
  assert.equal(first.duplicate, false);
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(after, before + 1);
});

check('a captured line re-published under a new broker id is still a duplicate', () => {
  // The whole point: an attacker who cannot forge can still copy. Keying
  // de-duplication on the delivering message would let this reset the clock.
  const captured = signed({ ts: nowSeconds() - 30, message: 'captured off the topic' });
  const runsFor = () => db.prepare('SELECT COUNT(*) AS c FROM external_job_runs WHERE job_id = ?')
    .get(job.id).c;

  const genuine = recordRelayedHeartbeat(db, captured);
  const afterGenuine = runsFor();
  const replayed = recordRelayedHeartbeat(db, { ...captured, sourceRef: 'ntfy:topic:a-brand-new-id' });

  assert.equal(genuine.duplicate, false);
  assert.equal(replayed.duplicate, true);
  // No row written is what keeps the overdue clock where it was; comparing
  // last_reported_at would pass either way inside the same second.
  assert.equal(runsFor(), afterGenuine);
});

check('a later genuine run is not mistaken for a replay', () => {
  const first = recordRelayedHeartbeat(db, signed({ ts: nowSeconds() - 20, message: 'run one' }));
  const later = recordRelayedHeartbeat(db, signed({ ts: nowSeconds() - 10, message: 'run one' }));
  assert.equal(first.duplicate, false);
  assert.equal(later.duplicate, false);
});

check('heartbeats delivered over HTTP keep working without a source reference', () => {
  const plain = createExternalJob(db, { name: 'Plain', slug: 'plain-job' });
  recordHeartbeat(db, 'plain-job', plain.token, { exit_code: 0 });
  recordHeartbeat(db, 'plain-job', plain.token, { exit_code: 0 });
  const nulls = db.prepare(
    'SELECT COUNT(*) AS c FROM external_job_runs WHERE source_ref IS NULL AND job_id = ?'
  ).get(plain.job.id).c;
  // Two rows, both with a NULL reference: the unique index must tolerate that.
  assert.equal(nulls, 2);
});

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} ntfy relay checks passed`);

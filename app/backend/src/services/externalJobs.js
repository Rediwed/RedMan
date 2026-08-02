// External job heartbeats — dead man's switch for schedules RedMan does not run
// itself (host cron, systemd timers, container updaters on other machines).
//
// The health model deliberately mirrors services/jobHealth.js so the dashboard
// can render RedMan-owned and external jobs with one vocabulary.

import { randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { nextCronOccurrence } from './schedulePolicy.js';
import { parseDbTime } from './jobHealth.js';
import { recordEvent } from './events.js';

const TOKEN_BYTES = 32;
const MAX_MESSAGE_LENGTH = 500;
const VALID_STATUSES = ['completed', 'failed', 'running'];
// Kept in step with the relay's lookback window: a message older than the window
// will never be re-read anyway, so accepting one only widens the replay door.
const RELAY_MAX_AGE_SECONDS = 900;

export function generateIngestToken() {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hashIngestToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

// Compares hashes rather than raw tokens so the comparison length is fixed.
export function ingestTokenMatches(token, storedHash) {
  if (typeof token !== 'string' || typeof storedHash !== 'string') return false;
  const candidate = Buffer.from(hashIngestToken(token), 'hex');
  const expected = Buffer.from(storedHash, 'hex');
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

export function normaliseSlug(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '-').slice(0, 64);
}

// Number(null) is 0, so an explicitly absent value would otherwise be recorded
// as a real zero — and "no exit code reported" would read as success.
function optionalNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function latestRun(db, jobId, statuses) {
  const placeholders = statuses.map(() => '?').join(', ');
  return db.prepare(`
    SELECT id, status, exit_code, duration_seconds, message, reported_at
    FROM external_job_runs
    WHERE job_id = ? AND status IN (${placeholders})
    ORDER BY datetime(reported_at) DESC, id DESC LIMIT 1
  `).get(jobId, ...statuses) || null;
}

/**
 * Derive health for one external job.
 *
 * A job is only judged late when it declares a schedule. Without a cron
 * expression there is no expectation to miss, so absence stays silent by
 * design rather than producing a permanent false alarm.
 */
export function getExternalJobHealth(db, job, { now = new Date() } = {}) {
  const lastSuccess = latestRun(db, job.id, ['completed']);
  const lastIssue = latestRun(db, job.id, ['failed']);
  const lastRunning = latestRun(db, job.id, ['running']);

  // Heartbeats arriving in the same second share a timestamp, so the insertion
  // order decides which one is newer.
  const isNewer = (a, b) => {
    if (!a) return false;
    if (!b) return true;
    const ta = parseDbTime(a.reported_at);
    const tb = parseDbTime(b.reported_at);
    if (ta === tb) return a.id > b.id;
    return ta > tb;
  };

  const running = isNewer(lastRunning, lastSuccess) && isNewer(lastRunning, lastIssue);

  const graceMs = Math.max(0, Number(job.grace_seconds) || 0) * 1000;
  let nextRun = null;
  let expectedAfterLastSuccess = null;
  let overdueSince = null;

  if (job.cron_expression) {
    try {
      if (job.enabled) nextRun = nextCronOccurrence(job.cron_expression, { currentDate: now });
      const anchor = parseDbTime(lastSuccess?.reported_at ?? job.created_at);
      if (anchor !== null) {
        expectedAfterLastSuccess = nextCronOccurrence(job.cron_expression, {
          currentDate: new Date(anchor),
        });
      }
    } catch {
      // An unparseable schedule surfaces as missing next-run health, matching jobHealth.
    }
  }

  if (expectedAfterLastSuccess) {
    const deadline = Date.parse(expectedAfterLastSuccess) + graceMs;
    if (deadline < now.getTime()) overdueSince = new Date(deadline).toISOString();
  }

  const missedSchedule = !!job.enabled && !running && !!overdueSince;
  const issueAfterSuccess = isNewer(lastIssue, lastSuccess);

  const state = !job.enabled
    ? 'paused'
    : running
      ? 'running'
      : missedSchedule || issueAfterSuccess
        ? 'attention'
        : 'healthy';

  return {
    state,
    stale: missedSchedule,
    neverReported: !lastSuccess && !lastIssue,
    nextRun,
    expectedAfterLastSuccess,
    overdueSince,
    lastSuccess,
    lastIssue,
  };
}

function publicJob(db, job, now) {
  const { ingest_token_hash: _hash, ...rest } = job;
  return { ...rest, enabled: !!job.enabled, health: getExternalJobHealth(db, job, { now }) };
}

export function listExternalJobs(db, { now = new Date() } = {}) {
  const rows = db.prepare('SELECT * FROM external_jobs ORDER BY host IS NULL, host, name').all();
  return rows.map(row => publicJob(db, row, now));
}

export function getExternalJob(db, id, { now = new Date() } = {}) {
  const row = db.prepare('SELECT * FROM external_jobs WHERE id = ?').get(id);
  return row ? publicJob(db, row, now) : null;
}

export function createExternalJob(db, input) {
  const slug = normaliseSlug(input.slug || input.name);
  if (!slug) throw new Error('A slug or name is required');
  const token = generateIngestToken();
  const info = db.prepare(`
    INSERT INTO external_jobs (slug, name, host, cron_expression, grace_seconds, enabled, ingest_token_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    slug,
    String(input.name ?? slug).slice(0, 120),
    input.host ? String(input.host).slice(0, 120) : null,
    input.cron_expression ? String(input.cron_expression) : null,
    Number.isFinite(Number(input.grace_seconds)) ? Math.max(0, Number(input.grace_seconds)) : 900,
    input.enabled === false ? 0 : 1,
    hashIngestToken(token),
  );
  // The raw token is returned exactly once, matching the peer API key convention.
  return { job: getExternalJob(db, info.lastInsertRowid), token };
}

export function updateExternalJob(db, id, input) {
  const existing = db.prepare('SELECT * FROM external_jobs WHERE id = ?').get(id);
  if (!existing) return null;
  db.prepare(`
    UPDATE external_jobs
    SET name = ?, host = ?, cron_expression = ?, grace_seconds = ?, enabled = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    input.name !== undefined ? String(input.name).slice(0, 120) : existing.name,
    input.host !== undefined ? (input.host ? String(input.host).slice(0, 120) : null) : existing.host,
    input.cron_expression !== undefined
      ? (input.cron_expression ? String(input.cron_expression) : null)
      : existing.cron_expression,
    input.grace_seconds !== undefined
      ? Math.max(0, Number(input.grace_seconds) || 0)
      : existing.grace_seconds,
    input.enabled !== undefined ? (input.enabled ? 1 : 0) : existing.enabled,
    id,
  );
  return getExternalJob(db, id);
}

export function deleteExternalJob(db, id) {
  return db.prepare('DELETE FROM external_jobs WHERE id = ?').run(id).changes > 0;
}

export function regenerateIngestToken(db, id) {
  const token = generateIngestToken();
  const changes = db.prepare(`
    UPDATE external_jobs SET ingest_token_hash = ?, updated_at = datetime('now') WHERE id = ?
  `).run(hashIngestToken(token), id).changes;
  return changes > 0 ? token : null;
}

/**
 * Write a heartbeat for a job whose sender has already been authenticated.
 *
 * Authentication lives entirely in the callers, so there is no argument here
 * that could switch it off.
 *
 * A payload may carry `source_ref`, the identity of the message that delivered
 * it. A relay has to re-read an overlapping window to survive a missed poll, so
 * the same heartbeat arrives more than once by design; the reference is what
 * makes recording it idempotent.
 */
function insertHeartbeat(db, job, payload) {
  const sourceRef = payload.source_ref ? String(payload.source_ref).slice(0, 128) : null;
  if (sourceRef && db.prepare('SELECT 1 FROM external_job_runs WHERE source_ref = ?').get(sourceRef)) {
    return { slug: job.slug, status: null, duplicate: true };
  }

  const exitCode = optionalNumber(payload.exit_code);
  const status = VALID_STATUSES.includes(payload.status)
    ? payload.status
    : (exitCode === null || exitCode === 0 ? 'completed' : 'failed');
  const reportedDuration = optionalNumber(payload.duration_seconds);
  const duration = reportedDuration === null ? null : Math.max(0, Math.round(reportedDuration));
  const message = payload.message ? String(payload.message).slice(0, MAX_MESSAGE_LENGTH) : null;

  const previous = latestRun(db, job.id, ['completed', 'failed']);

  try {
    db.transaction(() => {
      db.prepare(`
        INSERT INTO external_job_runs (job_id, status, exit_code, duration_seconds, message, source_ref)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(job.id, status, exitCode, duration, message, sourceRef);
      db.prepare("UPDATE external_jobs SET last_reported_at = datetime('now') WHERE id = ?").run(job.id);
    })();
  } catch (err) {
    // The unique index is the real guard: two overlapping polls can both clear
    // the check above, and only one of them may be allowed to write.
    if (sourceRef && String(err.code || '').includes('SQLITE_CONSTRAINT')) {
      return { slug: job.slug, status: null, duplicate: true };
    }
    throw err;
  }

  // Only transitions are logged; a job reporting success every hour should not
  // fill the timeline with identical entries.
  if (status === 'failed' && previous?.status !== 'failed') {
    recordEvent('external_job_failed', {
      title: `${job.name} — failed`,
      body: message || `Exit code ${exitCode ?? 'unknown'}`,
      subject: job.name,
      detail: { slug: job.slug, host: job.host, exit_code: exitCode },
    });
  } else if (status === 'completed' && previous?.status === 'failed') {
    recordEvent('external_job_recovered', {
      title: `${job.name} — recovered`,
      body: 'Reported success after a previous failure',
      subject: job.name,
      detail: { slug: job.slug, host: job.host },
    });
  }

  return { slug: job.slug, status };
}

/**
 * Record one heartbeat presented with a bearer token. Returns null when the slug
 * is unknown or the token does not match, so callers cannot distinguish the two
 * cases.
 */
export function recordHeartbeat(db, slug, token, payload = {}) {
  const job = db.prepare('SELECT * FROM external_jobs WHERE slug = ?').get(normaliseSlug(slug));
  if (!job || !ingestTokenMatches(token, job.ingest_token_hash)) return null;
  return insertHeartbeat(db, job, payload);
}

// ── Relayed heartbeats ─────────────────────────────────────────────
//
// A host that cannot reach RedMan leaves its message on a broker instead, and
// RedMan collects it outbound. That inverts the trust model: the broker is not
// ours, and anyone able to publish to the topic could otherwise claim a failing
// job succeeded. So the payload is signed rather than carrying a bearer token,
// which would be exposed to every reader of the topic.
//
// The key is the stored token hash, which both sides can derive: the reporting
// host holds the token, RedMan holds its hash. Nothing secret travels over the
// broker, and no new column is needed. The trade-off is that the hash stops
// being a pure verifier — anyone who can read RedMan's database could forge a
// heartbeat — which is acceptable for a monitoring channel, and unremarkable
// next to what else that database holds.

const RELAY_FIELD_SEPARATOR = '\n';
// The wire format writes an absent number as a dash, and the signature covers
// exactly what travels. Signing a different representation than the one sent is
// a subtlety every sender has to remember, and forgetting it fails silently.
const RELAY_ABSENT_FIELD = '-';

export function relaySigningPayload({ slug, ts, exitCode, duration, message }) {
  const optional = value => (value === null || value === undefined ? RELAY_ABSENT_FIELD : String(value));
  return [
    normaliseSlug(slug),
    String(ts ?? ''),
    optional(exitCode),
    optional(duration),
    message ?? '',
  ].join(RELAY_FIELD_SEPARATOR);
}

export function signRelayedHeartbeat(secretHash, fields) {
  return createHmac('sha256', secretHash).update(relaySigningPayload(fields), 'utf8').digest('hex');
}

function signatureMatches(expectedHex, candidateHex) {
  // Exactly one SHA-256 digest: Buffer.from drops a trailing nibble, so odd
  // lengths would let a signature verify with a character appended to it.
  if (typeof candidateHex !== 'string' || !/^[0-9a-f]{64}$/i.test(candidateHex)) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  const candidate = Buffer.from(candidateHex.toLowerCase(), 'hex');
  if (expected.length !== candidate.length) return false;
  return timingSafeEqual(expected, candidate);
}

/**
 * Verify and record a heartbeat that reached us through a broker.
 *
 * The reason codes are for local diagnosis only. Unlike the HTTP endpoint there
 * is nobody to withhold them from: whoever published the message never sees
 * this result.
 */
export function recordRelayedHeartbeat(db, fields, { now = new Date(), maxAgeSeconds = RELAY_MAX_AGE_SECONDS } = {}) {
  const slug = normaliseSlug(fields.slug);
  const job = db.prepare('SELECT * FROM external_jobs WHERE slug = ?').get(slug);
  if (!job) return { ok: false, reason: 'unknown-job', slug };

  const ts = Number(fields.ts);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'bad-timestamp', slug };
  // A signature stays valid forever, so age is what stops an old message from
  // being replayed onto the topic to mask a job that has since stopped running.
  const ageSeconds = Math.abs(Math.floor(now.getTime() / 1000) - ts);
  if (ageSeconds > maxAgeSeconds) return { ok: false, reason: 'stale', slug, ageSeconds };

  const expected = signRelayedHeartbeat(job.ingest_token_hash, fields);
  if (!signatureMatches(expected, fields.signature)) return { ok: false, reason: 'bad-signature', slug };

  const recorded = insertHeartbeat(db, job, {
    exit_code: fields.exitCode,
    duration_seconds: fields.duration,
    message: fields.message,
    // Keyed on the signature, not on the delivering message: a broker hands out
    // a fresh id for every publish, so anyone who captured a valid line off the
    // topic could re-post it verbatim and push the overdue deadline forward
    // without forging anything. The signature covers the timestamp, so a repeat
    // of the same run is identical while a genuine later run differs.
    source_ref: `relay:${expected}`,
  });

  if (recorded.duplicate) return { ok: true, duplicate: true, slug };
  return { ok: true, duplicate: false, slug, status: recorded.status };
}

export function listExternalJobRuns(db, { jobId = null, page = 1, limit = 50 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * safeLimit;
  const where = jobId ? 'WHERE r.job_id = ?' : '';
  const params = jobId ? [jobId] : [];
  const rows = db.prepare(`
    SELECT r.*, j.name AS job_name, j.slug AS job_slug, j.host AS job_host
    FROM external_job_runs AS r
    JOIN external_jobs AS j ON j.id = r.job_id
    ${where}
    ORDER BY datetime(r.reported_at) DESC, r.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, safeLimit, offset);
  const total = db.prepare(`SELECT COUNT(*) AS c FROM external_job_runs AS r ${where}`).get(...params).c;
  return { runs: rows, total, page: Math.max(Number(page) || 1, 1), limit: safeLimit };
}

/**
 * Bounded retention. Always keeps the most recent run per job so a pruned
 * history can never make a healthy job look like it never reported.
 */
export function pruneExternalJobRuns(db, { days = 90, batchSize = 1_000 } = {}) {
  const safeDays = Math.max(1, Number(days) || 90);
  const safeBatch = Math.min(Math.max(Number(batchSize) || 1_000, 1), 10_000);
  return db.prepare(`
    DELETE FROM external_job_runs WHERE id IN (
      SELECT r.id FROM external_job_runs AS r
      WHERE r.reported_at < datetime('now', ?)
        AND r.id NOT IN (SELECT MAX(id) FROM external_job_runs GROUP BY job_id)
      LIMIT ?
    )
  `).run(`-${safeDays} days`, safeBatch).changes;
}

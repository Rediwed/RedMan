// External job heartbeats — dead man's switch for schedules RedMan does not run
// itself (host cron, systemd timers, container updaters on other machines).
//
// The health model deliberately mirrors services/jobHealth.js so the dashboard
// can render RedMan-owned and external jobs with one vocabulary.

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { nextCronOccurrence } from './schedulePolicy.js';
import { parseDbTime } from './jobHealth.js';
import { recordEvent } from './events.js';

const TOKEN_BYTES = 32;
const MAX_MESSAGE_LENGTH = 500;
const VALID_STATUSES = ['completed', 'failed', 'running'];

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
 * Record one heartbeat. Returns null when the slug is unknown or the token does
 * not match, so callers cannot distinguish the two cases.
 */
export function recordHeartbeat(db, slug, token, payload = {}) {
  const job = db.prepare('SELECT * FROM external_jobs WHERE slug = ?').get(normaliseSlug(slug));
  if (!job || !ingestTokenMatches(token, job.ingest_token_hash)) return null;

  const exitCode = Number.isFinite(Number(payload.exit_code)) ? Number(payload.exit_code) : null;
  const status = VALID_STATUSES.includes(payload.status)
    ? payload.status
    : (exitCode === null || exitCode === 0 ? 'completed' : 'failed');
  const duration = Number.isFinite(Number(payload.duration_seconds))
    ? Math.max(0, Math.round(Number(payload.duration_seconds)))
    : null;
  const message = payload.message ? String(payload.message).slice(0, MAX_MESSAGE_LENGTH) : null;

  const previous = latestRun(db, job.id, ['completed', 'failed']);

  db.transaction(() => {
    db.prepare(`
      INSERT INTO external_job_runs (job_id, status, exit_code, duration_seconds, message)
      VALUES (?, ?, ?, ?, ?)
    `).run(job.id, status, exitCode, duration, message);
    db.prepare("UPDATE external_jobs SET last_reported_at = datetime('now') WHERE id = ?").run(job.id);
  })();

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

// Event history — the durable record behind the live notification channels.
//
// notify.js delivers to ntfy and browser SSE, both of which are fire-and-forget:
// close the tab and the event is gone. This records what happened regardless of
// whether it was delivered, so turning notifications off costs you delivery, not
// history.

import db from '../db.js';

// Progress updates are deliberately absent: they fire on an interval and would
// bury real transitions in a timeline within hours.
const TRANSIENT_TYPES = new Set(['job_progress']);

const TYPE_META = {
  job_started: { category: 'backup', severity: 'info' },
  job_completed: { category: 'backup', severity: 'info' },
  job_partial: { category: 'backup', severity: 'warning' },
  job_error: { category: 'backup', severity: 'error' },
  job_cancelled: { category: 'backup', severity: 'info' },
  job_skipped: { category: 'backup', severity: 'warning' },
  drive_attached: { category: 'media', severity: 'info' },
  drive_ejected: { category: 'media', severity: 'info' },
  drive_lost: { category: 'media', severity: 'warning' },
  drive_scan_started: { category: 'media', severity: 'info' },
  drive_scan_completed: { category: 'media', severity: 'info' },
  import_started: { category: 'media', severity: 'info' },
  import_completed: { category: 'media', severity: 'info' },
  import_error: { category: 'media', severity: 'error' },
  external_job_failed: { category: 'external', severity: 'error' },
  external_job_recovered: { category: 'external', severity: 'info' },
  // A retry that worked still says the link is degrading, so it is recorded
  // rather than absorbed: silently recovering is how a failing peer stays
  // invisible until the night it does not recover.
  peer_call_retried: { category: 'backup', severity: 'warning' },
};

export const SEVERITIES = ['info', 'warning', 'error'];

function severityFromPriority(priority) {
  const value = Number.parseInt(priority, 10);
  if (value >= 4) return 'error';
  if (value <= 2) return 'info';
  return 'info';
}

/**
 * Record one event. Never throws: a failure to log must not break the action
 * that produced it, nor the delivery of the notification itself.
 */
export function recordEvent(type, { title, body, subject, detail, priority, category, severity } = {}) {
  if (TRANSIENT_TYPES.has(type)) return null;
  try {
    const meta = TYPE_META[type] || {};
    const row = db.prepare(`
      INSERT INTO events (type, category, severity, subject, title, body, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      type,
      category || meta.category || 'system',
      severity || meta.severity || severityFromPriority(priority),
      subject ? String(subject).slice(0, 200) : null,
      String(title ?? type).slice(0, 300),
      body ? String(body).slice(0, 2_000) : null,
      detail ? JSON.stringify(detail).slice(0, 4_000) : null,
    );
    return row.lastInsertRowid;
  } catch (err) {
    console.error('[events] Failed to record event:', err.message);
    return null;
  }
}

export function listEvents({ severity = null, category = null, type = null, since = null, page = 1, limit = 50 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * safeLimit;
  const clauses = [];
  const params = [];
  if (severity && SEVERITIES.includes(severity)) { clauses.push('severity = ?'); params.push(severity); }
  if (category) { clauses.push('category = ?'); params.push(category); }
  if (type) { clauses.push('type = ?'); params.push(type); }
  if (since) { clauses.push("created_at >= datetime('now', ?)"); params.push(since); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const events = db.prepare(`
    SELECT * FROM events ${where}
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(...params, safeLimit, offset).map(row => ({
    ...row,
    detail: row.detail ? safeParse(row.detail) : null,
  }));

  const total = db.prepare(`SELECT COUNT(*) AS c FROM events ${where}`).get(...params).c;
  return { events, total, page: Math.max(Number(page) || 1, 1), limit: safeLimit };
}

function safeParse(value) {
  try { return JSON.parse(value); } catch { return null; }
}

/** Counts per severity and category over a window, for the dashboard header. */
export function getEventSummary({ since = '-24 hours' } = {}) {
  const bySeverity = db.prepare(`
    SELECT severity, COUNT(*) AS count FROM events
    WHERE created_at >= datetime('now', ?) GROUP BY severity
  `).all(since);
  const byCategory = db.prepare(`
    SELECT category, COUNT(*) AS count FROM events
    WHERE created_at >= datetime('now', ?) GROUP BY category
  `).all(since);
  // Scoped to the same window as the counts: a highlight from outside the
  // selected period would make the window filter meaningless.
  const latestIssue = db.prepare(`
    SELECT * FROM events
    WHERE severity IN ('warning', 'error') AND created_at >= datetime('now', ?)
    ORDER BY datetime(created_at) DESC, id DESC LIMIT 1
  `).get(since) || null;
  return {
    since,
    bySeverity: Object.fromEntries(bySeverity.map(r => [r.severity, r.count])),
    byCategory: Object.fromEntries(byCategory.map(r => [r.category, r.count])),
    latestIssue,
  };
}

export function listEventCategories() {
  return db.prepare('SELECT DISTINCT category FROM events ORDER BY category').all().map(r => r.category);
}

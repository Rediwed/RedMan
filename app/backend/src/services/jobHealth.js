import { nextCronOccurrence } from './schedulePolicy.js';

// SQLite writes datetime('now') in UTC, but "YYYY-MM-DD HH:MM:SS" without a
// zone is read as local time — which silently shifts every run by the host's
// offset and makes a completed schedule look overdue.
function parseDbTime(value) {
  if (typeof value !== 'string' || !value) return null;
  // Columns written with toISOString() already carry a zone; only the bare
  // SQLite form needs one appended.
  const iso = /(Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value.replace(' ', 'T')}Z`;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? null : parsed;
}

function latestRun(db, feature, configId, statuses) {
  const placeholders = statuses.map(() => '?').join(', ');
  return db.prepare(`
    SELECT id, status, completed_at, files_copied, files_failed, error_message
    FROM backup_runs
    WHERE feature = ? AND config_id = ? AND status IN (${placeholders}) AND completed_at IS NOT NULL
    ORDER BY datetime(completed_at) DESC, id DESC LIMIT 1
  `).get(feature, configId, ...statuses) || null;
}

export function getJobHealth(db, {
  feature,
  configId,
  cronExpression,
  enabled,
  running = false,
  includeRestore = false,
  now = new Date(),
}) {
  const lastSuccess = latestRun(db, feature, configId, ['completed']);
  const lastIssue = latestRun(db, feature, configId, ['partial', 'failed']);
  const lastVerifiedRestore = includeRestore
    ? db.prepare(`
      SELECT id, snapshot_timestamp, file_path, restored_to, verified_at
      FROM restore_events
      WHERE config_id = ? AND status = 'verified'
      ORDER BY datetime(verified_at) DESC, id DESC LIMIT 1
    `).get(configId) || null
    : null;

  let nextRun = null;
  let expectedAfterLastSuccess = null;
  try {
    if (enabled) nextRun = nextCronOccurrence(cronExpression, { currentDate: now });
    if (lastSuccess) {
      const completedAt = parseDbTime(lastSuccess.completed_at);
      if (completedAt !== null) {
        expectedAfterLastSuccess = nextCronOccurrence(cronExpression, {
          currentDate: new Date(completedAt),
        });
      }
    }
  } catch {
    // Invalid legacy schedules are surfaced as missing next-run health.
  }

  const missedSchedule = !!enabled && !running && (
    !lastSuccess || (expectedAfterLastSuccess && Date.parse(expectedAfterLastSuccess) < now.getTime())
  );
  const issueAfterSuccess = !!lastIssue && (
    !lastSuccess || parseDbTime(lastIssue.completed_at) > parseDbTime(lastSuccess.completed_at)
  );
  const state = !enabled
    ? 'paused'
    : running
      ? 'running'
      : missedSchedule || issueAfterSuccess
        ? 'attention'
        : 'healthy';

  return {
    state,
    stale: missedSchedule,
    nextRun,
    expectedAfterLastSuccess,
    lastSuccess,
    lastIssue,
    lastVerifiedRestore,
  };
}
import { nextCronOccurrence } from './schedulePolicy.js';

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
      expectedAfterLastSuccess = nextCronOccurrence(cronExpression, {
        currentDate: new Date(lastSuccess.completed_at),
      });
    }
  } catch {
    // Invalid legacy schedules are surfaced as missing next-run health.
  }

  const missedSchedule = !!enabled && !running && (
    !lastSuccess || (expectedAfterLastSuccess && Date.parse(expectedAfterLastSuccess) < now.getTime())
  );
  const issueAfterSuccess = !!lastIssue && (
    !lastSuccess || Date.parse(lastIssue.completed_at) > Date.parse(lastSuccess.completed_at)
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
import { claimBackupRun } from './runClaim.js';

export function normalizePagination(query = {}, { defaultLimit = 20, maxLimit = 100 } = {}) {
  const parsedPage = Number.parseInt(query.page, 10);
  const parsedLimit = Number.parseInt(query.limit, 10);
  const page = Number.isInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const requestedLimit = Number.isInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : defaultLimit;
  const limit = Math.min(maxLimit, requestedLimit);
  return { page, limit, offset: (page - 1) * limit };
}

export function startClaimedRun({
  db,
  feature,
  configId,
  peerStaticPublicKey = null,
  execute,
  onError = error => console.error(`[${feature}] Run failed:`, error.message),
}) {
  const claim = claimBackupRun(db, feature, configId, peerStaticPublicKey);
  if (!claim.claimed) return claim;

  try {
    const execution = execute(Number(configId), claim.runId);
    if (execution?.catch) execution.catch(onError);
  } catch (error) {
    db.prepare(`
      UPDATE backup_runs
      SET status = 'failed', completed_at = datetime('now'), error_message = ?
      WHERE id = ? AND feature = ? AND status = 'running'
    `).run(error.message, claim.runId, feature);
    throw error;
  }

  return claim;
}

export function getFeatureRun(db, feature, runId) {
  return db.prepare('SELECT * FROM backup_runs WHERE id = ? AND feature = ?').get(runId, feature) || null;
}

export function listFeatureRuns(db, { feature, configId = null, page, limit, offset }) {
  const hasConfigFilter = configId !== null && configId !== undefined && configId !== '';
  const filter = hasConfigFilter ? ' AND config_id = ?' : '';
  const params = hasConfigFilter ? [feature, configId] : [feature];
  const total = db.prepare(`SELECT COUNT(*) AS total FROM backup_runs WHERE feature = ?${filter}`).get(...params).total;
  const runs = db.prepare(`
    SELECT * FROM backup_runs
    WHERE feature = ?${filter}
    ORDER BY started_at DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  return {
    runs,
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}

export function getRunProgress(db, feature, runId, getActiveRun) {
  const run = db.prepare(`
    SELECT id, config_id, status, started_at, completed_at, files_total,
      files_copied, files_failed, bytes_transferred, duration_seconds, error_message
    FROM backup_runs WHERE id = ? AND feature = ?
  `).get(runId, feature);
  if (!run) return null;
  return { ...run, liveProgress: getActiveRun(run.id) || null };
}

export function getRunDetail(db, {
  feature,
  runId,
  query = {},
  getActiveRun,
  includeActionCounts = false,
}) {
  const run = getFeatureRun(db, feature, runId);
  if (!run) return null;

  const { page: filePage, limit: fileLimit, offset } = normalizePagination(
    { page: query.filePage, limit: query.fileLimit },
    { defaultLimit: 1000, maxLimit: 5000 },
  );
  const action = query.action || null;
  const actionFilter = action ? ' AND action = ?' : '';
  const params = action ? [run.id, action] : [run.id];
  const totalFiles = db.prepare(`
    SELECT COUNT(*) AS count FROM backup_run_files WHERE run_id = ?${actionFilter}
  `).get(...params).count;
  const files = db.prepare(`
    SELECT * FROM backup_run_files
    WHERE run_id = ?${actionFilter}
    ORDER BY file_path
    LIMIT ? OFFSET ?
  `).all(...params, fileLimit, offset);

  const result = {
    ...run,
    files,
    totalFiles,
    filePage,
    fileLimit,
    filePages: Math.ceil(totalFiles / fileLimit),
    liveProgress: getActiveRun(run.id) || null,
  };
  if (includeActionCounts) {
    result.actionCounts = db.prepare(`
      SELECT action, COUNT(*) AS count
      FROM backup_run_files WHERE run_id = ? GROUP BY action
    `).all(run.id);
  }
  return result;
}

export function cancelFeatureRun(db, { feature, runId, cancelProcess }) {
  const run = getFeatureRun(db, feature, runId);
  if (!run) return { ok: false, statusCode: 404, error: 'Run not found' };
  if (run.status !== 'running') return { ok: false, statusCode: 400, error: 'Run is not active' };
  if (!cancelProcess(run.id)) {
    return { ok: false, statusCode: 400, error: 'Could not cancel — process not found' };
  }

  const transition = db.prepare(`
    UPDATE backup_runs
    SET status = 'cancelled', completed_at = datetime('now'), error_message = 'Cancelled by user'
    WHERE id = ? AND feature = ? AND status = 'running'
  `).run(run.id, feature);
  if (transition.changes !== 1) return { ok: false, statusCode: 400, error: 'Run is not active' };
  return { ok: true, run: { ...run, status: 'cancelled', error_message: 'Cancelled by user' } };
}
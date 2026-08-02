const ROUTINE_AUDIT_ACTIONS = [
  'auth_success',
  'health_check',
  'status_check',
  'storage_check',
  'browse',
  'roots',
  'shares',
];
const RESULT_KEYS = [
  'runFiles',
  'runs',
  'routineAudit',
  'securityAudit',
  'metrics',
  'summaries',
  'authAudit',
  'authSessions',
  'authRecovery',
  'pairingExpired',
  'pairingHistory',
  'externalRuns',
];

function readPositiveSetting(db, key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  const value = Number.parseInt(row?.value, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function getDatabaseRetentionPolicy(db) {
  return {
    runFileDays: readPositiveSetting(db, 'run_files_retention_days', 30),
    runHistoryDays: readPositiveSetting(db, 'run_history_retention_days', 365),
    routineAuditDays: readPositiveSetting(db, 'peer_audit_retention_days', 30),
    securityAuditDays: readPositiveSetting(db, 'peer_security_audit_retention_days', 365),
    authAuditDays: readPositiveSetting(db, 'auth_audit_retention_days', 365),
    metricsHours: readPositiveSetting(db, 'metrics_retention_hours', 24),
    externalRunDays: readPositiveSetting(db, 'external_run_retention_days', 90),
  };
}

function positiveInteger(value, fallback, name, maximum = 10_000) {
  const parsed = Number.parseInt(value ?? fallback, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be between 1 and ${maximum}`);
  }
  return parsed;
}

export function pruneDatabaseTelemetry(db, overrides = {}, options = {}) {
  const policy = { ...getDatabaseRetentionPolicy(db), ...overrides };
  const batchSize = positiveInteger(options.batchSize, 1_000, 'Retention batch size');
  const runFileBatchSize = positiveInteger(
    options.runFileBatchSize,
    Math.min(batchSize, 100),
    'Run-file retention batch size',
  );
  const auditPlaceholders = ROUTINE_AUDIT_ACTIONS.map(() => '?').join(', ');
  const prune = db.transaction(() => {
    const runFiles = db.prepare(`
      DELETE FROM backup_run_files WHERE id IN (
        SELECT files.id
        FROM backup_runs AS runs
        JOIN backup_run_files AS files ON files.run_id = runs.id
        WHERE runs.started_at IS NOT NULL
          AND runs.started_at < datetime('now', ?)
        LIMIT ?
      )
    `).run(`-${policy.runFileDays} days`, runFileBatchSize).changes;
    const runs = db.prepare(`
      DELETE FROM backup_runs WHERE id IN (
        SELECT runs.id
        FROM backup_runs AS runs
        WHERE runs.status != 'running'
          AND (
            runs.completed_at < datetime('now', ?)
            OR (runs.completed_at IS NULL AND runs.started_at < datetime('now', ?))
          )
          AND NOT EXISTS (
            SELECT 1 FROM backup_run_files AS files WHERE files.run_id = runs.id
          )
        LIMIT ?
      )
    `).run(`-${policy.runHistoryDays} days`, `-${policy.runHistoryDays} days`, batchSize).changes;
    const routineAudit = db.prepare(`
      DELETE FROM peer_audit_log WHERE id IN (
        SELECT id FROM peer_audit_log
        WHERE action IN (${auditPlaceholders}) AND created_at < datetime('now', ?)
        LIMIT ?
      )
    `).run(...ROUTINE_AUDIT_ACTIONS, `-${policy.routineAuditDays} days`, batchSize).changes;
    const securityAudit = db.prepare(`
      DELETE FROM peer_audit_log WHERE id IN (
        SELECT id FROM peer_audit_log
        WHERE action NOT IN (${auditPlaceholders}) AND created_at < datetime('now', ?)
        LIMIT ?
      )
    `).run(...ROUTINE_AUDIT_ACTIONS, `-${policy.securityAuditDays} days`, batchSize).changes;
    const metrics = db.prepare(`
      DELETE FROM container_metrics WHERE id IN (
        SELECT id FROM container_metrics WHERE recorded_at < datetime('now', ?) LIMIT ?
      )
    `).run(`-${policy.metricsHours} hours`, batchSize).changes;
    const summaries = db.prepare(`
      DELETE FROM cache WHERE key IN (
        SELECT key FROM cache
        WHERE key LIKE 'version_stats:%'
          AND CAST(substr(key, 15) AS INTEGER) NOT IN (SELECT id FROM ssd_backup_configs)
        LIMIT ?
      )
    `).run(batchSize).changes;
    const authAudit = db.prepare(`
      DELETE FROM auth_audit_log WHERE id IN (
        SELECT id FROM auth_audit_log WHERE created_at < datetime('now', ?) LIMIT ?
      )
    `).run(`-${policy.authAuditDays} days`, batchSize).changes;
    const authSessions = db.prepare(`
      DELETE FROM auth_sessions WHERE id IN (
        SELECT id FROM auth_sessions
        WHERE (revoked_at IS NOT NULL AND revoked_at < datetime('now', '-7 days'))
          OR (revoked_at IS NULL AND absolute_expires_at < datetime('now', '-7 days'))
        LIMIT ?
      )
    `).run(batchSize).changes;
    const authRecovery = db.prepare(`
      DELETE FROM auth_recovery_events WHERE id IN (
        SELECT id FROM auth_recovery_events
        WHERE (status != 'issued' OR expires_at < datetime('now'))
          AND created_at < datetime('now', '-30 days')
        LIMIT ?
      )
    `).run(batchSize).changes;
    const pairingExpired = db.prepare(`
      UPDATE pairing_requests
      SET status = 'expired', error = COALESCE(error, 'Pairing request expired'), updated_at = datetime('now')
      WHERE id IN (
        SELECT id FROM pairing_requests
        WHERE status IN ('pending', 'accepting') AND expires_at < datetime('now')
        LIMIT ?
      )
    `).run(batchSize).changes;
    const pairingHistory = db.prepare(`
      DELETE FROM pairing_requests WHERE id IN (
        SELECT id FROM pairing_requests
        WHERE status IN ('expired', 'failed', 'declined')
          AND updated_at < datetime('now', '-1 hour')
        LIMIT ?
      )
    `).run(batchSize).changes;
    // Always keeps the newest run per job: pruning history must never make a
    // reporting job look like it never checked in.
    const externalRuns = db.prepare(`
      DELETE FROM external_job_runs WHERE id IN (
        SELECT id FROM external_job_runs
        WHERE reported_at < datetime('now', ?)
          AND id NOT IN (SELECT MAX(id) FROM external_job_runs GROUP BY job_id)
        LIMIT ?
      )
    `).run(`-${policy.externalRunDays} days`, batchSize).changes;
    return {
      runFiles, runs, routineAudit, securityAudit, metrics, summaries,
      authAudit, authSessions, authRecovery, pairingExpired, pairingHistory,
      externalRuns,
    };
  });
  return prune.immediate();
}

export async function runDatabaseRetentionBatches(db, overrides = {}, options = {}) {
  const batchSize = positiveInteger(options.batchSize, 1_000, 'Retention batch size');
  const maxBatches = positiveInteger(options.maxBatches, 100, 'Retention max batches', 10_000);
  const runFileBatchSize = positiveInteger(
    options.runFileBatchSize,
    Math.min(batchSize, 100),
    'Run-file retention batch size',
  );
  const maxDurationMs = positiveInteger(
    options.maxDurationMs,
    30_000,
    'Retention time budget',
    3_600_000,
  );
  const yieldMs = Number.parseInt(options.yieldMs ?? 100, 10);
  if (!Number.isInteger(yieldMs) || yieldMs < 0 || yieldMs > 60_000) {
    throw new Error('Retention yield must be between 0 and 60000 milliseconds');
  }
  const shouldStop = typeof options.shouldStop === 'function' ? options.shouldStop : () => false;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const totals = Object.fromEntries(RESULT_KEYS.map(key => [key, 0]));
  let batches = 0;
  const startedAt = Date.now();

  while (batches < maxBatches) {
    if (shouldStop()) return { totals, batches, complete: false, cancelled: true };
    if (batches > 0 && Date.now() - startedAt >= maxDurationMs) {
      return { totals, batches, complete: false, cancelled: false, timedOut: true };
    }
    const removed = pruneDatabaseTelemetry(db, overrides, { batchSize, runFileBatchSize });
    batches += 1;
    for (const key of RESULT_KEYS) totals[key] += removed[key];
    const changed = Object.values(removed).reduce((sum, count) => sum + count, 0);
    onProgress({ batch: batches, removed, totals, changed });
    if (changed === 0) return { totals, batches, complete: true, cancelled: false, timedOut: false };
    if (yieldMs > 0) {
      await new Promise(resolve => { setTimeout(resolve, yieldMs); });
    }
  }

  return { totals, batches, complete: false, cancelled: false, timedOut: false };
}
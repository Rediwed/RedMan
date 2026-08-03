// Rclone sync routes — manage rclone remotes and sync jobs

import { Router } from 'express';
import db from '../db.js';
import {
  listRemotes, browseRemote, executeRcloneJob, getActiveRcloneRun, cancelRcloneRun,
  getProviderTypes, getRemoteConfig, createRemote, updateRemote, deleteRemote, testRemote,
  validateRcloneJobInput,
} from '../services/rclone.js';
import { scheduleJob, removeJob, getJobSkipCount, isJobRunning } from '../services/scheduler.js';
import {
  cancelFeatureRun,
  getRunDetail,
  getRunProgress,
  listFeatureRuns,
  normalizePagination,
  startClaimedRun,
} from '../services/runLifecycle.js';
import { validateCronExpression } from '../services/schedulePolicy.js';
import { summariseRcloneFailures, fingerprintFailures, compareFailureSummaries } from '../services/rcloneDiagnostics.js';
import { notifyJobCancelled, shouldNotify } from '../services/notify.js';
import { getJobHealth } from '../services/jobHealth.js';

const router = Router();

// List configured rclone remotes
router.get('/remotes', async (req, res) => {
  try {
    const remotes = await listRemotes();
    res.json(remotes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Browse a remote path
router.get('/remote/:name/ls', async (req, res) => {
  try {
    const entries = await browseRemote(req.params.name, req.query.path || '');
    res.json(entries);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List all sync jobs
router.get('/jobs', (req, res) => {
  const jobs = db.prepare('SELECT * FROM rclone_jobs ORDER BY created_at DESC').all();
  const enriched = jobs.map(j => ({
    ...j,
    consecutive_skips: getJobSkipCount('rclone', j.id),
    scheduler_running: isJobRunning('rclone', j.id),
    health: getJobHealth(db, {
      feature: 'rclone', configId: j.id, cronExpression: j.cron_expression,
      enabled: !!j.enabled, running: isJobRunning('rclone', j.id),
    }),
  }));
  res.json(enriched);
});

// Get a single job
router.get('/jobs/:id', (req, res) => {
  const job = db.prepare('SELECT * FROM rclone_jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// Create a new sync job
router.post('/jobs', (req, res) => {
  const { name, local_path, remote_name, remote_path, sync_direction, cron_expression, notify_mode, notify_on_start, notify_on_success, notify_on_failure } = req.body;

  if (!name || !local_path || !remote_name || !remote_path) {
    return res.status(400).json({ error: 'name, local_path, remote_name, and remote_path are required' });
  }
  const schedule = cron_expression || '0 3 * * *';
  if (!validateCronExpression(schedule)) return res.status(400).json({ error: 'cron_expression must be a valid 5-field cron expression' });

  if (sync_direction && !['upload', 'download', 'bisync'].includes(sync_direction)) {
    return res.status(400).json({ error: 'sync_direction must be "upload", "download", or "bisync"' });
  }
  let safeJob;
  try {
    safeJob = validateRcloneJobInput({ local_path, remote_name, remote_path, sync_direction });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const result = db.prepare(`
    INSERT INTO rclone_jobs (name, local_path, remote_name, remote_path, sync_direction, cron_expression, bisync_resync_needed, notify_mode, notify_on_start, notify_on_success, notify_on_failure)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name, safeJob.local_path, remote_name, remote_path,
    safeJob.sync_direction,
    schedule,
    sync_direction === 'bisync' ? 1 : 0,
    notify_mode || 'global',
    notify_on_start !== undefined ? (notify_on_start ? 1 : 0) : 1,
    notify_on_success !== undefined ? (notify_on_success ? 1 : 0) : 1,
    notify_on_failure !== undefined ? (notify_on_failure ? 1 : 0) : 1,
  );

  const job = db.prepare('SELECT * FROM rclone_jobs WHERE id = ?').get(result.lastInsertRowid);

  if (job.enabled) {
    scheduleJob('rclone', job.id, job.cron_expression);
  }

  res.status(201).json(job);
});

// Update a sync job
router.put('/jobs/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM rclone_jobs WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Job not found' });

  const { name, local_path, remote_name, remote_path, sync_direction, cron_expression, enabled, notify_mode, notify_on_start, notify_on_success, notify_on_failure } = req.body;
  if (cron_expression !== undefined && !validateCronExpression(cron_expression)) {
    return res.status(400).json({ error: 'cron_expression must be a valid 5-field cron expression' });
  }

  // If direction changed to bisync, mark resync needed
  const newDirection = sync_direction ?? existing.sync_direction;
  let safeJob;
  try {
    safeJob = validateRcloneJobInput({
      local_path: local_path ?? existing.local_path,
      remote_name: remote_name ?? existing.remote_name,
      remote_path: remote_path ?? existing.remote_path,
      sync_direction: newDirection,
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const bisyncResync = (newDirection === 'bisync' && existing.sync_direction !== 'bisync') ? 1 : existing.bisync_resync_needed;

  db.prepare(`
    UPDATE rclone_jobs SET
      name = ?, local_path = ?, remote_name = ?, remote_path = ?,
      sync_direction = ?, cron_expression = ?, enabled = ?,
      bisync_resync_needed = ?,
      notify_mode = ?, notify_on_start = ?, notify_on_success = ?, notify_on_failure = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    name ?? existing.name,
    safeJob.local_path,
    remote_name ?? existing.remote_name,
    remote_path ?? existing.remote_path,
    newDirection,
    cron_expression ?? existing.cron_expression,
    enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled,
    bisyncResync,
    notify_mode || existing.notify_mode || 'global',
    notify_on_start !== undefined ? (notify_on_start ? 1 : 0) : existing.notify_on_start,
    notify_on_success !== undefined ? (notify_on_success ? 1 : 0) : existing.notify_on_success,
    notify_on_failure !== undefined ? (notify_on_failure ? 1 : 0) : existing.notify_on_failure,
    req.params.id,
  );

  const updated = db.prepare('SELECT * FROM rclone_jobs WHERE id = ?').get(req.params.id);

  if (updated.enabled) {
    scheduleJob('rclone', updated.id, updated.cron_expression);
  } else {
    removeJob('rclone', updated.id);
  }

  res.json(updated);
});

// Delete a sync job
router.delete('/jobs/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM rclone_jobs WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Job not found' });

  removeJob('rclone', existing.id);
  db.prepare('DELETE FROM rclone_jobs WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Trigger a manual run
router.post('/jobs/:id/run', async (req, res) => {
  const job = db.prepare('SELECT * FROM rclone_jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  try {
    const claim = startClaimedRun({
      db,
      feature: 'rclone',
      configId: job.id,
      execute: executeRcloneJob,
      onError: err => console.error(`[rclone] Run failed for job ${job.id}:`, err.message),
    });
    if (!claim.claimed) {
      return res.status(409).json({ error: 'Sync is already running', activeRunId: claim.runId });
    }
    res.json({ runId: claim.runId, status: 'started' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cancel a running sync
router.post('/runs/:id/cancel', (req, res) => {
  const runId = parseInt(req.params.id);
  const result = cancelFeatureRun(db, { feature: 'rclone', runId, cancelProcess: cancelRcloneRun });
  if (!result.ok) return res.status(result.statusCode).json({ error: result.error });
  const job = db.prepare('SELECT * FROM rclone_jobs WHERE id = ?').get(result.run.config_id);
  if (job && shouldNotify(job, 'cancel')) notifyJobCancelled('Rclone Sync', job.name);
  res.json({ status: 'cancelled' });
});

// List runs
router.get('/runs', (req, res) => {
  const pagination = normalizePagination(req.query);
  res.json(listFeatureRuns(db, {
    feature: 'rclone',
    configId: req.query.job_id,
    ...pagination,
  }));
});

// Lightweight active progress without file queries
router.get('/runs/:id/progress', (req, res) => {
  const run = getRunProgress(db, 'rclone', req.params.id, getActiveRcloneRun);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  return res.json(run);
});

// Get run detail (paginated file list for scale — defaults to first 1000)
// How far back to look for the moment this failure pattern started. Bounded so
// a job that has failed for a year cannot turn one page load into a table scan.
const DIAGNOSIS_HISTORY_LIMIT = 30;

// Errors carry the failing path, so distinct messages scale with failing files
// rather than with causes. Only the largest groups can change a diagnosis, so
// the query is capped to keep one page load off a multi-million-row result.
const DIAGNOSIS_MAX_GROUPS = 2_000;

// Aggregated in SQL rather than per file, so a run's failures never all have to
// be materialised in Node.
function failureCountsForRuns(runIds) {
  if (runIds.length === 0) return new Map();
  const placeholders = runIds.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT run_id, error, MIN(file_path) AS path, COUNT(*) AS count
    FROM backup_run_files
    WHERE run_id IN (${placeholders}) AND action = 'error'
    GROUP BY run_id, error
    ORDER BY count DESC
    LIMIT ?
  `).all(...runIds, DIAGNOSIS_MAX_GROUPS);

  const perRun = new Map();
  for (const row of rows) {
    if (!perRun.has(row.run_id)) perRun.set(row.run_id, []);
    perRun.get(row.run_id).push(row);
  }
  return perRun;
}

function diagnoseRun(run) {
  const history = db.prepare(`
    SELECT id, started_at FROM backup_runs
    WHERE feature = 'rclone' AND config_id = ? AND id < ? AND status IN ('completed', 'partial', 'failed')
    ORDER BY id DESC LIMIT ?
  `).all(run.config_id, run.id, DIAGNOSIS_HISTORY_LIMIT);

  const counts = failureCountsForRuns([run.id, ...history.map(h => h.id)]);
  const summary = summariseRcloneFailures(counts.get(run.id) || []);
  const fingerprint = fingerprintFailures(summary);

  const previous = history.length ? summariseRcloneFailures(counts.get(history[0].id) || []) : null;
  const comparison = compareFailureSummaries(summary, previous);

  // Walk back while the pattern holds, so the report can say how long this has
  // been true instead of only that it is true.
  let unchangedSince = null;
  let unchangedRuns = 0;
  if (comparison.unchanged) {
    for (const older of history) {
      if (fingerprintFailures(summariseRcloneFailures(counts.get(older.id) || [])) !== fingerprint) break;
      unchangedSince = older.started_at;
      unchangedRuns += 1;
    }
  }

  return {
    ...summary,
    fingerprint,
    comparison,
    unchangedSince,
    unchangedRuns,
    historyTruncated: history.length === DIAGNOSIS_HISTORY_LIMIT,
  };
}

router.get('/runs/:id', (req, res) => {
  const run = getRunDetail(db, {
    feature: 'rclone',
    runId: req.params.id,
    query: req.query,
    getActiveRun: getActiveRcloneRun,
  });
  if (!run) return res.status(404).json({ error: 'Run not found' });
  // Derived on read rather than stored, so runs that already failed get an
  // explanation too — which is exactly when one is wanted.
  if (run.files_failed > 0) run.diagnosis = diagnoseRun(run);
  res.json(run);
});

// ===== Remote configuration management =====

// List supported provider types
router.get('/providers', (req, res) => {
  res.json(getProviderTypes());
});

// Get full config for a specific remote (with sensitive fields redacted)
router.get('/remotes/:name/config', async (req, res) => {
  try {
    const config = await getRemoteConfig(req.params.name);
    res.json(config);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// Create a new remote
router.post('/remotes', async (req, res) => {
  const { name, type, params } = req.body;
  if (!name || !type) {
    return res.status(400).json({ error: 'name and type are required' });
  }
  try {
    const result = await createRemote(name, type, params || {});
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Update an existing remote's parameters
router.put('/remotes/:name', async (req, res) => {
  const { params } = req.body;
  if (!params || Object.keys(params).length === 0) {
    return res.status(400).json({ error: 'params object is required' });
  }
  try {
    const result = await updateRemote(req.params.name, params);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Delete a remote
router.delete('/remotes/:name', async (req, res) => {
  try {
    await deleteRemote(req.params.name);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Test remote connectivity
router.post('/remotes/:name/test', async (req, res) => {
  try {
    const result = await testRemote(req.params.name);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

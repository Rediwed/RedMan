// Rclone sync routes — manage rclone remotes and sync jobs

import { Router } from 'express';
import db from '../db.js';
import {
  listRemotes, browseRemote, executeRcloneJob, getActiveRcloneRun,
  getProviderTypes, getRemoteConfig, createRemote, updateRemote, deleteRemote, testRemote,
} from '../services/rclone.js';
import { scheduleJob, removeJob, getJobSkipCount, isJobRunning } from '../services/scheduler.js';

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
  const { name, local_path, remote_name, remote_path, sync_direction, cron_expression, notify_on_success, notify_on_failure } = req.body;

  if (!name || !local_path || !remote_name || !remote_path) {
    return res.status(400).json({ error: 'name, local_path, remote_name, and remote_path are required' });
  }

  if (sync_direction && !['upload', 'download', 'bisync'].includes(sync_direction)) {
    return res.status(400).json({ error: 'sync_direction must be "upload", "download", or "bisync"' });
  }

  const result = db.prepare(`
    INSERT INTO rclone_jobs (name, local_path, remote_name, remote_path, sync_direction, cron_expression, bisync_resync_needed, notify_on_success, notify_on_failure)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name, local_path, remote_name, remote_path,
    sync_direction || 'upload',
    cron_expression || '0 3 * * *',
    sync_direction === 'bisync' ? 1 : 0,
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

  const { name, local_path, remote_name, remote_path, sync_direction, cron_expression, enabled, notify_on_success, notify_on_failure } = req.body;

  // If direction changed to bisync, mark resync needed
  const newDirection = sync_direction ?? existing.sync_direction;
  const bisyncResync = (newDirection === 'bisync' && existing.sync_direction !== 'bisync') ? 1 : existing.bisync_resync_needed;

  db.prepare(`
    UPDATE rclone_jobs SET
      name = ?, local_path = ?, remote_name = ?, remote_path = ?,
      sync_direction = ?, cron_expression = ?, enabled = ?,
      bisync_resync_needed = ?,
      notify_on_success = ?, notify_on_failure = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    name ?? existing.name,
    local_path ?? existing.local_path,
    remote_name ?? existing.remote_name,
    remote_path ?? existing.remote_path,
    newDirection,
    cron_expression ?? existing.cron_expression,
    enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled,
    bisyncResync,
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

  const run = db.prepare(`
    INSERT INTO backup_runs (feature, config_id, status) VALUES ('rclone', ?, 'running')
  `).run(job.id);
  const runId = Number(run.lastInsertRowid);

  executeRcloneJob(job.id, runId).catch(err => {
    console.error(`[rclone] Run failed for job ${job.id}:`, err.message);
  });

  res.json({ runId, status: 'started' });
});

// List runs
router.get('/runs', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;
  const jobId = req.query.job_id;

  let query = "SELECT * FROM backup_runs WHERE feature = 'rclone'";
  let countQuery = "SELECT COUNT(*) as total FROM backup_runs WHERE feature = 'rclone'";
  const params = [];

  if (jobId) {
    query += ' AND config_id = ?';
    countQuery += ' AND config_id = ?';
    params.push(jobId);
  }

  const total = db.prepare(countQuery).get(...params).total;
  const runs = db.prepare(query + ' ORDER BY started_at DESC LIMIT ? OFFSET ?').all(...params, limit, offset);

  res.json({ runs, page, limit, total, totalPages: Math.ceil(total / limit) });
});

// Get run detail
router.get('/runs/:id', (req, res) => {
  const run = db.prepare("SELECT * FROM backup_runs WHERE id = ? AND feature = 'rclone'").get(req.params.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });

  const files = db.prepare('SELECT * FROM backup_run_files WHERE run_id = ? ORDER BY file_path').all(run.id);
  const progress = getActiveRcloneRun(run.id);

  res.json({ ...run, files, liveProgress: progress || null });
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

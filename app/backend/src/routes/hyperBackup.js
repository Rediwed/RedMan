// Hyper Backup routes — cross-site backup job management

import { Router } from 'express';
import db from '../db.js';
import { executeHyperBackup, testPeerConnection, getActiveHyperRun } from '../services/hyperBackup.js';
import { scheduleJob, removeJob, getJobSkipCount, isJobRunning } from '../services/scheduler.js';
import { normalizePath, validateSshPort, validateUrl } from '../middleware/validation.js';
const router = Router();

// List all Hyper Backup jobs
router.get('/jobs', (req, res) => {
  const jobs = db.prepare('SELECT * FROM hyper_backup_jobs ORDER BY created_at DESC').all();
  // Don't expose API keys in list view
  const safe = jobs.map(j => ({
    ...j,
    remote_api_key: j.remote_api_key ? '••••••••' : '',
    consecutive_skips: getJobSkipCount('hyper-backup', j.id),
    scheduler_running: isJobRunning('hyper-backup', j.id),
  }));
  res.json(safe);
});

// Get a single job
router.get('/jobs/:id', (req, res) => {
  const job = db.prepare('SELECT * FROM hyper_backup_jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  job.remote_api_key = job.remote_api_key ? '••••••••' : '';
  res.json(job);
});

// Create a new Hyper Backup job
router.post('/jobs', (req, res) => {
  const { name, direction, remote_url, remote_api_key, local_path, remote_path, ssh_user, ssh_host, ssh_port, cron_expression, notify_on_success, notify_on_failure } = req.body;

  if (!name || !direction || !remote_url || !remote_api_key || !local_path || !remote_path) {
    return res.status(400).json({ error: 'name, direction, remote_url, remote_api_key, local_path, and remote_path are required' });
  }

  if (!['push', 'pull'].includes(direction)) {
    return res.status(400).json({ error: 'direction must be "push" or "pull"' });
  }

  if (!validateUrl(remote_url)) {
    return res.status(400).json({ error: 'remote_url must be a valid HTTP(S) URL' });
  }

  const normalizedLocal = normalizePath(local_path);
  if (!normalizedLocal) {
    return res.status(400).json({ error: 'local_path must be a valid absolute path' });
  }

  const normalizedRemote = normalizePath(remote_path);
  if (!normalizedRemote) {
    return res.status(400).json({ error: 'remote_path must be a valid absolute path' });
  }

  if (ssh_port && !validateSshPort(ssh_port)) {
    return res.status(400).json({ error: 'ssh_port must be between 1 and 65535' });
  }

  const result = db.prepare(`
    INSERT INTO hyper_backup_jobs (name, direction, remote_url, remote_api_key, local_path, remote_path, ssh_user, ssh_host, ssh_port, cron_expression, notify_on_success, notify_on_failure)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name, direction, remote_url, remote_api_key, normalizedLocal, normalizedRemote,
    ssh_user || 'root',
    ssh_host || null,
    ssh_port || 22,
    cron_expression || '0 2 * * *',
    notify_on_success !== undefined ? (notify_on_success ? 1 : 0) : 1,
    notify_on_failure !== undefined ? (notify_on_failure ? 1 : 0) : 1,
  );

  const job = db.prepare('SELECT * FROM hyper_backup_jobs WHERE id = ?').get(result.lastInsertRowid);

  if (job.enabled) {
    scheduleJob('hyper-backup', job.id, job.cron_expression);
  }

  job.remote_api_key = '••••••••';
  res.status(201).json(job);
});

// Update a job
router.put('/jobs/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM hyper_backup_jobs WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Job not found' });

  const {
    name, direction, remote_url, remote_api_key, local_path, remote_path,
    ssh_user, ssh_host, ssh_port, cron_expression, enabled,
    notify_on_success, notify_on_failure,
  } = req.body;

  if (direction && !['push', 'pull'].includes(direction)) {
    return res.status(400).json({ error: 'direction must be "push" or "pull"' });
  }
  if (remote_url && !validateUrl(remote_url)) {
    return res.status(400).json({ error: 'remote_url must be a valid HTTP(S) URL' });
  }
  if (local_path && !normalizePath(local_path)) {
    return res.status(400).json({ error: 'local_path must be a valid absolute path' });
  }
  if (remote_path && !normalizePath(remote_path)) {
    return res.status(400).json({ error: 'remote_path must be a valid absolute path' });
  }
  if (ssh_port && !validateSshPort(ssh_port)) {
    return res.status(400).json({ error: 'ssh_port must be between 1 and 65535' });
  }

  db.prepare(`
    UPDATE hyper_backup_jobs SET
      name = ?, direction = ?, remote_url = ?, remote_api_key = ?,
      local_path = ?, remote_path = ?, ssh_user = ?, ssh_host = ?,
      ssh_port = ?, cron_expression = ?, enabled = ?,
      notify_on_success = ?, notify_on_failure = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    name ?? existing.name,
    direction ?? existing.direction,
    remote_url ?? existing.remote_url,
    // Only update API key if a new one is provided (not the masked placeholder)
    (remote_api_key && remote_api_key !== '••••••••') ? remote_api_key : existing.remote_api_key,
    local_path ? normalizePath(local_path) : existing.local_path,
    remote_path ? normalizePath(remote_path) : existing.remote_path,
    ssh_user ?? existing.ssh_user,
    ssh_host ?? existing.ssh_host,
    ssh_port ?? existing.ssh_port,
    cron_expression ?? existing.cron_expression,
    enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled,
    notify_on_success !== undefined ? (notify_on_success ? 1 : 0) : existing.notify_on_success,
    notify_on_failure !== undefined ? (notify_on_failure ? 1 : 0) : existing.notify_on_failure,
    req.params.id,
  );

  const updated = db.prepare('SELECT * FROM hyper_backup_jobs WHERE id = ?').get(req.params.id);

  if (updated.enabled) {
    scheduleJob('hyper-backup', updated.id, updated.cron_expression);
  } else {
    removeJob('hyper-backup', updated.id);
  }

  updated.remote_api_key = '••••••••';
  res.json(updated);
});

// Delete a job
router.delete('/jobs/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM hyper_backup_jobs WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Job not found' });

  removeJob('hyper-backup', existing.id);
  db.prepare('DELETE FROM hyper_backup_jobs WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Trigger a manual run
router.post('/jobs/:id/run', async (req, res) => {
  const job = db.prepare('SELECT * FROM hyper_backup_jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const run = db.prepare(`
    INSERT INTO backup_runs (feature, config_id, status) VALUES ('hyper-backup', ?, 'running')
  `).run(job.id);
  const runId = Number(run.lastInsertRowid);

  executeHyperBackup(job.id, runId).catch(err => {
    console.error(`[hyper-backup] Run failed for job ${job.id}:`, err.message);
  });

  res.json({ runId, status: 'started' });
});

// Test connection to remote peer
router.post('/test-connection', async (req, res) => {
  const { remote_url, remote_api_key } = req.body;
  if (!remote_url || !remote_api_key) {
    return res.status(400).json({ error: 'remote_url and remote_api_key are required' });
  }

  const result = await testPeerConnection(remote_url, remote_api_key);
  res.json(result);
});

// List runs
router.get('/runs', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;
  const jobId = req.query.job_id;

  let query = "SELECT * FROM backup_runs WHERE feature = 'hyper-backup'";
  let countQuery = "SELECT COUNT(*) as total FROM backup_runs WHERE feature = 'hyper-backup'";
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

// Get run detail (paginated file list for scale — defaults to first 1000)
router.get('/runs/:id', (req, res) => {
  const run = db.prepare("SELECT * FROM backup_runs WHERE id = ? AND feature = 'hyper-backup'").get(req.params.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });

  const filePage = Math.max(1, parseInt(req.query.filePage) || 1);
  const fileLimit = Math.min(5000, Math.max(1, parseInt(req.query.fileLimit) || 1000));
  const fileOffset = (filePage - 1) * fileLimit;
  const totalFiles = db.prepare('SELECT COUNT(*) as count FROM backup_run_files WHERE run_id = ?').get(run.id).count;
  const files = db.prepare('SELECT * FROM backup_run_files WHERE run_id = ? ORDER BY file_path LIMIT ? OFFSET ?').all(run.id, fileLimit, fileOffset);
  const progress = getActiveHyperRun(run.id);

  res.json({ ...run, files, totalFiles, filePage, fileLimit, liveProgress: progress || null });
});

export default router;

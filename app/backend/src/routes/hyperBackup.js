// Hyper Backup routes — cross-site backup job management

import { Router } from 'express';
import db from '../db.js';
import { executeHyperBackup, testPeerConnection, browsePeerDirectory, getPeerRoots, getPeerShares, getActiveHyperRun, cancelHyperRun } from '../services/hyperBackup.js';
import { scheduleJob, removeJob, getJobSkipCount, isJobRunning } from '../services/scheduler.js';
import { normalizePath, validateSshPort, validateSshHost, validateSshUser, validateUrl } from '../middleware/validation.js';
import {
  cancelFeatureRun,
  getRunDetail,
  getRunProgress,
  listFeatureRuns,
  normalizePagination,
  startClaimedRun,
} from '../services/runLifecycle.js';
import { validateCronExpression } from '../services/schedulePolicy.js';
import { notifyJobCancelled, shouldNotify } from '../services/notify.js';
import { getJobHealth } from '../services/jobHealth.js';
import { runtimeConfig } from '../services/runtimeConfig.js';
import {
  decryptPeerApiKey,
  encryptPeerApiKey,
  encryptedPeerKeyMarker,
} from '../services/peerSecrets.js';
import { findPairingByStaticKey, findPairingByUrl, resolvePeerBinding } from '../services/peerBinding.js';
const router = Router();

// Helper: look up the pairing for a selected peer. Prefers the stable static
// identity so a re-paired peer keeps working even if its address changed.
function getPairingKey({ staticPublicKey, remoteUrl }) {
  const pairing = staticPublicKey
    ? findPairingByStaticKey(db, staticPublicKey)
    : findPairingByUrl(db, remoteUrl);
  if (!pairing) return null;
  return { ...pairing, api_key: decryptPeerApiKey(pairing.api_key_encrypted) };
}

// Helper: describe a job's live destination without exposing credentials
function describeBinding(job) {
  try {
    const binding = resolvePeerBinding(db, job);
    return { peer_name: binding.peerName, peer_bound: binding.source === 'identity', remote_url: binding.remoteUrl };
  } catch {
    return { peer_name: null, peer_bound: false, remote_url: job.remote_url };
  }
}

// List all Hyper Backup jobs
router.get('/jobs', (req, res) => {
  const jobs = db.prepare('SELECT * FROM hyper_backup_jobs ORDER BY created_at DESC').all();
  // Don't expose API keys in list view
  const safe = jobs.map(j => ({
    ...j,
    ...describeBinding(j),
    remote_api_key: j.remote_api_key ? '••••••••' : '',
    remote_api_key_encrypted: undefined,
    consecutive_skips: getJobSkipCount('hyper-backup', j.id),
    scheduler_running: isJobRunning('hyper-backup', j.id),
    health: getJobHealth(db, {
      feature: 'hyper-backup', configId: j.id, cronExpression: j.cron_expression,
      enabled: !!j.enabled, running: isJobRunning('hyper-backup', j.id),
    }),
  }));
  res.json(safe);
});

// Get a single job
router.get('/jobs/:id', (req, res) => {
  const job = db.prepare('SELECT * FROM hyper_backup_jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const binding = describeBinding(job);
  job.remote_api_key = job.remote_api_key ? '••••••••' : '';
  delete job.remote_api_key_encrypted;
  res.json({ ...job, ...binding });
});

// Create a new Hyper Backup job
router.post('/jobs', (req, res) => {
  const { name, direction, peer_static_pubkey, local_path, remote_path, ssh_user, ssh_host, ssh_port, cron_expression, notify_mode, notify_on_start, notify_on_success, notify_on_failure } = req.body;
  let { remote_api_key, remote_url } = req.body;
  const pairing = (peer_static_pubkey || remote_url)
    ? getPairingKey({ staticPublicKey: peer_static_pubkey, remoteUrl: remote_url })
    : null;

  // A selected peer supplies its own current address and key — never snapshot them
  if (pairing) {
    remote_url = pairing.remote_url;
    if (!remote_api_key) remote_api_key = pairing.api_key;
  }

  if (peer_static_pubkey && !pairing) {
    return res.status(400).json({ error: 'Selected peer is not paired — pair it in Settings first' });
  }

  if (!name || !direction || !remote_url || !remote_api_key || !local_path || !remote_path) {
    return res.status(400).json({ error: 'name, direction, remote_url, remote_api_key, local_path, and remote_path are required' });
  }
  const schedule = cron_expression || '0 2 * * *';
  if (!validateCronExpression(schedule)) return res.status(400).json({ error: 'cron_expression must be a valid 5-field cron expression' });

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

  if (ssh_host && !validateSshHost(ssh_host)) {
    return res.status(400).json({ error: 'ssh_host must be a valid hostname or IP (letters, digits, dot, dash, underscore)' });
  }

  if (ssh_user && !validateSshUser(ssh_user)) {
    return res.status(400).json({ error: 'ssh_user must be a non-root account containing only letters, digits, dot, dash, or underscore' });
  }

  const encryptedApiKey = encryptPeerApiKey(remote_api_key);
  const result = db.prepare(`
    INSERT INTO hyper_backup_jobs (name, direction, remote_url, remote_api_key, remote_api_key_encrypted, peer_static_pubkey, local_path, remote_path, ssh_user, ssh_host, ssh_port, cron_expression, notify_mode, notify_on_start, notify_on_success, notify_on_failure)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name, direction, remote_url, encryptedPeerKeyMarker(), encryptedApiKey, pairing?.remote_static_pubkey || null,
    normalizedLocal, normalizedRemote,
    ssh_user || runtimeConfig.sshUser,
    ssh_host || null,
    ssh_port || 22,
    schedule,
    notify_mode || 'global',
    notify_on_start !== undefined ? (notify_on_start ? 1 : 0) : 1,
    notify_on_success !== undefined ? (notify_on_success ? 1 : 0) : 1,
    notify_on_failure !== undefined ? (notify_on_failure ? 1 : 0) : 1,
  );

  const job = db.prepare('SELECT * FROM hyper_backup_jobs WHERE id = ?').get(result.lastInsertRowid);

  if (job.enabled) {
    scheduleJob('hyper-backup', job.id, job.cron_expression);
  }

  const binding = describeBinding(job);
  job.remote_api_key = '••••••••';
  delete job.remote_api_key_encrypted;
  res.status(201).json({ ...job, ...binding });
});

// Update a job
router.put('/jobs/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM hyper_backup_jobs WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Job not found' });

  const {
    name, direction, remote_api_key, local_path, remote_path,
    ssh_user, ssh_host, ssh_port, cron_expression, enabled,
    notify_mode, notify_on_start, notify_on_success, notify_on_failure,
  } = req.body;
  let { remote_url, peer_static_pubkey } = req.body;
  if (cron_expression !== undefined && !validateCronExpression(cron_expression)) {
    return res.status(400).json({ error: 'cron_expression must be a valid 5-field cron expression' });
  }

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
  if (ssh_host && !validateSshHost(ssh_host)) {
    return res.status(400).json({ error: 'ssh_host must be a valid hostname or IP (letters, digits, dot, dash, underscore)' });
  }
  if (ssh_user && !validateSshUser(ssh_user)) {
    return res.status(400).json({ error: 'ssh_user must be a non-root account containing only letters, digits, dot, dash, or underscore' });
  }

  // Re-bind to the selected peer. When the job keeps its destination we still
  // re-read the pairing, so a re-paired peer's rotated key and moved address
  // are picked up instead of the stale values stored on the job.
  const requestedStaticKey = peer_static_pubkey ?? (remote_url === undefined ? existing.peer_static_pubkey : null);
  const targetRemoteUrl = remote_url ?? existing.remote_url;
  const pairing = getPairingKey({ staticPublicKey: requestedStaticKey, remoteUrl: targetRemoteUrl });
  if (peer_static_pubkey && !pairing) {
    return res.status(400).json({ error: 'Selected peer is not paired — pair it in Settings first' });
  }
  const peerStaticPublicKey = pairing?.remote_static_pubkey
    || (targetRemoteUrl === existing.remote_url ? existing.peer_static_pubkey : null);
  const effectiveRemoteUrl = pairing?.remote_url || targetRemoteUrl;

  const hasNewApiKey = remote_api_key && remote_api_key !== '••••••••';
  const encryptedApiKey = hasNewApiKey
    ? encryptPeerApiKey(remote_api_key)
    : (pairing?.api_key_encrypted || existing.remote_api_key_encrypted);

  db.prepare(`
    UPDATE hyper_backup_jobs SET
      name = ?, direction = ?, remote_url = ?, remote_api_key = ?, remote_api_key_encrypted = ?, peer_static_pubkey = ?,
      local_path = ?, remote_path = ?, ssh_user = ?, ssh_host = ?,
      ssh_port = ?, cron_expression = ?, enabled = ?,
      notify_mode = ?, notify_on_start = ?, notify_on_success = ?, notify_on_failure = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    name ?? existing.name,
    direction ?? existing.direction,
    effectiveRemoteUrl,
    encryptedPeerKeyMarker(),
    encryptedApiKey,
    peerStaticPublicKey,
    local_path ? normalizePath(local_path) : existing.local_path,
    remote_path ? normalizePath(remote_path) : existing.remote_path,
    ssh_user ?? existing.ssh_user,
    ssh_host ?? existing.ssh_host,
    ssh_port ?? existing.ssh_port,
    cron_expression ?? existing.cron_expression,
    enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled,
    notify_mode || existing.notify_mode || 'global',
    notify_on_start !== undefined ? (notify_on_start ? 1 : 0) : existing.notify_on_start,
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

  const binding = describeBinding(updated);
  updated.remote_api_key = '••••••••';
  delete updated.remote_api_key_encrypted;
  res.json({ ...updated, ...binding });
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

  try {
    const claim = startClaimedRun({
      db,
      feature: 'hyper-backup',
      configId: job.id,
      peerStaticPublicKey: job.peer_static_pubkey,
      execute: executeHyperBackup,
      onError: err => console.error(`[hyper-backup] Run failed for job ${job.id}:`, err.message),
    });
    if (!claim.claimed) {
      return res.status(409).json({ error: 'Backup is already running', activeRunId: claim.runId });
    }
    res.json({ runId: claim.runId, status: 'started' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cancel a running backup
router.post('/runs/:id/cancel', (req, res) => {
  const runId = parseInt(req.params.id);
  const result = cancelFeatureRun(db, { feature: 'hyper-backup', runId, cancelProcess: cancelHyperRun });
  if (!result.ok) return res.status(result.statusCode).json({ error: result.error });
  const job = db.prepare('SELECT * FROM hyper_backup_jobs WHERE id = ?').get(result.run.config_id);
  if (job && shouldNotify(job, 'cancel')) notifyJobCancelled('Hyper Backup', job.name);
  res.json({ status: 'cancelled' });
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

// Helper: look up API key for a paired remote URL
function getPairingKeyByUrl(remoteUrl) {
  return getPairingKey({ remoteUrl });
}

// Browse directories on a remote peer (proxy to peer API)
router.get('/remote-browse', async (req, res) => {
  const { remote_url, dir } = req.query;

  if (!remote_url || !validateUrl(remote_url)) {
    return res.status(400).json({ error: 'remote_url query parameter is required and must be a valid URL' });
  }

  const pairing = getPairingKeyByUrl(remote_url);
  if (!pairing?.api_key) {
    return res.status(404).json({ error: 'No accepted pairing found for this remote URL' });
  }

  try {
    const result = await browsePeerDirectory(remote_url, pairing.api_key, dir || '');
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Get filesystem roots on a remote peer (proxy to peer API)
router.get('/remote-roots', async (req, res) => {
  const { remote_url } = req.query;

  if (!remote_url || !validateUrl(remote_url)) {
    return res.status(400).json({ error: 'remote_url query parameter is required and must be a valid URL' });
  }

  const pairing = getPairingKeyByUrl(remote_url);
  if (!pairing?.api_key) {
    return res.status(404).json({ error: 'No accepted pairing found for this remote URL' });
  }

  try {
    let result = await getPeerRoots(remote_url, pairing.api_key);

    // Filter out hidden remote drives
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'hidden_remote_drives'").get();
      const hidden = JSON.parse(row?.value || '[]');
      if (hidden.length > 0) {
        result = result.filter(r => !hidden.some(h => r.path === h || r.path.startsWith(h + '/')));
      }
    } catch { /* ignore */ }

    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Get shares on a remote peer (proxy to peer API)
router.get('/remote-shares', async (req, res) => {
  const { remote_url } = req.query;

  if (!remote_url || !validateUrl(remote_url)) {
    return res.status(400).json({ error: 'remote_url query parameter is required and must be a valid URL' });
  }

  const pairing = getPairingKeyByUrl(remote_url);
  if (!pairing?.api_key) {
    return res.status(404).json({ error: 'No accepted pairing found for this remote URL' });
  }

  try {
    let result = await getPeerShares(remote_url, pairing.api_key);

    // Filter out hidden remote drives
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'hidden_remote_drives'").get();
      const hidden = JSON.parse(row?.value || '[]');
      if (hidden.length > 0) {
        result = result.filter(s => {
          const paths = [s.userPath, s.cachePath, s.path].filter(Boolean);
          return !paths.some(p => hidden.some(h => p === h || p.startsWith(h + '/')));
        });
      }
    } catch { /* ignore */ }

    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// List runs
router.get('/runs', (req, res) => {
  const pagination = normalizePagination(req.query);
  res.json(listFeatureRuns(db, {
    feature: 'hyper-backup',
    configId: req.query.job_id,
    ...pagination,
  }));
});

// Lightweight active progress without file queries
router.get('/runs/:id/progress', (req, res) => {
  const run = getRunProgress(db, 'hyper-backup', req.params.id, getActiveHyperRun);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  return res.json(run);
});

// Get run detail (paginated file list for scale — defaults to first 1000)
router.get('/runs/:id', (req, res) => {
  const run = getRunDetail(db, {
    feature: 'hyper-backup',
    runId: req.params.id,
    query: req.query,
    getActiveRun: getActiveHyperRun,
  });
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json(run);
});

export default router;

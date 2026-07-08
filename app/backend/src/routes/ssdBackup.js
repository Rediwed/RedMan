// SSD Backup routes — CRUD for configs, trigger runs, view run history & reports

import { Router } from 'express';
import db from '../db.js';
import { executeSsdBackup, getActiveRun, cancelSsdRun } from '../services/rsync.js';
import { listSnapshots, browseSnapshot, resolveFilePath, restoreFile, pruneVersions, DEFAULT_RETENTION_POLICY } from '../services/versionBrowser.js';
import { verifyDeltaChain, cleanupTempFile } from '../services/deltaVersion.js';
import { scheduleJob, removeJob, getJobSkipCount, isJobRunning } from '../services/scheduler.js';
import { getShares, browsePath } from '../services/unraid.js';
import { normalizePath } from '../middleware/validation.js';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { basename } from 'path';

const router = Router();

// List auto-detected Unraid shares
router.get('/shares', async (req, res) => {
  try {
    let shares = await getShares();

    // Filter out hidden drives
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'hidden_drives'").get();
      const hidden = JSON.parse(row?.value || '[]');
      if (hidden.length > 0) {
        shares = shares.filter(s => {
          const paths = [s.userPath, s.cachePath, s.path].filter(Boolean);
          return !paths.some(p => hidden.some(h => p === h || p.startsWith(h + '/')));
        });
      }
    } catch { /* ignore */ }

    res.json(shares);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Browse a directory path
router.get('/browse', async (req, res) => {
  const { path } = req.query;
  if (!path) return res.status(400).json({ error: 'path query parameter required' });
  try {
    const entries = await browsePath(path);
    res.json(entries);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List all backup configurations
router.get('/configs', (req, res) => {
  const configs = db.prepare('SELECT * FROM ssd_backup_configs ORDER BY created_at DESC').all();
  const enriched = configs.map(c => ({
    ...c,
    consecutive_skips: getJobSkipCount('ssd-backup', c.id),
    scheduler_running: isJobRunning('ssd-backup', c.id),
  }));
  res.json(enriched);
});

// Get a single config
router.get('/configs/:id', (req, res) => {
  const config = db.prepare('SELECT * FROM ssd_backup_configs WHERE id = ?').get(req.params.id);
  if (!config) return res.status(404).json({ error: 'Config not found' });
  res.json(config);
});

// Create a new backup config
router.post('/configs', (req, res) => {
  const { name, source_path, dest_path, cron_expression, versioning_enabled, retention_days, delta_versioning, delta_threshold, delta_max_chain, delta_keyframe_days, retention_policy, notify_mode, notify_on_start, notify_on_success, notify_on_failure } = req.body;

  if (!name || !source_path || !dest_path) {
    return res.status(400).json({ error: 'name, source_path, and dest_path are required' });
  }

  const result = db.prepare(`
    INSERT INTO ssd_backup_configs (name, source_path, dest_path, cron_expression, versioning_enabled, retention_days, delta_versioning, delta_threshold, delta_max_chain, delta_keyframe_days, retention_policy, notify_mode, notify_on_start, notify_on_success, notify_on_failure)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name, source_path, dest_path,
    cron_expression || '0 * * * *',
    versioning_enabled !== undefined ? (versioning_enabled ? 1 : 0) : 1,
    retention_days !== undefined ? Math.max(0, parseInt(retention_days) || 30) : 30,
    delta_versioning ? 1 : 0,
    delta_threshold !== undefined ? Math.min(90, Math.max(10, parseInt(delta_threshold) || 50)) : 50,
    delta_max_chain !== undefined ? Math.min(50, Math.max(1, parseInt(delta_max_chain) || 10)) : 10,
    delta_keyframe_days !== undefined ? Math.min(30, Math.max(1, parseInt(delta_keyframe_days) || 7)) : 7,
    retention_policy ? JSON.stringify(retention_policy) : JSON.stringify(DEFAULT_RETENTION_POLICY),
    notify_mode || 'global',
    notify_on_start !== undefined ? (notify_on_start ? 1 : 0) : 1,
    notify_on_success !== undefined ? (notify_on_success ? 1 : 0) : 1,
    notify_on_failure !== undefined ? (notify_on_failure ? 1 : 0) : 1,
  );

  const config = db.prepare('SELECT * FROM ssd_backup_configs WHERE id = ?').get(result.lastInsertRowid);

  // Schedule the job
  if (config.enabled) {
    scheduleJob('ssd-backup', config.id, config.cron_expression);
  }

  res.status(201).json(config);
});

// Update a backup config
router.put('/configs/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM ssd_backup_configs WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Config not found' });

  const { name, source_path, dest_path, cron_expression, versioning_enabled, retention_days, delta_versioning, delta_threshold, delta_max_chain, delta_keyframe_days, retention_policy, enabled, notify_mode, notify_on_start, notify_on_success, notify_on_failure } = req.body;

  db.prepare(`
    UPDATE ssd_backup_configs SET
      name = ?, source_path = ?, dest_path = ?, cron_expression = ?,
      versioning_enabled = ?, retention_days = ?, delta_versioning = ?,
      delta_threshold = ?, delta_max_chain = ?, delta_keyframe_days = ?,
      retention_policy = ?, enabled = ?,
      notify_mode = ?, notify_on_start = ?, notify_on_success = ?, notify_on_failure = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    name ?? existing.name,
    source_path ?? existing.source_path,
    dest_path ?? existing.dest_path,
    cron_expression ?? existing.cron_expression,
    versioning_enabled !== undefined ? (versioning_enabled ? 1 : 0) : existing.versioning_enabled,
    retention_days !== undefined ? Math.max(0, parseInt(retention_days) || 30) : existing.retention_days,
    delta_versioning !== undefined ? (delta_versioning ? 1 : 0) : existing.delta_versioning,
    delta_threshold !== undefined ? Math.min(90, Math.max(10, parseInt(delta_threshold) || 50)) : existing.delta_threshold,
    delta_max_chain !== undefined ? Math.min(50, Math.max(1, parseInt(delta_max_chain) || 10)) : existing.delta_max_chain,
    delta_keyframe_days !== undefined ? Math.min(30, Math.max(1, parseInt(delta_keyframe_days) || 7)) : existing.delta_keyframe_days,
    retention_policy ? JSON.stringify(retention_policy) : existing.retention_policy,
    enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled,
    notify_mode || existing.notify_mode || 'global',
    notify_on_start !== undefined ? (notify_on_start ? 1 : 0) : existing.notify_on_start,
    notify_on_success !== undefined ? (notify_on_success ? 1 : 0) : existing.notify_on_success,
    notify_on_failure !== undefined ? (notify_on_failure ? 1 : 0) : existing.notify_on_failure,
    req.params.id,
  );

  const updated = db.prepare('SELECT * FROM ssd_backup_configs WHERE id = ?').get(req.params.id);

  // Update schedule
  if (updated.enabled) {
    scheduleJob('ssd-backup', updated.id, updated.cron_expression);
  } else {
    removeJob('ssd-backup', updated.id);
  }

  res.json(updated);
});

// Delete a backup config
router.delete('/configs/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM ssd_backup_configs WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Config not found' });

  removeJob('ssd-backup', existing.id);
  db.prepare('DELETE FROM ssd_backup_configs WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Trigger a manual backup run
router.post('/configs/:id/run', async (req, res) => {
  const config = db.prepare('SELECT * FROM ssd_backup_configs WHERE id = ?').get(req.params.id);
  if (!config) return res.status(404).json({ error: 'Config not found' });

  try {
    const run = db.prepare(`
      INSERT INTO backup_runs (feature, config_id, status) VALUES ('ssd-backup', ?, 'running')
    `).run(config.id);
    const runId = Number(run.lastInsertRowid);

    executeSsdBackup(config.id, runId).catch(err => {
      console.error(`[ssd-backup] Run failed for config ${config.id}:`, err.message);
    });

    res.json({ runId, status: 'started' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cancel a running backup
router.post('/runs/:id/cancel', (req, res) => {
  const runId = parseInt(req.params.id);
  const run = db.prepare('SELECT * FROM backup_runs WHERE id = ?').get(runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (run.status !== 'running') return res.status(400).json({ error: 'Run is not active' });
  const killed = cancelSsdRun(runId);
  if (killed) {
    db.prepare("UPDATE backup_runs SET status = 'cancelled', completed_at = datetime('now'), error_message = 'Cancelled by user' WHERE id = ?").run(runId);
    res.json({ status: 'cancelled' });
  } else {
    res.status(400).json({ error: 'Could not cancel — process not found' });
  }
});

// List backup runs (paginated)
router.get('/runs', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;
  const configId = req.query.config_id;

  let query = 'SELECT * FROM backup_runs WHERE feature = \'ssd-backup\'';
  let countQuery = 'SELECT COUNT(*) as total FROM backup_runs WHERE feature = \'ssd-backup\'';
  const params = [];

  if (configId) {
    query += ' AND config_id = ?';
    countQuery += ' AND config_id = ?';
    params.push(configId);
  }

  const total = db.prepare(countQuery).get(...params).total;
  const runs = db.prepare(query + ' ORDER BY started_at DESC LIMIT ? OFFSET ?').all(...params, limit, offset);

  res.json({
    runs,
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  });
});

// Get run detail with file list (paginated + filterable)
router.get('/runs/:id', (req, res) => {
  const run = db.prepare('SELECT * FROM backup_runs WHERE id = ? AND feature = \'ssd-backup\'').get(req.params.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });

  const filePage = Math.max(1, parseInt(req.query.filePage) || 1);
  const fileLimit = Math.min(5000, Math.max(1, parseInt(req.query.fileLimit) || 1000));
  const fileOffset = (filePage - 1) * fileLimit;
  const actionFilter = req.query.action || null;

  let whereClause = 'WHERE run_id = ?';
  const params = [run.id];
  if (actionFilter) {
    whereClause += ' AND action = ?';
    params.push(actionFilter);
  }

  const totalFiles = db.prepare(`SELECT COUNT(*) as count FROM backup_run_files ${whereClause}`).get(...params).count;
  const files = db.prepare(`SELECT * FROM backup_run_files ${whereClause} ORDER BY file_path LIMIT ? OFFSET ?`).all(...params, fileLimit, fileOffset);

  // Action breakdown for filter UI
  const actionCounts = db.prepare('SELECT action, COUNT(*) as count FROM backup_run_files WHERE run_id = ? GROUP BY action').all(run.id);

  // Check if still running
  const progress = getActiveRun(run.id);

  res.json({ ...run, files, totalFiles, filePage, fileLimit, filePages: Math.ceil(totalFiles / fileLimit), actionCounts, liveProgress: progress || null });
});

// ===== Version Browser =====

// Manually prune old version snapshots
router.post('/configs/:id/prune', async (req, res) => {
  try {
    const result = await pruneVersions(parseInt(req.params.id));
    res.json(result);
  } catch (err) {
    res.status(err.message === 'Config not found' ? 404 : 500).json({ error: err.message });
  }
});

// List available snapshots for a config
router.get('/configs/:id/snapshots', async (req, res) => {
  try {
    const snapshots = await listSnapshots(parseInt(req.params.id));
    res.json(snapshots);
  } catch (err) {
    res.status(err.message === 'Config not found' ? 404 : 500).json({ error: err.message });
  }
});

// Browse file tree at a specific snapshot
router.get('/configs/:id/browse', async (req, res) => {
  const { timestamp, path: subPath } = req.query;
  if (!timestamp) return res.status(400).json({ error: 'timestamp query parameter required' });

  try {
    const entries = await browseSnapshot(parseInt(req.params.id), timestamp, subPath || '');
    res.json(entries);
  } catch (err) {
    res.status(err.message === 'Config not found' ? 404 : 500).json({ error: err.message });
  }
});

// MIME types for inline preview
const MIME_TYPES = {
  '.txt': 'text/plain', '.md': 'text/plain', '.log': 'text/plain',
  '.json': 'application/json', '.csv': 'text/csv', '.xml': 'text/xml',
  '.html': 'text/html', '.htm': 'text/html',
  '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.py': 'text/x-python', '.sh': 'text/x-sh',
  '.yml': 'text/yaml', '.yaml': 'text/yaml', '.toml': 'text/plain',
  '.env': 'text/plain', '.cfg': 'text/plain', '.ini': 'text/plain',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
};

function getMimeType(fileName) {
  const ext = '.' + fileName.split('.').pop().toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

// Download (or inline preview) a file from a specific snapshot
router.get('/configs/:id/download', async (req, res) => {
  const { timestamp, path: filePath, inline } = req.query;
  if (!timestamp || !filePath) return res.status(400).json({ error: 'timestamp and path query parameters required' });
  // Defence-in-depth: reject metachars and any unresolved '..' segments before path.join.
  // resolveFilePath() also re-resolves against the snapshot root, but normalising up-front
  // prevents URL-encoded variants from sneaking past the literal `..` substring check.
  const normalized = normalizePath(filePath.startsWith('/') ? filePath : `/${filePath}`);
  if (!normalized) return res.status(400).json({ error: 'Invalid path' });

  try {
    const resolved = await resolveFilePath(parseInt(req.params.id), timestamp, filePath);
    const info = await stat(resolved.path);
    const fileName = basename(resolved.path).replace(/\.rdelta$/, '');

    if (inline === 'true') {
      const mime = getMimeType(fileName);
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    } else {
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    }
    res.setHeader('Content-Length', info.size);

    const stream = createReadStream(resolved.path);
    stream.pipe(res);

    // Clean up temp file after streaming completes
    if (resolved.isTemp) {
      res.on('finish', () => cleanupTempFile(resolved.path));
      res.on('error', () => cleanupTempFile(resolved.path));
    }
  } catch (err) {
    res.status(err.message.includes('not found') ? 404 : 500).json({ error: err.message });
  }
});

// Restore a file from a snapshot to the source location
router.post('/configs/:id/restore', async (req, res) => {
  const { timestamp, path: filePath } = req.body;
  if (!timestamp || !filePath) return res.status(400).json({ error: 'timestamp and path are required' });

  try {
    const result = await restoreFile(parseInt(req.params.id), timestamp, filePath);
    res.json(result);
  } catch (err) {
    res.status(err.message.includes('not found') ? 404 : 500).json({ error: err.message });
  }
});

// Verify delta chain integrity for a config
router.post('/configs/:id/verify-versions', async (req, res) => {
  try {
    const result = await verifyDeltaChain(parseInt(req.params.id));
    res.json(result);
  } catch (err) {
    res.status(err.message === 'Config not found' ? 404 : 500).json({ error: err.message });
  }
});

export default router;

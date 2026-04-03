// Peer API — separate Express app on port 8091
// Machine-to-machine API for Hyper Backup cross-site operations
// Authenticated via per-peer Bearer API keys (not Authelia)

import express from 'express';
import { execFileSync } from 'child_process';
import rateLimit from 'express-rate-limit';
import { peerAuth } from './middleware/auth.js';
import { normalizePath, isWithinPrefix, validateDirection } from './middleware/validation.js';
import db from './db.js';
import { notifyJobError } from './services/notify.js';

const logAudit = db.prepare(`
  INSERT INTO peer_audit_log (peer_id, peer_name, action, details, ip_address)
  VALUES (?, ?, ?, ?, ?)
`);

export function createPeerApi() {
  const app = express();
  app.use(express.json());

  // Rate limiting — 120 req/min for all peer requests
  app.use(rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, try again later' },
  }));

  // All peer routes require API key auth
  app.use(peerAuth(db));

  // Health check — returns instance info
  app.get('/peer/health', (req, res) => {
    const instanceName = db.prepare('SELECT value FROM settings WHERE key = ?').get('instance_name');
    logAudit.run(req.peer.id, req.peer.name, 'health_check', null, req.peerIp);
    res.json({
      ok: true,
      instance: instanceName?.value || 'RedMan',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
    });
  });

  // Prepare for incoming backup (remote wants to push/pull)
  app.post('/peer/backup/prepare', (req, res) => {
    const { direction, remotePath, runId } = req.body;

    if (!direction || !remotePath) {
      return res.status(400).json({ error: 'direction and remotePath are required' });
    }

    if (!validateDirection(direction)) {
      return res.status(400).json({ error: 'direction must be "push" or "pull"' });
    }

    // Normalize and validate path against peer's allowed prefix
    const normalizedPath = normalizePath(remotePath);
    if (!normalizedPath) {
      return res.status(400).json({ error: 'remotePath must be a valid absolute path' });
    }

    if (!isWithinPrefix(normalizedPath, req.peer.allowed_path_prefix)) {
      logAudit.run(req.peer.id, req.peer.name, 'path_rejected', JSON.stringify({
        remotePath: normalizedPath,
        allowedPrefix: req.peer.allowed_path_prefix,
        runId,
      }), req.peerIp);
      return res.status(403).json({
        error: `Path "${normalizedPath}" is outside allowed prefix "${req.peer.allowed_path_prefix}"`,
      });
    }

    // Check storage quota if the peer is pushing data to us
    if (direction === 'push' && req.peer.storage_limit_bytes > 0) {
      const usage = getDiskUsage(normalizedPath);
      if (usage >= 0 && usage >= req.peer.storage_limit_bytes) {
        const usedGB = (usage / (1024 ** 3)).toFixed(2);
        const limitGB = (req.peer.storage_limit_bytes / (1024 ** 3)).toFixed(2);
        logAudit.run(req.peer.id, req.peer.name, 'quota_exceeded', JSON.stringify({
          remotePath: normalizedPath, usedBytes: usage,
          limitBytes: req.peer.storage_limit_bytes, runId,
        }), req.peerIp);
        return res.status(507).json({
          error: `Storage quota exceeded: using ${usedGB} GB of ${limitGB} GB allowed`,
          usedBytes: usage,
          limitBytes: req.peer.storage_limit_bytes,
        });
      }
    }

    logAudit.run(req.peer.id, req.peer.name, 'backup_prepare', JSON.stringify({
      direction, remotePath: normalizedPath, runId,
    }), req.peerIp);

    const storageInfo = {};
    if (req.peer.storage_limit_bytes > 0) {
      const usage = getDiskUsage(normalizedPath);
      storageInfo.usedBytes = usage >= 0 ? usage : null;
      storageInfo.limitBytes = req.peer.storage_limit_bytes;
    }

    res.json({
      ok: true,
      message: 'Ready for backup',
      runId,
      sshHost: getLocalIp(),
      sshUser: process.env.SSH_USER || 'root',
      sshPort: parseInt(process.env.SSH_PORT || '22'),
      storage: Object.keys(storageInfo).length > 0 ? storageInfo : undefined,
    });
  });

  // Backup transfer complete notification
  app.post('/peer/backup/complete', (req, res) => {
    const { runId, status, stats } = req.body;
    logAudit.run(req.peer.id, req.peer.name, 'backup_complete', JSON.stringify({
      runId, status, stats: stats || null,
    }), req.peerIp);
    console.log(`[peer] Backup run ${runId} from ${req.peer.name} completed: ${status}`);
    res.json({ ok: true, acknowledged: true });
  });

  // Check status of an active transfer
  app.get('/peer/backup/status/:runId', (req, res) => {
    const run = db.prepare('SELECT * FROM backup_runs WHERE id = ?').get(req.params.runId);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    logAudit.run(req.peer.id, req.peer.name, 'status_check', JSON.stringify({
      runId: req.params.runId,
    }), req.peerIp);
    res.json(run);
  });

  // Peer shutdown notification — remote peer is going offline
  app.post('/peer/shutdown', (req, res) => {
    const { reason } = req.body || {};
    const peerName = req.peer.name;
    console.log(`[peer] Received shutdown notification from "${peerName}"${reason ? `: ${reason}` : ''}`);

    logAudit.run(req.peer.id, req.peer.name, 'shutdown_notify', JSON.stringify({
      reason: reason || 'graceful shutdown',
    }), req.peerIp);

    // Update last_seen_at
    db.prepare('UPDATE authorized_peers SET last_seen_at = datetime(\'now\') WHERE id = ?').run(req.peer.id);

    // Fail any running hyper backup jobs targeting this peer
    const jobs = db.prepare(`
      SELECT hj.id, hj.name, hj.remote_url FROM hyper_backup_jobs hj
      INNER JOIN backup_runs br ON br.config_id = hj.id AND br.feature = 'hyper-backup'
      WHERE br.status = 'running'
    `).all();

    let affectedCount = 0;
    for (const job of jobs) {
      try {
        const jobUrl = new URL(job.remote_url);
        const peerHost = req.ip || req.peerIp;
        // Match by peer identity — the peer that sent the shutdown is the one we care about
        db.prepare(`
          UPDATE backup_runs SET status = 'failed', completed_at = datetime('now'),
            error_message = 'Remote peer "' || ? || '" is shutting down'
          WHERE config_id = ? AND feature = 'hyper-backup' AND status = 'running'
        `).run(peerName, job.id);
        affectedCount++;
      } catch {}
    }

    if (affectedCount > 0) {
      console.log(`[peer] Marked ${affectedCount} active job(s) as failed due to peer "${peerName}" shutting down`);
    }

    // Send browser/ntfy notification so the user knows
    notifyJobError('Hyper Backup', peerName, `Peer "${peerName}" is shutting down — active transfers will be interrupted`);

    res.json({ ok: true, acknowledged: true });
  });

  // Get storage usage and quota for this peer
  app.get('/peer/storage', (req, res) => {
    const prefix = req.peer.allowed_path_prefix;
    const limitBytes = req.peer.storage_limit_bytes || 0;
    const usedBytes = getDiskUsage(prefix);

    logAudit.run(req.peer.id, req.peer.name, 'storage_check', JSON.stringify({
      prefix, usedBytes, limitBytes,
    }), req.peerIp);

    res.json({
      ok: true,
      prefix,
      usedBytes: usedBytes >= 0 ? usedBytes : null,
      limitBytes,
      unlimited: limitBytes === 0,
      usedPercent: limitBytes > 0 && usedBytes >= 0
        ? Math.round((usedBytes / limitBytes) * 100)
        : null,
    });
  });

  return app;
}

// Get disk usage of a path in bytes using du
function getDiskUsage(dirPath) {
  try {
    const output = execFileSync('du', ['-sk', dirPath], {
      encoding: 'utf-8', timeout: 30000,
    });
    const kb = parseInt(output.split('\t')[0]);
    return isNaN(kb) ? -1 : kb * 1024;
  } catch {
    return -1;
  }
}

function getLocalIp() {
  // In production, this would be the WireGuard tunnel IP (100.90.128.x)
  // Fallback to hostname for dev
  return process.env.PEER_HOST || '0.0.0.0';
}

// Peer API — separate Express app on port 8091
// Machine-to-machine API for Hyper Backup cross-site operations
// Authenticated via per-peer Bearer API keys (not Authelia)

import express from 'express';
import { execFileSync } from 'child_process';
import { readdirSync, statSync, existsSync, mkdirSync } from 'fs';
import { join, resolve, dirname } from 'path';
import os from 'os';
import rateLimit from 'express-rate-limit';
import { peerAuth } from './middleware/auth.js';
import { normalizePath, isWithinPrefix, validateDirection } from './middleware/validation.js';
import { safeIp } from './utils/logRedact.js';
import db from './db.js';
import { notifyJobError, sendBrowser } from './services/notify.js';
import { receiveRequest, handlePairingCallback } from './services/pairing.js';
import { getShares } from './services/unraid.js';

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

  // Discovery endpoint — unauthenticated, returns minimal instance info for network scanning
  app.get('/peer/discover', (req, res) => {
    const instanceName = db.prepare('SELECT value FROM settings WHERE key = ?').get('instance_name');
    res.json({
      service: 'redman',
      instance: instanceName?.value || 'RedMan',
      version: '1.0.0',
      hostname: os.hostname(),
    });
  });

  // ── Pairing endpoints — unauthenticated (before peerAuth middleware) ──

  // Receive an incoming pairing request from another RedMan instance
  // V2: Requires Noise XX handshake fields (ephemeral_pubkey, static_pubkey, signature)
  app.post('/peer/pair/request', (req, res) => {
    const body = req.body;
    // Prefer the socket peer address — X-Forwarded-For is attacker-controlled unless behind a trusted proxy
    const ip = safeIp(req.socket?.remoteAddress || req.headers['x-forwarded-for']);

    // Reject old-style (v1) requests — require handshake v2
    if (!body.version || body.version < 2) {
      return res.status(426).json({
        error: 'Upgrade Required — this instance requires handshake version 2 (Noise XX). Update RedMan on the sending peer.',
        required_version: 2,
      });
    }

    if (!body.instance || !body.token) {
      return res.status(400).json({ error: 'instance and token are required' });
    }

    // Determine callback URL — prefer the explicitly declared callback_url if it's a private IP
    // (the initiator knows their own reachable address better than we do, especially cross-VPN).
    // Fall back to socket IP only if no valid private callback_url is provided.
    const cleanIp = ip.replace(/^::ffff:/, '');
    let actualCallbackUrl;
    if (body.callback_url) {
      try {
        const cbUrl = new URL(body.callback_url);
        const cbHost = cbUrl.hostname;
        // Accept any RFC1918 / CGNAT private address the peer claims — reject public IPs (SSRF guard)
        const parts = cbHost.split('.').map(Number);
        const isPrivate = (
          parts[0] === 10 ||
          (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
          (parts[0] === 192 && parts[1] === 168) ||
          (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
        );
        actualCallbackUrl = isPrivate
          ? body.callback_url.replace(/\/$/, '')
          : `http://${cleanIp}:${cbUrl.port || '8091'}`;
      } catch {
        actualCallbackUrl = `http://${cleanIp}:8091`;
      }
    } else {
      actualCallbackUrl = `http://${cleanIp}:8091`;
    }

    const result = receiveRequest(body, actualCallbackUrl, cleanIp);
    if (result.error) {
      return res.status(result.status || 400).json({ error: result.error });
    }

    // Send SSE notification to browser
    sendBrowser('pairing_request', `🔗 Pairing Request`, `${body.instance} wants to connect`);

    res.json(result);
  });

  // Receive a pairing callback (initiator gets this when remote accepts)
  // V2: Contains encrypted payload — no cleartext API key
  app.post('/peer/pair/callback', (req, res) => {
    const body = req.body;

    // Reject old-style callbacks
    if (!body.version || body.version < 2) {
      return res.status(426).json({
        error: 'Upgrade Required — handshake version 2 required',
        required_version: 2,
      });
    }

    if (!body.token || !body.encrypted_payload) {
      return res.status(400).json({ error: 'token and encrypted_payload are required' });
    }

    try {
      const result = handlePairingCallback(body);
      if (result.error) {
        return res.status(400).json(result);
      }
      res.json(result);
    } catch (err) {
      console.error('[peerApi] handlePairingCallback threw:', err);
      res.status(500).json({ error: err.message || 'Callback processing failed' });
    }
  });

  // All peer routes below require API key auth
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

    // Ensure destination directory exists when peer is pushing to us
    if (direction === 'push') {
      try {
        mkdirSync(normalizedPath, { recursive: true });
      } catch (err) {
        return res.status(500).json({ error: `Failed to create destination: ${err.message}` });
      }
    }

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

    // Update last_seen_at and last_seen_ip
    db.prepare('UPDATE authorized_peers SET last_seen_at = datetime(\'now\'), last_seen_ip = ? WHERE id = ?').run(req.peerIp, req.peer.id);

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

  // Browse directories on this peer — scoped to allowed_path_prefix
  app.get('/peer/browse', (req, res) => {
    const prefix = req.peer.allowed_path_prefix;
    const dir = req.query.dir || prefix;

    // Normalize and validate path
    const normalizedDir = normalizePath(dir);
    if (!normalizedDir) {
      return res.status(400).json({ error: 'Invalid directory path' });
    }

    // Enforce path prefix — peer can only browse within their allowed prefix
    if (!isWithinPrefix(normalizedDir, prefix)) {
      logAudit.run(req.peer.id, req.peer.name, 'browse_rejected', JSON.stringify({
        dir: normalizedDir, allowedPrefix: prefix,
      }), req.peerIp);
      return res.status(403).json({
        error: `Path "${normalizedDir}" is outside allowed prefix "${prefix}"`,
      });
    }

    try {
      if (!existsSync(normalizedDir)) {
        return res.status(404).json({ error: 'Directory not found' });
      }

      const stat = statSync(normalizedDir);
      if (!stat.isDirectory()) {
        return res.status(400).json({ error: 'Path is not a directory' });
      }

      const rawEntries = readdirSync(normalizedDir, { withFileTypes: true });
      const entries = [];

      for (const entry of rawEntries) {
        if (entry.name.startsWith('.')) continue;
        if (!entry.isDirectory()) continue;

        const fullPath = join(normalizedDir, entry.name);

        // Only include entries still within allowed prefix
        if (!isWithinPrefix(fullPath, prefix)) continue;

        try {
          entries.push({ name: entry.name, path: fullPath, type: 'directory' });
        } catch { /* permission denied — skip */ }
      }

      entries.sort((a, b) => a.name.localeCompare(b.name));

      // Clamp parent to the allowed prefix (don't let them navigate above it)
      const rawParent = dirname(resolve(normalizedDir));
      const parent = isWithinPrefix(rawParent, prefix) ? rawParent : prefix;

      logAudit.run(req.peer.id, req.peer.name, 'browse', JSON.stringify({
        dir: normalizedDir,
      }), req.peerIp);

      res.json({
        current: resolve(normalizedDir),
        parent,
        prefix,
        entries,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get filesystem roots on this peer — scoped to allowed_path_prefix
  app.get('/peer/roots', (req, res) => {
    const prefix = req.peer.allowed_path_prefix;
    const home = os.homedir();
    const roots = [];

    const candidates = [
      { name: 'Home', path: home, icon: 'home' },
      { name: 'Shares', path: '/mnt/user', icon: 'drive' },
      { name: 'Cache', path: '/mnt/cache', icon: 'drive' },
      { name: 'Disks', path: '/mnt/disks', icon: 'drive' },
      { name: '/mnt', path: '/mnt', icon: 'folder' },
      { name: 'Media', path: '/media', icon: 'drive' },
      { name: 'Volumes', path: '/Volumes', icon: 'drive' },
      { name: '/', path: '/', icon: 'folder' },
    ];

    for (const c of candidates) {
      // Only include roots within or containing the allowed prefix
      if (!isWithinPrefix(c.path, prefix) && !isWithinPrefix(prefix, c.path)) continue;
      try {
        if (existsSync(c.path) && statSync(c.path).isDirectory()) {
          roots.push(c);
        }
      } catch { /* skip */ }
    }

    // If the prefix itself isn't covered by any candidate, add it as a root
    if (roots.length === 0 || !roots.some(r => r.path === prefix)) {
      try {
        if (existsSync(prefix) && statSync(prefix).isDirectory()) {
          const name = prefix === '/' ? '/' : prefix.split('/').pop() || prefix;
          roots.unshift({ name, path: prefix, icon: 'folder' });
        }
      } catch { /* skip */ }
    }

    logAudit.run(req.peer.id, req.peer.name, 'roots', null, req.peerIp);
    res.json(roots);
  });

  // Get Unraid shares on this peer — scoped to allowed_path_prefix
  app.get('/peer/shares', async (req, res) => {
    const prefix = req.peer.allowed_path_prefix;

    try {
      const allShares = await getShares();

      // Filter shares to those within the allowed prefix
      const filtered = allShares.filter(s => {
        const sharePath = s.userPath || s.cachePath || s.path;
        if (!sharePath) return false;
        return isWithinPrefix(sharePath, prefix) || isWithinPrefix(prefix, sharePath);
      });

      logAudit.run(req.peer.id, req.peer.name, 'shares', JSON.stringify({
        total: allShares.length, visible: filtered.length,
      }), req.peerIp);

      res.json(filtered);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Global JSON error handler for peer API — catches any unhandled throws (crypto, SQLite, etc.)
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[peerApi] Unhandled error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
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

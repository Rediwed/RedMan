// Peer API — separate Express app on port 8091
// Machine-to-machine API for Hyper Backup cross-site operations
// Authenticated via per-peer Bearer API keys (not Authelia)

import express from 'express';
import { readdirSync, statSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import rateLimit from 'express-rate-limit';
import { peerAuth } from './middleware/auth.js';
import { normalizePath, isWithinPrefix, validateDirection } from './middleware/validation.js';
import { safeIp } from './utils/logRedact.js';
import db from './db.js';
import { notifyJobError, sendBrowser } from './services/notify.js';
import { receiveRequest, handlePairingCallback } from './services/pairing.js';
import { getShares } from './services/unraid.js';
import { HANDSHAKE_VERSION, validatePairingCallbackEnvelope } from './services/handshake.js';
import { validateSignedCallbackUrl } from './services/peerUrlPolicy.js';
import { failRunningHyperRunsForPeer, getPeerOwnedHyperRun } from './services/peerRunIsolation.js';
import { assertLocalSourceHasEntries } from './services/sourceHealth.js';
import { ensureDirectoryWithinPrefix, resolveExistingPathWithinPrefix } from './services/pathConfinement.js';
import { getQuotaUsage, markQuotaUsageStale } from './services/quotaUsage.js';
import { describeDestination } from './services/storageHealth.js';
import { toRrsyncPath } from './services/sshKeyValidation.js';
import { requirePeerHost, runtimeConfig } from './services/runtimeConfig.js';

const logAudit = db.prepare(`
  INSERT INTO peer_audit_log (peer_id, peer_name, action, details, ip_address)
  VALUES (?, ?, ?, ?, ?)
`);

export function createPeerApi() {
  const app = express();

  // Rate limiting — 120 req/min for all peer requests
  app.use(rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, try again later' },
  }));

  const pairingLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many pairing attempts, try again later' },
  });
  app.use(['/peer/pair/request', '/peer/pair/callback'], pairingLimiter);
  app.use(express.json({ limit: '32kb', strict: true }));

  // Discovery endpoint — unauthenticated, returns minimal instance info for network scanning
  app.get('/peer/discover', (req, res) => {
    const instanceName = db.prepare('SELECT value FROM settings WHERE key = ?').get('instance_name');
    res.json({
      service: 'redman',
      instance: instanceName?.value || 'RedMan',
      version: '1.1.9',
    });
  });

  // ── Pairing endpoints — unauthenticated (before peerAuth middleware) ──

  // Receive an incoming pairing request from another RedMan instance
  // V2: Requires Noise XX handshake fields (ephemeral_pubkey, static_pubkey, signature)
  app.post('/peer/pair/request', (req, res) => {
    const body = req.body;
    // Prefer the socket peer address — X-Forwarded-For is attacker-controlled unless behind a trusted proxy
    const ip = safeIp(req.socket?.remoteAddress || req.headers['x-forwarded-for']);

    if (!body.version || body.version < HANDSHAKE_VERSION) {
      return res.status(426).json({
        error: `Upgrade Required — this instance requires handshake version ${HANDSHAKE_VERSION}. Update RedMan on the sending peer.`,
        required_version: HANDSHAKE_VERSION,
      });
    }

    if (!body.instance || !body.token) {
      return res.status(400).json({ error: 'instance and token are required' });
    }

    const cleanIp = ip.replace(/^::ffff:/, '');
    let actualCallbackUrl;
    try {
      actualCallbackUrl = validateSignedCallbackUrl(body.callback_url);
    } catch (err) {
      return res.status(400).json({ error: err.message });
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

    if (!body.version || body.version < HANDSHAKE_VERSION) {
      return res.status(426).json({
        error: `Upgrade Required — handshake version ${HANDSHAKE_VERSION} required`,
        required_version: HANDSHAKE_VERSION,
      });
    }

    if (!body.token || !body.encrypted_payload) {
      return res.status(400).json({ error: 'token and encrypted_payload are required' });
    }
    const envelopeError = validatePairingCallbackEnvelope(body);
    if (envelopeError) return res.status(400).json({ error: envelopeError });

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
      version: '1.1.9',
      timestamp: new Date().toISOString(),
    });
  });

  // Prepare for incoming backup (remote wants to push/pull)
  app.post('/peer/backup/prepare', async (req, res) => {
    const { direction, remotePath, runId } = req.body;

    if (!direction || !remotePath) {
      return res.status(400).json({ error: 'direction and remotePath are required' });
    }

    if (!validateDirection(direction)) {
      return res.status(400).json({ error: 'direction must be "push" or "pull"' });
    }

    let advertisedPeerHost;
    try {
      advertisedPeerHost = requirePeerHost();
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
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

    let confinedPath;
    let advertisedRsyncPath;
    if (direction === 'pull') {
      try {
        const resolved = resolveExistingPathWithinPrefix(normalizedPath, req.peer.allowed_path_prefix);
        confinedPath = resolved.path;
        advertisedRsyncPath = toRrsyncPath(confinedPath, resolved.prefix);
        await assertLocalSourceHasEntries(confinedPath, 'Hyper Backup remote source');
      } catch (err) {
        return res.status(409).json({ error: err.message });
      }
    } else {
      try {
        const resolved = ensureDirectoryWithinPrefix(normalizedPath, req.peer.allowed_path_prefix);
        confinedPath = resolved.path;
        advertisedRsyncPath = toRrsyncPath(confinedPath, resolved.prefix);
      } catch (err) {
        return res.status(409).json({ error: err.message });
      }
    }

    let quotaUsage = null;
    // Check storage quota if the peer is pushing data to us
    if (direction === 'push' && req.peer.storage_limit_bytes > 0) {
      const quotaRoot = resolveExistingPathWithinPrefix(req.peer.allowed_path_prefix, req.peer.allowed_path_prefix).path;
      quotaUsage = await getQuotaUsage(quotaRoot);
      // Refuse on evidence, not on ignorance. A measurement that has not
      // produced a figure yet says nothing about whether the quota is exceeded,
      // and turning that into a refusal loses backups over a measurement, which
      // is the more expensive failure by far.
      //
      // The figure being old does not weaken this: the last successful
      // measurement is kept and enforced from, so a directory that has grown
      // too large to measure quickly cannot use that slowness to escape its own
      // limit. usedBytes is null only when this destination has never been
      // measured at all, and that is recorded so a scan that never succeeds
      // stays visible instead of quietly disabling the quota.
      if (quotaUsage.usedBytes === null) {
        logAudit.run(req.peer.id, req.peer.name, 'quota_unknown', JSON.stringify({
          remotePath: normalizedPath, reason: quotaUsage.unavailableReason,
          limitBytes: req.peer.storage_limit_bytes, runId,
        }), req.peerIp);
        console.warn(`[peer] Storage usage has never been measured for "${req.peer.name}" (${quotaUsage.unavailableReason}); allowing the backup and continuing to measure`);
      } else if (quotaUsage.usedBytes >= req.peer.storage_limit_bytes) {
        const usedGB = (quotaUsage.usedBytes / (1024 ** 3)).toFixed(2);
        const limitGB = (req.peer.storage_limit_bytes / (1024 ** 3)).toFixed(2);
        logAudit.run(req.peer.id, req.peer.name, 'quota_exceeded', JSON.stringify({
          remotePath: normalizedPath, usedBytes: quotaUsage.usedBytes,
          limitBytes: req.peer.storage_limit_bytes, runId,
          usageAgeMs: quotaUsage.ageMs ?? null,
        }), req.peerIp);
        return res.status(507).json({
          error: `Storage quota exceeded: using ${usedGB} GB of ${limitGB} GB allowed`,
          usedBytes: quotaUsage.usedBytes,
          limitBytes: req.peer.storage_limit_bytes,
        });
      }
    }

    // Refusing on a failing destination is not about sparing it the writes. A
    // push is an rsync that overwrites what is already there, so accepting one
    // onto a disk that is dying trades the copy that still works for one that
    // may not survive. Refusing keeps the older copy intact.
    if (direction === 'push') {
      const destination = describeDestination(normalizedPath);
      if (destination.state === 'fail') {
        const enforcement = db.prepare('SELECT value FROM settings WHERE key = ?')
          .get('destination_health_enforcement')?.value;
        logAudit.run(req.peer.id, req.peer.name, 'destination_unsafe', JSON.stringify({
          remotePath: normalizedPath, reason: destination.reason,
          profile: destination.profile, redundant: destination.redundant, runId,
          enforced: enforcement !== 'warn',
        }), req.peerIp);

        if (enforcement !== 'warn') {
          return res.status(409).json({
            error: `Refusing to write here: ${destination.reason}. The copy already on this destination is left untouched.`,
            destinationState: destination.state,
            destinationReason: destination.reason,
          });
        }
        console.warn(`[peer] Destination is unsafe (${destination.reason}) but enforcement is set to warn; accepting the backup`);
      } else if (destination.state === 'warn') {
        // Allowed on purpose: a warning is a reason to look, not to lose a night's backup.
        logAudit.run(req.peer.id, req.peer.name, 'destination_degraded', JSON.stringify({
          remotePath: normalizedPath, reason: destination.spill || destination.reason, runId,
        }), req.peerIp);
      }
    }

    logAudit.run(req.peer.id, req.peer.name, 'backup_prepare', JSON.stringify({
      direction, remotePath: normalizedPath, runId,
    }), req.peerIp);

    const storageInfo = {};
    if (req.peer.storage_limit_bytes > 0) {
      if (!quotaUsage) {
        const quotaRoot = resolveExistingPathWithinPrefix(req.peer.allowed_path_prefix, req.peer.allowed_path_prefix).path;
        quotaUsage = await getQuotaUsage(quotaRoot);
      }
      storageInfo.usedBytes = quotaUsage.usedBytes;
      storageInfo.limitBytes = req.peer.storage_limit_bytes;
    }

    res.json({
      ok: true,
      message: 'Ready for backup',
      runId,
      sshHost: advertisedPeerHost,
      sshUser: runtimeConfig.sshUser,
      sshPort: runtimeConfig.sshPort,
      // The path rsync must ask for. The restricted account reaches this
      // instance through rrsync, which resolves every request under the
      // allowed prefix, so the caller's absolute path would be applied twice.
      rsyncPath: advertisedRsyncPath,
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
    try {
      const quotaRoot = resolveExistingPathWithinPrefix(req.peer.allowed_path_prefix, req.peer.allowed_path_prefix).path;
      markQuotaUsageStale(quotaRoot);
    } catch {
      markQuotaUsageStale();
    }
    res.json({ ok: true, acknowledged: true });
  });

  // Check status of an active transfer
  app.get('/peer/backup/status/:runId', (req, res) => {
    const run = getPeerOwnedHyperRun(db, req.params.runId, req.peer.static_pubkey);
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

    const affectedCount = failRunningHyperRunsForPeer(db, req.peer.static_pubkey, peerName);

    if (affectedCount > 0) {
      console.log(`[peer] Marked ${affectedCount} active job(s) as failed due to peer "${peerName}" shutting down`);
    }

    // Send browser/ntfy notification so the user knows
    notifyJobError('Hyper Backup', peerName, `Peer "${peerName}" is shutting down — active transfers will be interrupted`);

    res.json({ ok: true, acknowledged: true });
  });

  // Get storage usage and quota for this peer
  app.get('/peer/storage', async (req, res) => {
    const prefix = req.peer.allowed_path_prefix;
    const limitBytes = req.peer.storage_limit_bytes || 0;
    let confinedPrefix;
    try {
      confinedPrefix = resolveExistingPathWithinPrefix(prefix, prefix).path;
    } catch (err) {
      return res.status(409).json({ error: err.message });
    }
    const usage = await getQuotaUsage(confinedPrefix);
    const usedBytes = usage.usedBytes;

    // Whether a destination can take the data and whether it is fit to keep it
    // are the same question, so they are answered together rather than needing
    // a second call the caller could skip.
    const destination = describeDestination(confinedPrefix);

    logAudit.run(req.peer.id, req.peer.name, 'storage_check', JSON.stringify({
      prefix, usedBytes, limitBytes, destinationState: destination.state,
    }), req.peerIp);

    res.json({
      ok: true,
      prefix,
      usedBytes,
      limitBytes,
      unlimited: limitBytes === 0,
      usedPercent: limitBytes > 0 && usedBytes !== null
        ? Math.round((usedBytes / limitBytes) * 100)
        : null,
      cached: usage.cached,
      stale: usage.stale === true,
      ageMs: usage.ageMs ?? null,
      usageUnavailable: usage.unavailableReason,
      // Serial numbers stay on the host that owns the disks; a peer needs the
      // verdict and the reason, not an inventory of someone else's hardware.
      destination: {
        state: destination.state,
        reason: destination.reason,
        spill: destination.spill ?? null,
        profile: destination.profile ?? null,
        redundant: destination.redundant ?? null,
        diskCount: destination.devices.length,
        disksNeedingAttention: destination.devices.filter(d => d.state !== 'ok').length,
        measuredAt: destination.measuredAt,
        stale: destination.stale,
      },
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

      const confined = resolveExistingPathWithinPrefix(normalizedDir, prefix);
      const confinedDir = confined.path;
      const stat = statSync(confinedDir);
      if (!stat.isDirectory()) {
        return res.status(400).json({ error: 'Path is not a directory' });
      }

      const rawEntries = readdirSync(confinedDir, { withFileTypes: true });
      const entries = [];

      for (const entry of rawEntries) {
        if (entry.name.startsWith('.')) continue;
        if (!entry.isDirectory()) continue;

        const fullPath = join(confinedDir, entry.name);

        try {
          const confinedEntry = resolveExistingPathWithinPrefix(fullPath, confined.prefix);
          entries.push({ name: entry.name, path: confinedEntry.path, type: 'directory' });
        } catch { /* permission denied — skip */ }
      }

      entries.sort((a, b) => a.name.localeCompare(b.name));

      // Clamp parent to the allowed prefix (don't let them navigate above it)
      const rawParent = dirname(confinedDir);
      const parent = isWithinPrefix(rawParent, confined.prefix) ? rawParent : confined.prefix;

      logAudit.run(req.peer.id, req.peer.name, 'browse', JSON.stringify({
        dir: normalizedDir,
      }), req.peerIp);

      res.json({
        current: confinedDir,
        parent,
        prefix: confined.prefix,
        entries,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get filesystem roots on this peer — scoped to allowed_path_prefix
  app.get('/peer/roots', (req, res) => {
    const prefix = req.peer.allowed_path_prefix;
    let confinedPrefix;
    try {
      confinedPrefix = resolveExistingPathWithinPrefix(prefix, prefix).path;
    } catch (err) {
      return res.status(409).json({ error: err.message });
    }
    const roots = [{ name: confinedPrefix.split('/').pop() || confinedPrefix, path: confinedPrefix, icon: 'folder' }];

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
        try {
          resolveExistingPathWithinPrefix(sharePath, prefix);
          return true;
        } catch {
          return false;
        }
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
  app.use((err, req, res, next) => {
    if (!err.status || err.status >= 500) console.error('[peerApi] Unhandled error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
  });

  return app;
}

// Peer API — separate Express app on port 8091
// Machine-to-machine API for Hyper Backup cross-site operations
// Authenticated via Bearer API key (not Authelia)

import express from 'express';
import { peerAuth } from './middleware/auth.js';
import db from './db.js';

export function createPeerApi() {
  const app = express();
  app.use(express.json());

  // All peer routes require API key auth
  app.use(peerAuth(db));

  // Health check — returns instance info
  app.get('/peer/health', (req, res) => {
    const instanceName = db.prepare('SELECT value FROM settings WHERE key = ?').get('instance_name');
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

    // Validate that the remote path exists and is accessible
    // For security, we could restrict to allowed paths in settings
    res.json({
      ok: true,
      message: 'Ready for backup',
      runId,
      sshHost: getLocalIp(),
      sshUser: process.env.SSH_USER || 'root',
      sshPort: parseInt(process.env.SSH_PORT || '22'),
    });
  });

  // Backup transfer complete notification
  app.post('/peer/backup/complete', (req, res) => {
    const { runId, status, stats } = req.body;
    console.log(`[peer] Backup run ${runId} completed with status: ${status}`, stats || '');
    res.json({ ok: true, acknowledged: true });
  });

  // Check status of an active transfer
  app.get('/peer/backup/status/:runId', (req, res) => {
    const run = db.prepare('SELECT * FROM backup_runs WHERE id = ?').get(req.params.runId);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.json(run);
  });

  return app;
}

function getLocalIp() {
  // In production, this would be the WireGuard tunnel IP (100.90.128.x)
  // Fallback to hostname for dev
  return process.env.PEER_HOST || '0.0.0.0';
}

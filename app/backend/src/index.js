import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdirSync } from 'fs';

import { autheliaAuth } from './middleware/auth.js';
import ssdBackupRoutes from './routes/ssdBackup.js';
import hyperBackupRoutes from './routes/hyperBackup.js';
import rcloneRoutes from './routes/rclone.js';
import dockerRoutes from './routes/docker.js';
import overviewRoutes from './routes/overview.js';
import settingsRoutes from './routes/settings.js';
import mediaImportRoutes from './routes/mediaImport.js';
import filesystemRoutes from './routes/filesystem.js';
import { createPeerApi } from './peerApi.js';
import { startScheduler, registerExecutor, getActiveJobCount } from './services/scheduler.js';
import { executeSsdBackup } from './services/rsync.js';
import { executeHyperBackup } from './services/hyperBackup.js';
import { executeRcloneJob } from './services/rclone.js';
import { startMetricsPoller } from './services/docker.js';
import { startDriveMonitor } from './services/driveMonitor.js';
import { startImport } from './services/immichImport.js';

import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Ensure data directory exists
const dataDir = join(__dirname, '..', 'data');
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

const app = express();
const PORT = parseInt(process.env.PORT || '8090');
const PEER_PORT = parseInt(process.env.PEER_API_PORT || '8091');

app.use(cors());
app.use(express.json());

// Authelia forward auth for all API routes
app.use('/api', autheliaAuth);

// Mount API routes
app.use('/api/ssd-backup', ssdBackupRoutes);
app.use('/api/hyper-backup', hyperBackupRoutes);
app.use('/api/rclone', rcloneRoutes);
app.use('/api/docker', dockerRoutes);
app.use('/api/overview', overviewRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/media-import', mediaImportRoutes);
app.use('/api/filesystem', filesystemRoutes);

// Health check (no auth)
const startedAt = Date.now();
app.get('/api/health', (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    status: 'ok',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    uptime: Math.round((Date.now() - startedAt) / 1000),
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    nodeVersion: process.version,
    activeJobs: getActiveJobCount(),
    memory: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
    },
    pid: process.pid,
  });
});

// In production, serve the built frontend
const publicDir = join(__dirname, 'public');
if (existsSync(publicDir)) {
  app.use(express.static(publicDir));
  app.get('*', (req, res) => {
    res.sendFile(join(publicDir, 'index.html'));
  });
}

// Register scheduled job executors
registerExecutor('ssd-backup', executeSsdBackup);
registerExecutor('hyper-backup', executeHyperBackup);
registerExecutor('rclone', executeRcloneJob);

// Start main server
app.listen(PORT, () => {
  console.log(`🖥️  RedMan running on http://localhost:${PORT}`);

  // Start background services
  startScheduler();
  startMetricsPoller();

  // Start drive monitor for media import — auto-import on attach if configured
  startDriveMonitor((driveRow) => {
    if (driveRow && driveRow.auto_import) {
      console.log(`[media-import] Auto-importing from ${driveRow.name || driveRow.label}`);
      startImport(driveRow.id).catch(err => {
        console.error(`[media-import] Auto-import failed:`, err.message);
      });
    }
  });
});

// Start peer API on separate port
const peerApp = createPeerApi();
peerApp.listen(PEER_PORT, () => {
  console.log(`🔗 Peer API running on http://localhost:${PEER_PORT}`);
});

// Graceful shutdown — ignore SIGHUP (prevents kill on shell exit),
// handle SIGTERM/SIGINT for clean Docker stop
process.on('SIGHUP', () => {
  // Ignore — keeps the process alive when the parent shell exits
});

function shutdown(signal) {
  console.log(`\n[shutdown] Received ${signal}, shutting down...`);
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

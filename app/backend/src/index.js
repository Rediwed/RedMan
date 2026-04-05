import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
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
import peersRoutes from './routes/peers.js';
import mediaImportRoutes from './routes/mediaImport.js';
import filesystemRoutes from './routes/filesystem.js';
import { createPeerApi } from './peerApi.js';
import { startScheduler, registerExecutor, getActiveJobCount, stopAllJobs } from './services/scheduler.js';
import { executeSsdBackup, killActiveRsyncProcesses } from './services/rsync.js';
import { executeHyperBackup, notifyPeersOfShutdown } from './services/hyperBackup.js';
import { executeRcloneJob } from './services/rclone.js';
import { startMetricsPoller } from './services/docker.js';
import { startDriveMonitor } from './services/driveMonitor.js';
import { startImport } from './services/immichImport.js';
import { startTempCleanup } from './services/deltaVersion.js';
import db from './db.js';

import os from 'os';

// ── Global error handlers — prevent silent crashes ──────────────
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
  // Don't exit — let the process continue if possible
});

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled promise rejection:', reason);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Ensure data directory exists
const dataDir = join(__dirname, '..', 'data');
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

const app = express();
const PORT = parseInt(process.env.PORT || '8090');
const PEER_PORT = parseInt(process.env.PEER_API_PORT || '8091');

app.use(helmet());
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? [process.env.CORS_ORIGIN || 'http://localhost:8090']
    : ['http://localhost:5173', 'http://localhost:5175', 'http://localhost:8090'],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true,
}));
app.use(express.json());

// Health check — before auth so it's always accessible
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

// Authelia forward auth for all API routes
app.use('/api', autheliaAuth);

// Mount API routes
app.use('/api/ssd-backup', ssdBackupRoutes);
app.use('/api/hyper-backup', hyperBackupRoutes);
app.use('/api/rclone', rcloneRoutes);
app.use('/api/docker', dockerRoutes);
app.use('/api/overview', overviewRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/peers', peersRoutes);
app.use('/api/media-import', mediaImportRoutes);
app.use('/api/filesystem', filesystemRoutes);

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

  // Clean up orphaned "running" jobs from previous crashes
  const orphaned = db.prepare(`
    UPDATE backup_runs SET status = 'failed', completed_at = datetime('now'),
      error_message = 'Process was interrupted (crash recovery)'
    WHERE status = 'running'
  `).run();
  if (orphaned.changes > 0) {
    console.log(`[startup] Cleaned up ${orphaned.changes} orphaned job(s) from previous run`);
  }

  // Start background services
  startScheduler();
  startMetricsPoller();
  startTempCleanup();

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

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[shutdown] Received ${signal}, shutting down gracefully...`);

  // 1. Stop all scheduled cron jobs so no new work starts
  stopAllJobs();

  // 2. Notify connected peers that we're going offline
  try {
    await notifyPeersOfShutdown();
  } catch (err) {
    console.warn(`[shutdown] Peer notification error:`, err.message);
  }

  // 3. Kill active rsync child processes
  killActiveRsyncProcesses();

  // 4. Mark any still-running jobs as failed in DB
  try {
    const interrupted = db.prepare(`
      UPDATE backup_runs SET status = 'failed', completed_at = datetime('now'),
        error_message = 'Process shutdown (${signal})'
    WHERE status = 'running'
    `).run();
    if (interrupted.changes > 0) {
      console.log(`[shutdown] Marked ${interrupted.changes} active job(s) as failed`);
    }
  } catch {}

  console.log('[shutdown] Cleanup complete, exiting.');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

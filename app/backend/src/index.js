import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdirSync } from 'fs';

import { createMainApiAuth } from './middleware/mainAuth.js';
import { authConfig } from './services/authConfig.js';
import { runtimeConfig } from './services/runtimeConfig.js';
import { authorizeApiRoute } from './services/routePermissions.js';
import createAuthRouter from './routes/auth.js';
import ssdBackupRoutes from './routes/ssdBackup.js';
import hyperBackupRoutes from './routes/hyperBackup.js';
import rcloneRoutes from './routes/rclone.js';
import dockerRoutes from './routes/docker.js';
import overviewRoutes from './routes/overview.js';
import settingsRoutes from './routes/settings.js';
import peersRoutes from './routes/peers.js';
import mediaImportRoutes from './routes/mediaImport.js';
import filesystemRoutes from './routes/filesystem.js';
import upgradeReadinessRoutes from './routes/upgradeReadiness.js';
import discoveryRoutes from './routes/discovery.js';
import externalJobRoutes, { heartbeatRouter as externalJobHeartbeatRouter } from './routes/externalJobs.js';
import eventRoutes from './routes/events.js';
import { createPeerApi } from './peerApi.js';
import { startScheduler, registerExecutor, getActiveJobCount, getRunningJobCount, stopAllJobs, startRunFileRetention, stopRunFileRetention } from './services/scheduler.js';
import { executeSsdBackup, stopActiveRsyncProcesses } from './services/rsync.js';
import { executeHyperBackup, notifyPeersOfShutdown } from './services/hyperBackup.js';
import { executeRcloneJob, stopActiveRcloneProcesses } from './services/rclone.js';
import { startMetricsPoller, stopMetricsPoller } from './services/docker.js';
import { startDriveMonitor, stopDriveMonitor } from './services/driveMonitor.js';
import { startImport, stopActiveImportProcesses } from './services/immichImport.js';
import { startTempCleanup, stopTempCleanup } from './services/deltaVersion.js';
import { stopActiveVersionVerifications } from './services/versionVerification.js';
import { getRuntimeResourceBudget } from './services/resourceBudget.js';
import db from './db.js';

import os from 'os';

// Apply timezone from settings at startup
try {
  const tzRow = db.prepare("SELECT value FROM settings WHERE key = 'timezone'").get();
  if (tzRow?.value && tzRow.value !== 'system') process.env.TZ = tzRow.value;
} catch { /* settings table may not exist yet */ }

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Ensure data directory exists
const dataDir = join(__dirname, '..', 'data');
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

const app = express();
const UPGRADE_BRIDGE_MODE = process.env.REDMAN_UPGRADE_BRIDGE === 'true';

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'upgrade-insecure-requests': null,
    },
  },
  // Explicitly set HSTS + nosniff so they're enforced even when not behind Traefik.
  // Helmet 8 enables these by default; restated here so a future helmet config
  // change doesn't silently drop them.
  strictTransportSecurity: { maxAge: 31536000, includeSubDomains: true, preload: false },
  noSniff: true,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));
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
  res.json({
    status: 'ok',
    version: '1.1.9',
    timestamp: new Date().toISOString(),
    uptime: null,
    hostname: null,
    platform: null,
    nodeVersion: null,
    activeJobs: null,
    runningJobs: null,
    memory: null,
    pid: null,
    upgradeBridge: UPGRADE_BRIDGE_MODE,
  });
});

// Heartbeat ingest — before auth because external cron jobs cannot present an
// Authelia session; each request carries a per-job bearer token instead.
// Deliberately also accepted during upgrade-bridge mode: refusing writes here
// would leave gaps that later read as false "overdue" alarms.
app.use('/api/external-jobs/heartbeat', externalJobHeartbeatRouter);

const mainApiAuth = createMainApiAuth(db, authConfig);
app.use('/api/auth', createAuthRouter({ db, config: authConfig, mainApiAuth }));
app.use('/api', mainApiAuth, authorizeApiRoute);

app.use('/api', (req, res, next) => {
  if (!UPGRADE_BRIDGE_MODE || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)
      || req.path.startsWith('/upgrade-readiness')) return next();
  return res.status(503).json({ error: 'RedMan is in upgrade-bridge maintenance mode; backup and configuration mutations are paused' });
});

app.get('/api/health/details', (req, res) => {
  const mem = process.memoryUsage();
  const schedulerRunning = getRunningJobCount();
  const dbRunning = db.prepare("SELECT COUNT(*) as count FROM backup_runs WHERE status = 'running'").get().count;
  res.json({
    status: 'ok',
    version: '1.1.9',
    timestamp: new Date().toISOString(),
    uptime: Math.round((Date.now() - startedAt) / 1000),
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    nodeVersion: process.version,
    activeJobs: getActiveJobCount(),
    runningJobs: Math.max(schedulerRunning, dbRunning),
    memory: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
    },
    resourceBudget: getRuntimeResourceBudget(),
    pid: process.pid,
    upgradeBridge: UPGRADE_BRIDGE_MODE,
  });
});

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
app.use('/api/upgrade-readiness', upgradeReadinessRoutes);
app.use('/api/discovery', discoveryRoutes);
app.use('/api/external-jobs', externalJobRoutes);
app.use('/api/events', eventRoutes);

// In production, serve the built frontend
const publicDir = join(__dirname, '..', 'public');
if (existsSync(publicDir)) {
  app.use(express.static(publicDir));
  app.get('*', (req, res) => {
    res.sendFile(join(publicDir, 'index.html'));
  });
}

// Global JSON error handler — must be after all routes, before scheduled jobs
// Catches any unhandled sync throws (e.g. from SQLite or crypto) so we return JSON not HTML
app.use((err, req, res, next) => {
  console.error('[app] Unhandled error:', err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// Register scheduled job executors
registerExecutor('ssd-backup', executeSsdBackup);
registerExecutor('hyper-backup', executeHyperBackup);
registerExecutor('rclone', executeRcloneJob);

// Start main server
const mainServer = app.listen(runtimeConfig.mainPort, () => {
  console.log(`🖥️  RedMan running on http://localhost:${runtimeConfig.mainPort}`);

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
  if (UPGRADE_BRIDGE_MODE) {
    console.log('[upgrade-bridge] Maintenance mode active: schedules, metrics, temp cleanup, and drive monitoring are paused');
    return;
  }

  startScheduler();
  startMetricsPoller();
  startTempCleanup();
  startRunFileRetention();

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
let peerServer = null;
if (UPGRADE_BRIDGE_MODE) {
  console.log('[upgrade-bridge] Peer API paused during host preparation');
} else {
  const peerApp = createPeerApi();
  peerServer = peerApp.listen(runtimeConfig.peerApiPort, () => {
    console.log(`🔗 Peer API running on http://localhost:${runtimeConfig.peerApiPort}`);
  });
}

// Graceful shutdown — ignore SIGHUP (prevents kill on shell exit),
// handle SIGTERM/SIGINT for clean Docker stop
process.on('SIGHUP', () => {
  // Ignore — keeps the process alive when the parent shell exits
});

function closeServer(server) {
  return new Promise(resolve => {
    if (!server?.listening) {
      resolve();
      return;
    }
    server.close(() => { resolve(); });
  });
}

let shuttingDown = false;
async function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[shutdown] Received ${signal}, shutting down gracefully...`);
  const hardExit = setTimeout(() => {
    console.error('[shutdown] Grace period exceeded; forcing exit.');
    process.exit(exitCode || 1);
  }, 20000);
  hardExit.unref?.();

  // Stop accepting work and clear every background timer.
  const serverClose = Promise.allSettled([closeServer(mainServer), closeServer(peerServer)]);
  stopAllJobs();
  stopRunFileRetention();
  stopMetricsPoller();
  stopDriveMonitor();
  stopTempCleanup();

  // Notify peers before terminating transfer processes.
  try {
    await notifyPeersOfShutdown();
  } catch (err) {
    console.warn(`[shutdown] Peer notification error:`, err.message);
  }

  const processResults = await Promise.allSettled([
    stopActiveRsyncProcesses(10000),
    stopActiveRcloneProcesses(10000),
    stopActiveImportProcesses(10000),
    stopActiveVersionVerifications(),
  ]);
  for (const result of processResults) {
    if (result.status === 'fulfilled' && result.value.forced > 0) {
      console.warn(`[shutdown] Force-killed ${result.value.forced} child process(es)`);
    }
  }

  // Mark only rows that remain running after children had time to settle.
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

  await serverClose;
  try { db.close(); } catch {}
  clearTimeout(hardExit);
  console.log(`[shutdown] Cleanup complete, exiting with code ${exitCode}.`);
  process.exit(exitCode);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
  shutdown('uncaughtException', 1).catch(() => process.exit(1));
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled promise rejection:', reason);
  shutdown('unhandledRejection', 1).catch(() => process.exit(1));
});

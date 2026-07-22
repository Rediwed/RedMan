// Scheduler service — manages cron jobs backed by SQLite
// Loads all active scheduled jobs on startup, provides add/remove/update

import cron from 'node-cron';
import db from '../db.js';
import { notifyJobSkipped } from './notify.js';
import { nextCronOccurrence, validateCronExpression } from './schedulePolicy.js';
import { getDatabaseRetentionPolicy, runDatabaseRetentionBatches } from './databaseRetention.js';

const activeJobs = new Map(); // key: `${feature}:${configId}`, value: cron task

// Callback registry — features register their executor functions here
const executors = new Map();

// Skip-if-running tracking
const runningJobs = new Set();       // keys currently executing
const skipCounts = new Map();        // key → consecutive skip count
const SKIP_NOTIFY_THRESHOLD = 5;
const MAX_RETRIES = 3;               // retry up to 3 times on transient failures
const RETRY_BASE_DELAY_MS = 30_000;  // 30s base delay (30s, 60s, 120s)

export function registerExecutor(feature, fn) {
  executors.set(feature, fn);
}

export function startScheduler() {
  console.log('[scheduler] Loading scheduled jobs...');

  // Load SSD backup configs
  const ssdConfigs = db.prepare(
    'SELECT id, cron_expression FROM ssd_backup_configs WHERE enabled = 1'
  ).all();
  for (const cfg of ssdConfigs) {
    scheduleJob('ssd-backup', cfg.id, cfg.cron_expression);
  }

  // Load Hyper Backup jobs
  const hyperJobs = db.prepare(
    'SELECT id, cron_expression FROM hyper_backup_jobs WHERE enabled = 1'
  ).all();
  for (const job of hyperJobs) {
    scheduleJob('hyper-backup', job.id, job.cron_expression);
  }

  // Load Rclone jobs
  const rcloneJobs = db.prepare(
    'SELECT id, cron_expression FROM rclone_jobs WHERE enabled = 1'
  ).all();
  for (const job of rcloneJobs) {
    scheduleJob('rclone', job.id, job.cron_expression);
  }

  console.log(`[scheduler] ${activeJobs.size} jobs scheduled.`);
}

// Check if an error is transient (network/SSH issues worth retrying)
function isTransientError(err) {
  const msg = (err.message || '').toLowerCase();
  return msg.includes('econnrefused') || msg.includes('econnreset') ||
    msg.includes('etimedout') || msg.includes('ssh connection failed') ||
    msg.includes('unreachable') || msg.includes('connection closed') ||
    msg.includes('connection reset') || msg.includes('timed out') ||
    msg.includes('no route to host');
}

// Execute a job with exponential backoff retry on transient failures
async function executeWithRetry(executor, configId, key) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await executor(configId);
      return; // success
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES && isTransientError(err)) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        console.warn(`[scheduler] ${key} failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${err.message}. Retrying in ${delay / 1000}s...`);
        await new Promise(resolve => { setTimeout(resolve, delay); });
      } else {
        throw err; // non-transient or max retries exhausted
      }
    }
  }
  throw lastError;
}

export function scheduleJob(feature, configId, cronExpression) {
  const key = `${feature}:${configId}`;

  // Remove existing job if any
  removeJob(feature, configId);

  if (!validateCronExpression(cronExpression)) {
    console.error(`[scheduler] Invalid cron expression for ${key}: ${cronExpression}`);
    return false;
  }

  const task = cron.schedule(cronExpression, async () => {
    const executor = executors.get(feature);
    if (!executor) {
      console.error(`[scheduler] No executor registered for feature: ${feature}`);
      return;
    }

    // Skip if previous run is still active
    if (runningJobs.has(key)) {
      const count = (skipCounts.get(key) || 0) + 1;
      skipCounts.set(key, count);
      console.warn(`[scheduler] Skipping ${key} — previous run still active (${count} consecutive skip${count > 1 ? 's' : ''})`);
      if (count >= SKIP_NOTIFY_THRESHOLD && count % SKIP_NOTIFY_THRESHOLD === 0) {
        const name = getJobName(feature, configId);
        notifyJobSkipped(feature, name, count);
      }
      return;
    }

    runningJobs.add(key);
    try {
      console.log(`[scheduler] Triggering ${key}`);
      await executeWithRetry(executor, configId, key);
      // Successful completion resets skip counter
      skipCounts.delete(key);
    } catch (err) {
      console.error(`[scheduler] Error executing ${key}:`, err.message);
    } finally {
      runningJobs.delete(key);
    }
  });

  activeJobs.set(key, task);
  return true;
}

export function removeJob(feature, configId) {
  const key = `${feature}:${configId}`;
  const existing = activeJobs.get(key);
  if (existing) {
    existing.stop();
    activeJobs.delete(key);
  }
  // Clean up tracking state
  runningJobs.delete(key);
  skipCounts.delete(key);
}

// Stop all scheduled cron jobs (for graceful shutdown)
export function stopAllJobs() {
  for (const [key, task] of activeJobs) {
    try { task.stop(); } catch {}
  }
  activeJobs.clear();
  runningJobs.clear();
  skipCounts.clear();
}

export function getNextRun(cronExpression) {
  try {
    return nextCronOccurrence(cronExpression);
  } catch {
    return null;
  }
}

export function getActiveJobCount() {
  return activeJobs.size;
}

export function getRunningJobCount() {
  return runningJobs.size;
}

// Look up a human-readable job name from DB
function getJobName(feature, configId) {
  try {
    const table = feature === 'ssd-backup' ? 'ssd_backup_configs'
      : feature === 'hyper-backup' ? 'hyper_backup_jobs'
      : feature === 'rclone' ? 'rclone_jobs' : null;
    if (!table) return `${feature}#${configId}`;
    const row = db.prepare(`SELECT name FROM ${table} WHERE id = ?`).get(configId);
    return row?.name || `${feature}#${configId}`;
  } catch {
    return `${feature}#${configId}`;
  }
}

// Return skip status for all jobs (for API consumption)
export function getSkipStatus() {
  const result = {};
  for (const [key, count] of skipCounts) {
    result[key] = { consecutiveSkips: count, running: runningJobs.has(key) };
  }
  return result;
}

// Return skip info for a specific feature+configId
export function getJobSkipCount(feature, configId) {
  return skipCounts.get(`${feature}:${configId}`) || 0;
}

// Check if a job is currently running
export function isJobRunning(feature, configId) {
  return runningJobs.has(`${feature}:${configId}`);
}

// ── Bounded database retention ──

const RETENTION_START_DELAY_MS = 60_000;
const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;
const RETENTION_BATCH_SIZE = 1_000;
const RETENTION_RUN_FILE_BATCH_SIZE = 100;
const RETENTION_MAX_BATCHES = 25;
const RETENTION_YIELD_MS = 250;
const RETENTION_MAX_DURATION_MS = 30_000;

let retentionTimer = null;
let retentionRun = null;
let retentionStopped = true;

function scheduleRetention(delayMs) {
  if (retentionStopped) return null;
  if (retentionTimer) clearTimeout(retentionTimer);
  retentionTimer = setTimeout(() => {
    retentionTimer = null;
    runRetentionCycle().catch(err => {
      console.error('[retention] Cycle failed:', err.message);
      if (!retentionStopped) scheduleRetention(RETENTION_INTERVAL_MS);
    });
  }, delayMs);
  retentionTimer.unref?.();
  return retentionTimer;
}

async function runRetentionCycle() {
  if (retentionStopped || retentionRun) return;
  retentionRun = runDatabaseRetentionBatches(db, {}, {
    batchSize: RETENTION_BATCH_SIZE,
    runFileBatchSize: RETENTION_RUN_FILE_BATCH_SIZE,
    maxBatches: RETENTION_MAX_BATCHES,
    yieldMs: RETENTION_YIELD_MS,
    maxDurationMs: RETENTION_MAX_DURATION_MS,
    shouldStop: () => retentionStopped,
    onProgress: ({ batch, totals }) => {
      if (batch % 10 === 0) {
        const removed = Object.values(totals).reduce((sum, count) => sum + count, 0);
        console.log(`[retention] Progress: ${batch} batch(es), ${removed} row(s) removed`);
      }
    },
  });

  let result;
  try {
    result = await retentionRun;
  } finally {
    retentionRun = null;
  }
  if (retentionStopped || result.cancelled) return;

  const removed = Object.values(result.totals).reduce((sum, count) => sum + count, 0);
  console.log(`[retention] Cycle: ${result.batches} batch(es), ${removed} row(s), complete=${result.complete}, timedOut=${result.timedOut}`);
  scheduleRetention(RETENTION_INTERVAL_MS);
}

export function startRunFileRetention() {
  stopRunFileRetention();
  retentionStopped = false;
  const policy = getDatabaseRetentionPolicy(db);
  console.log(`[retention] Scheduled in ${RETENTION_START_DELAY_MS / 1000}s: run files ${policy.runFileDays}d, run history ${policy.runHistoryDays}d, peer audit ${policy.routineAuditDays}/${policy.securityAuditDays}d`);
  return scheduleRetention(RETENTION_START_DELAY_MS);
}

export function stopRunFileRetention() {
  retentionStopped = true;
  if (retentionTimer) clearTimeout(retentionTimer);
  retentionTimer = null;
}

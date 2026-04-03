// Scheduler service — manages cron jobs backed by SQLite
// Loads all active scheduled jobs on startup, provides add/remove/update

import cron from 'node-cron';
import db from '../db.js';
import { notifyJobSkipped } from './notify.js';

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
        await new Promise(resolve => setTimeout(resolve, delay));
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

  if (!cron.validate(cronExpression)) {
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
  // Simple next-run calculation using node-cron's validate
  // For display purposes, parse the cron expression manually
  if (!cron.validate(cronExpression)) return null;

  // node-cron doesn't expose next run directly; compute from Date
  // Return a rough estimate based on the cron pattern
  const now = new Date();
  const parts = cronExpression.split(' ');

  // For simple patterns like "0 * * * *" (hourly at minute 0)
  if (parts[0] !== '*' && parts[1] === '*') {
    const targetMinute = parseInt(parts[0]);
    const next = new Date(now);
    next.setSeconds(0, 0);
    next.setMinutes(targetMinute);
    if (next <= now) next.setHours(next.getHours() + 1);
    return next.toISOString();
  }

  // For "0 2 * * *" (daily at 02:00)
  if (parts[0] !== '*' && parts[1] !== '*' && parts[2] === '*') {
    const targetMinute = parseInt(parts[0]);
    const targetHour = parseInt(parts[1]);
    const next = new Date(now);
    next.setSeconds(0, 0);
    next.setMinutes(targetMinute);
    next.setHours(targetHour);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next.toISOString();
  }

  // Fallback — return null (UI will show "custom schedule")
  return null;
}

export function getActiveJobCount() {
  return activeJobs.size;
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

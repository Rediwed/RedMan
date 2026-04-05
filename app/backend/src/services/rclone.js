// Rclone executor service
// Spawns rclone as a child process for sync/bisync, parses JSON logs

import { spawn } from 'child_process';
import { readFile, unlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import db from '../db.js';
import { notifyBackupResult } from './notify.js';

const activeRuns = new Map();

export function getActiveRcloneRun(runId) {
  return activeRuns.get(runId);
}

// List configured rclone remotes
export async function listRemotes() {
  const result = await runRclone(['listremotes']);
  if (result.exitCode !== 0) throw new Error(`rclone listremotes failed: ${result.stderr}`);
  return result.stdout.split('\n')
    .map(l => l.trim().replace(/:$/, ''))
    .filter(l => l.length > 0);
}

// Browse a remote path
export async function browseRemote(remoteName, remotePath = '') {
  const target = remotePath ? `${remoteName}:${remotePath}` : `${remoteName}:`;
  const result = await runRclone(['lsjson', target, '--dirs-only']);
  if (result.exitCode !== 0) throw new Error(`rclone lsjson failed: ${result.stderr}`);
  try {
    return JSON.parse(result.stdout || '[]');
  } catch {
    return [];
  }
}

// Execute an rclone sync job
export async function executeRcloneJob(jobId, existingRunId = null) {
  const job = db.prepare('SELECT * FROM rclone_jobs WHERE id = ?').get(jobId);
  if (!job) throw new Error(`Rclone job ${jobId} not found`);

  let runId = existingRunId;
  if (runId) {
    db.prepare(`UPDATE backup_runs SET status = 'running' WHERE id = ?`).run(runId);
  } else {
    const run = db.prepare(`
      INSERT INTO backup_runs (feature, config_id, status) VALUES ('rclone', ?, 'running')
    `).run(jobId);
    runId = Number(run.lastInsertRowid);
  }

  const startTime = Date.now();
  const logFile = join(tmpdir(), `redman-rclone-${randomBytes(4).toString('hex')}.json`);
  activeRuns.set(runId, { status: 'running', progress: null, startedAt: startTime });

  try {
    const remote = `${job.remote_name}:${job.remote_path}`;
    let args;

    if (job.sync_direction === 'bisync') {
      args = ['bisync', job.local_path, remote, '--verbose', '--log-file', logFile, '--log-level', 'INFO'];

      // First run or after reset needs --resync
      if (job.bisync_resync_needed) {
        args.push('--resync');
      }
    } else if (job.sync_direction === 'upload') {
      args = ['sync', job.local_path, remote, '--verbose', '--log-file', logFile, '--log-level', 'INFO'];
    } else {
      // download
      args = ['sync', remote, job.local_path, '--verbose', '--log-file', logFile, '--log-level', 'INFO'];
    }

    args.push('--stats-one-line', '--stats', '2s');

    const result = await runRclone(args, (line) => {
      // Parse rclone --stats-one-line output for live progress
      const bytesMatch = line.match(/Transferred:\s+([\d.]+\s*\w+)\s*\/\s*([\d.]+\s*\w+),\s*(\d+)%/);
      if (bytesMatch) {
        const current = activeRuns.get(runId) || {};
        const update = {
          ...current, status: 'running', startedAt: startTime,
          bytesTransferred: parseRcloneSize(bytesMatch[1]),
          bytesTotal: parseRcloneSize(bytesMatch[2]),
          percent: parseInt(bytesMatch[3]),
        };
        const speedMatch = line.match(/([\d.]+\s*\w+\/s)/);
        if (speedMatch) update.speed = speedMatch[1];
        const etaMatch = line.match(/ETA\s+([\dhms ]+\S*)/);
        if (etaMatch) update.eta = etaMatch[1].trim();
        activeRuns.set(runId, update);
      }
    });

    // Parse log file for stats
    let logContent = '';
    try {
      logContent = await readFile(logFile, 'utf-8');
    } catch {}

    const stats = parseRcloneLog(logContent);

    // If bisync with --resync succeeded, clear the flag
    if (job.sync_direction === 'bisync' && job.bisync_resync_needed && result.exitCode === 0) {
      db.prepare('UPDATE rclone_jobs SET bisync_resync_needed = 0 WHERE id = ?').run(jobId);
    }

    // Store file details from log (batched in a single transaction for performance)
    const insertFile = db.prepare(`
      INSERT INTO backup_run_files (run_id, file_path, action, size, error) VALUES (?, ?, ?, ?, ?)
    `);
    const insertAllFiles = db.transaction((entries) => {
      for (const e of entries) insertFile.run(e.runId, e.path, e.action, e.size, e.error);
    });
    const fileEntries = [];
    for (const file of stats.files) {
      fileEntries.push({ runId, path: file.path, action: file.action, size: file.size || 0, error: file.error || null });
    }
    if (fileEntries.length > 0) insertAllFiles(fileEntries);

    const duration = (Date.now() - startTime) / 1000;
    const status = result.exitCode === 0 ? 'completed' : 'failed';

    db.prepare(`
      UPDATE backup_runs SET
        status = ?, completed_at = datetime('now'),
        files_total = ?, files_copied = ?, files_failed = ?,
        bytes_transferred = ?, duration_seconds = ?,
        error_message = ?
      WHERE id = ?
    `).run(
      status,
      stats.filesTotal, stats.filesCopied, stats.filesFailed,
      stats.bytesTransferred, duration,
      result.exitCode !== 0 ? (result.stderr || `rclone exited with code ${result.exitCode}`) : null,
      runId,
    );

    // Notification
    if (job.notify_on_success && status === 'completed') {
      await notifyBackupResult('Rclone Sync', job.name, 'completed', {
        filesCopied: stats.filesCopied, filesFailed: stats.filesFailed,
        bytesTransferred: stats.bytesTransferred, duration,
      });
    } else if (job.notify_on_failure && status === 'failed') {
      await notifyBackupResult('Rclone Sync', job.name, 'failed', {
        filesCopied: stats.filesCopied, bytesTransferred: stats.bytesTransferred, duration,
      });
    }

    // Cleanup log file
    try { await unlink(logFile); } catch {}

    return { runId, status };
  } catch (err) {
    const duration = (Date.now() - startTime) / 1000;
    db.prepare(`
      UPDATE backup_runs SET status = 'failed', completed_at = datetime('now'),
        error_message = ?, duration_seconds = ?
      WHERE id = ?
    `).run(err.message, duration, runId);

    if (job.notify_on_failure) {
      await notifyBackupResult('Rclone Sync', job.name, 'failed', { duration });
    }
    try { await unlink(logFile); } catch {}
    throw err;
  } finally {
    activeRuns.delete(runId);
  }
}

function runRclone(args, onStderrLine = null) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn('rclone', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, RCLONE_NON_INTERACTIVE: 'true' },
      });
    } catch (err) {
      return reject(new Error(`rclone is not installed or not accessible: ${err.message}`));
    }
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => {
      const text = d.toString();
      stderr += text;
      if (onStderrLine) {
        text.split('\n').filter(l => l.trim()).forEach(onStderrLine);
      }
    });

    proc.on('close', (exitCode) => {
      resolve({ exitCode, stdout, stderr });
    });

    proc.on('error', (err) => {
      if (err.code === 'ENOENT' || err.code === 'EAGAIN') {
        reject(new Error('rclone is not installed. Install it with: curl https://rclone.org/install.sh | sudo bash'));
      } else {
        reject(new Error(`Failed to start rclone: ${err.message}`));
      }
    });
  });
}

function parseRcloneLog(logContent) {
  const files = [];
  let filesTotal = 0;
  let filesCopied = 0;
  let filesFailed = 0;
  let bytesTransferred = 0;

  const lines = logContent.split('\n');
  for (const line of lines) {
    // Parse transferred files
    const transferMatch = line.match(/INFO\s*:\s*(.+?):\s*(Copied|Moved|Deleted|Updated)\s*/);
    if (transferMatch) {
      const [, path, action] = transferMatch;
      filesTotal++;
      filesCopied++;
      files.push({ path, action: action.toLowerCase(), size: 0 });
      continue;
    }

    // Parse errors
    const errorMatch = line.match(/ERROR\s*:\s*(.+?):\s*(.+)/);
    if (errorMatch) {
      filesFailed++;
      files.push({ path: errorMatch[1], action: 'error', size: 0, error: errorMatch[2] });
      continue;
    }

    // Parse aggregate stats
    const bytesLine = line.match(/Transferred:\s*([\d.]+\s*\w+)\s*\/\s*([\d.]+\s*\w+)/);
    if (bytesLine) {
      bytesTransferred = parseRcloneSize(bytesLine[1]);
    }

    const totalLine = line.match(/Transferred:\s*(\d+)\s*\/\s*(\d+)/);
    if (totalLine) {
      filesCopied = parseInt(totalLine[1]);
      filesTotal = parseInt(totalLine[2]);
    }
  }

  return { files, filesTotal, filesCopied, filesFailed, bytesTransferred };
}

function parseRcloneSize(str) {
  const match = str.match(/([\d.]+)\s*(\w+)/);
  if (!match) return 0;
  const num = parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  const multipliers = { B: 1, KB: 1024, KIB: 1024, MB: 1048576, MIB: 1048576, GB: 1073741824, GIB: 1073741824, TB: 1099511627776, TIB: 1099511627776 };
  return Math.round(num * (multipliers[unit] || 1));
}

// ===== Remote configuration management =====

const ALLOWED_TYPES = new Set([
  'drive', 'onedrive', 'protondrive', 's3', 'b2', 'dropbox', 'sftp',
  'webdav', 'box', 'mega', 'pcloud', 'ftp', 'local',
]);

// List available provider types
export function getProviderTypes() {
  return [...ALLOWED_TYPES].sort();
}

// Get full config for a remote (redacted sensitive fields)
export async function getRemoteConfig(name) {
  const result = await runRclone(['config', 'dump']);
  if (result.exitCode !== 0) throw new Error(`rclone config dump failed: ${result.stderr}`);
  const allConfig = JSON.parse(result.stdout);
  const config = allConfig[name];
  if (!config) throw new Error(`Remote "${name}" not found`);
  return { name, type: config.type, ...redactSensitive(config) };
}

// Create a new remote
export async function createRemote(name, type, params = {}) {
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error('Remote name must contain only letters, numbers, hyphens, and underscores');
  }
  if (!ALLOWED_TYPES.has(type)) {
    throw new Error(`Unsupported remote type "${type}". Allowed: ${[...ALLOWED_TYPES].join(', ')}`);
  }

  // Check for name collision
  const existing = await listRemotes();
  if (existing.includes(name)) {
    throw new Error(`Remote "${name}" already exists`);
  }

  const args = ['config', 'create', name, type];
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      args.push(`${key}=${value}`);
    }
  }

  const result = await runRclone(args);
  if (result.exitCode !== 0) throw new Error(`Failed to create remote: ${result.stderr}`);
  return { name, type, params: redactSensitive(params) };
}

// Update an existing remote's parameters
export async function updateRemote(name, params = {}) {
  const existing = await listRemotes();
  if (!existing.includes(name)) {
    throw new Error(`Remote "${name}" not found`);
  }

  const args = ['config', 'update', name];
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      args.push(`${key}=${value}`);
    }
  }

  const result = await runRclone(args);
  if (result.exitCode !== 0) throw new Error(`Failed to update remote: ${result.stderr}`);
  return await getRemoteConfig(name);
}

// Delete a remote
export async function deleteRemote(name) {
  const existing = await listRemotes();
  if (!existing.includes(name)) {
    throw new Error(`Remote "${name}" not found`);
  }

  const result = await runRclone(['config', 'delete', name]);
  if (result.exitCode !== 0) throw new Error(`Failed to delete remote: ${result.stderr}`);
}

// Test a remote is reachable
export async function testRemote(name) {
  const result = await runRclone(['about', `${name}:`, '--json']);
  if (result.exitCode !== 0) {
    // Fallback: try lsd
    const lsd = await runRclone(['lsd', `${name}:`, '--max-depth', '0']);
    return { reachable: lsd.exitCode === 0, error: lsd.exitCode !== 0 ? lsd.stderr.trim() : null };
  }
  try {
    const about = JSON.parse(result.stdout);
    return { reachable: true, total: about.total, used: about.used, free: about.free };
  } catch {
    return { reachable: true };
  }
}

const SENSITIVE_KEYS = new Set(['token', 'password', 'secret', 'client_secret', 'pass', 'key', 'service_account_credentials']);

function redactSensitive(config) {
  const result = {};
  for (const [key, value] of Object.entries(config)) {
    if (key === 'type') continue;
    if (SENSITIVE_KEYS.has(key) && value) {
      result[key] = '••••••••';
    } else {
      result[key] = value;
    }
  }
  return result;
}

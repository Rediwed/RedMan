// Rclone executor service
// Spawns rclone as a child process for sync/bisync, parses JSON logs

import { spawn } from 'child_process';
import db from '../db.js';
import { notifyBackupResult, shouldNotify } from './notify.js';

const activeRuns = new Map();
const activeProcesses = new Map(); // runId -> ChildProcess

export function getActiveRcloneRun(runId) {
  return activeRuns.get(runId);
}

export function cancelRcloneRun(runId) {
  const proc = activeProcesses.get(runId);
  if (proc) {
    proc.kill('SIGTERM');
    return true;
  }
  return false;
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
  // Validate remote name + path before invoking rclone. Args are passed as an
  // array so shell injection isn't possible, but rclone itself can interpret
  // metacharacters/newlines unexpectedly and unknown remotes leak as errors.
  if (!remoteName || !/^[a-zA-Z0-9_-]+$/.test(remoteName)) {
    throw new Error('Invalid remote name');
  }
  const remotes = await listRemotes();
  if (!remotes.includes(remoteName)) {
    throw new Error(`Remote "${remoteName}" not found`);
  }
  if (typeof remotePath !== 'string' || /[\n\r\0]/.test(remotePath) || remotePath.includes('..')) {
    throw new Error('Invalid remote path');
  }
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
  activeRuns.set(runId, { status: 'running', progress: null, startedAt: startTime });

  try {
    const remote = `${job.remote_name}:${job.remote_path}`;
    let args;

    if (job.sync_direction === 'bisync') {
      args = ['bisync', job.local_path, remote, '-v'];

      // First run or after reset needs --resync
      if (job.bisync_resync_needed) {
        args.push('--resync');
      }
    } else if (job.sync_direction === 'upload') {
      args = ['sync', job.local_path, remote, '-v'];
    } else {
      // download
      args = ['sync', remote, job.local_path, '-v'];
    }

    args.push('--stats-one-line', '--stats', '2s', '--transfers', '16', '--checkers', '16', '--fast-list', '--retries', '1',
      '--drive-pacer-min-sleep', '10ms', '--drive-pacer-burst', '200');

    const result = await runRclone(args, runId, (line) => {
      // Parse rclone --stats-one-line output for live progress
      // Format varies: "Transferred: 1.2 MiB / 5 MiB, 24%" or just "1.2 MiB / 5 MiB, 24%"
      const bytesMatch = line.match(/([\d.]+\s*\w+)\s*\/\s*([\d.]+\s*\w+),\s*(\d+)%/);
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
        const etaMatch = line.match(/ETA\s+([\dhms ]+?)(?:\s*\(|$)/);
        if (etaMatch) update.eta = etaMatch[1].trim();
        const xfrMatch = line.match(/\(xfr#(\d+)\/(\d+)\)/);
        if (xfrMatch) {
          update.filesCopied = parseInt(xfrMatch[1]);
          update.filesTotal = parseInt(xfrMatch[2]);
        }
        activeRuns.set(runId, update);
      }
    });

    // Parse stderr for stats (rclone outputs everything to stderr)
    const stats = parseRcloneLog(result.stderr);

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
    const wasCancelled = result.exitCode === null || result.exitCode === 143 || result.exitCode === -15;
    const status = wasCancelled ? 'cancelled'
      : result.exitCode === 0
        ? (stats.filesFailed > 0 ? 'partial' : 'completed')
        : stats.filesCopied > 0 ? 'partial' : 'failed';

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
      stats.filesFailed > 0 ? `${stats.filesFailed} file(s) failed` : null,
      runId,
    );

    // Notification
    if (status === 'completed' && shouldNotify(job, 'success')) {
      await notifyBackupResult('Rclone Sync', job.name, 'completed', {
        filesCopied: stats.filesCopied, filesFailed: stats.filesFailed,
        bytesTransferred: stats.bytesTransferred, duration,
      });
    } else if (status === 'failed' && shouldNotify(job, 'failure')) {
      await notifyBackupResult('Rclone Sync', job.name, 'failed', {
        filesCopied: stats.filesCopied, bytesTransferred: stats.bytesTransferred, duration,
      });
    }

    return { runId, status };
  } catch (err) {
    const duration = (Date.now() - startTime) / 1000;
    db.prepare(`
      UPDATE backup_runs SET status = 'failed', completed_at = datetime('now'),
        error_message = ?, duration_seconds = ?
      WHERE id = ?
    `).run(err.message, duration, runId);

    if (shouldNotify(job, 'failure')) {
      await notifyBackupResult('Rclone Sync', job.name, 'failed', { duration });
    }
    throw err;
  } finally {
    activeRuns.delete(runId);
  }
}

function runRclone(args, runId = null, onStderrLine = null) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn('rclone', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, RCLONE_NON_INTERACTIVE: 'true', RCLONE_CONFIG: process.env.RCLONE_CONFIG || '/app/backend/data/rclone.conf' },
      });
    } catch (err) {
      return reject(new Error(`rclone is not installed or not accessible: ${err.message}`));
    }
    if (runId) activeProcesses.set(runId, proc);
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
      if (runId) activeProcesses.delete(runId);
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

    // Parse errors (skip aggregate/retry lines that aren't file-level errors)
    const errorMatch = line.match(/ERROR\s*:\s*(.+?):\s*(.+)/);
    if (errorMatch) {
      const errPath = errorMatch[1].trim();
      // Skip rclone aggregate messages (retries, "not deleting" warnings, etc.)
      if (/^Attempt \d+\/\d+ failed/.test(errPath) ||
          /^Google drive root/.test(errPath) ||
          /^Failed to sync/.test(errPath)) {
        continue;
      }
      filesFailed++;
      // Strip redundant file paths from error message (already shown in the file column)
      const errMsg = errorMatch[2].replace(/\/mnt\/\S+:\s*/g, '').replace(/:\s*$/, '');
      files.push({ path: errPath, action: 'error', size: 0, error: errMsg });
      continue;
    }

    // Parse aggregate stats — format on stderr: "9.215 MiB / 9.215 MiB, 100%, ..."
    const bytesLine = line.match(/([\d.]+\s*\w+)\s*\/\s*([\d.]+\s*\w+),\s*\d+%/);
    if (bytesLine) {
      bytesTransferred = parseRcloneSize(bytesLine[1]);
    }

    const xfrMatch = line.match(/\(xfr#(\d+)\/(\d+)\)/);
    if (xfrMatch) {
      filesCopied = parseInt(xfrMatch[1]);
      filesTotal = parseInt(xfrMatch[2]);
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

// Whitelist of rclone config parameter keys we accept from API callers.
// Anything else is silently dropped to prevent injection of unrelated rclone
// flags or accidental leak of env-overriding params via the config file.
// Keys are matched case-insensitively against the lowercased input.
const ALLOWED_PARAM_KEYS = new Set([
  // common
  'type', 'token', 'client_id', 'client_secret', 'scope', 'root_folder_id',
  'team_drive', 'service_account_file', 'service_account_credentials',
  // s3 / b2
  'provider', 'access_key_id', 'secret_access_key', 'region', 'endpoint',
  'account', 'key', 'hard_delete',
  // sftp / ftp / webdav
  'host', 'user', 'pass', 'port', 'key_file', 'key_pem', 'url', 'vendor',
  // dropbox / onedrive / box / pcloud / mega
  'app_key', 'app_secret', 'drive_type', 'tenant', 'username', 'password',
  // proton
  '2fa', 'mailbox_password',
  // local / generic
  'nounc', 'encoding', 'description',
]);

function filterParams(params) {
  const out = {};
  const dropped = [];
  for (const [rawKey, value] of Object.entries(params || {})) {
    const key = String(rawKey).toLowerCase();
    if (!/^[a-z0-9_]+$/.test(key)) { dropped.push(rawKey); continue; }
    if (!ALLOWED_PARAM_KEYS.has(key)) { dropped.push(rawKey); continue; }
    // Reject newlines/control chars in values (would break rclone config file)
    if (typeof value === 'string' && /[\n\r\0]/.test(value)) { dropped.push(rawKey); continue; }
    out[key] = value;
  }
  if (dropped.length) console.warn(`[rclone] dropped unsupported config keys: ${dropped.join(', ')}`);
  return out;
}

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

  const safeParams = filterParams(params);
  const args = ['config', 'create', name, type];
  for (const [key, value] of Object.entries(safeParams)) {
    if (value !== undefined && value !== null && value !== '') {
      args.push(`${key}=${value}`);
    }
  }

  const result = await runRclone(args);
  if (result.exitCode !== 0) throw new Error(`Failed to create remote: ${result.stderr}`);
  return { name, type, params: redactSensitive(safeParams) };
}

// Update an existing remote's parameters
export async function updateRemote(name, params = {}) {
  const existing = await listRemotes();
  if (!existing.includes(name)) {
    throw new Error(`Remote "${name}" not found`);
  }

  const safeParams = filterParams(params);
  const args = ['config', 'update', name];
  for (const [key, value] of Object.entries(safeParams)) {
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

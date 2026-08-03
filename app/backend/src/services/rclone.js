// Rclone executor service
// Spawns rclone as a child process for sync/bisync, parses JSON logs

import { spawn } from 'child_process';
import { dirname } from 'node:path';
import db from '../db.js';
import { createJobNotificationTracker, notifyBackupResult, shouldNotify } from './notify.js';
import { claimBackupRun } from './runClaim.js';
import { assertLocalSourceHasEntries, assertRemoteSourceHasEntries } from './sourceHealth.js';
import { terminateChildProcesses } from './childProcessShutdown.js';
import { appendOutputTail } from './rsyncOutput.js';
import { describeRcloneFailures, summariseRcloneFailures, compareFailureSummaries } from './rcloneDiagnostics.js';
import { isWithinPrefix, localPathsOverlap, normalizePath, pathsOverlap } from '../middleware/validation.js';
import { ensureDirectoryWithinPrefix, resolveExistingPathWithinPrefix } from './pathConfinement.js';
import { storageConfig } from './storageConfig.js';

const activeRuns = new Map();
const activeProcesses = new Map(); // runId -> ChildProcess

function isSafeRemoteName(name) {
  return typeof name === 'string' && !name.startsWith('-') && /^[a-zA-Z0-9_-]+$/.test(name);
}

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

export async function stopActiveRcloneProcesses(timeoutMs = 10000) {
  return terminateChildProcesses(activeProcesses.values(), timeoutMs);
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
  if (!isSafeRemoteName(remoteName)) {
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

async function assertRcloneRemoteHasEntries(remote) {
  const listing = await runRclone(['lsjson', remote, '--max-depth', '1']);
  if (listing.exitCode !== 0) {
    throw new Error(`Could not inspect Rclone remote source: ${listing.stderr || `exit code ${listing.exitCode}`}`);
  }

  let remoteEntries;
  try {
    remoteEntries = JSON.parse(listing.stdout || '[]');
  } catch {
    throw new Error('Could not inspect Rclone remote source: invalid listing response');
  }
  assertRemoteSourceHasEntries(remoteEntries, 'Rclone remote source');
}

export function validateRcloneJobInput(job, options = {}) {
  const direction = job.sync_direction || 'upload';
  if (!['upload', 'download', 'bisync'].includes(direction)) {
    throw new Error('sync_direction must be "upload", "download", or "bisync"');
  }
  if (!isSafeRemoteName(job.remote_name)) {
    throw new Error('remote_name must contain only letters, numbers, hyphens, and underscores');
  }
  if (typeof job.remote_path !== 'string' || !job.remote_path.trim() || /[\n\r\0]/.test(job.remote_path) || /(^|\/)\.\.(\/|$)/.test(job.remote_path)) {
    throw new Error('remote_path is required and may not contain control characters or parent segments');
  }

  const localPath = normalizePath(String(job.local_path || '').trim());
  if (!localPath || localPath === '/') {
    throw new Error('local_path must be an absolute dedicated directory');
  }
  const roots = options.roots || storageConfig.roots;
  const allowedRoot = roots
    .map(normalizePath)
    .filter(Boolean)
    .find(root => localPath !== root && isWithinPrefix(localPath, root));
  if (!allowedRoot) {
    throw new Error('local_path must be a dedicated subdirectory of a configured storage root');
  }

  const databaseDirectory = normalizePath(dirname(options.databasePath || db.name));
  if (direction !== 'upload' && databaseDirectory && (pathsOverlap(localPath, databaseDirectory) || localPathsOverlap(localPath, databaseDirectory))) {
    throw new Error('local_path may not overlap the RedMan database directory for download or bisync jobs');
  }

  return { ...job, local_path: localPath, sync_direction: direction, allowedRoot };
}

// Execute an rclone sync job
export async function executeRcloneJob(jobId, existingRunId = null) {
  const storedJob = db.prepare('SELECT * FROM rclone_jobs WHERE id = ?').get(jobId);
  if (!storedJob) throw new Error(`Rclone job ${jobId} not found`);
  let job = storedJob;

  let runId = existingRunId;
  if (runId) {
    db.prepare(`UPDATE backup_runs SET status = 'running' WHERE id = ?`).run(runId);
  } else {
    const claim = claimBackupRun(db, 'rclone', jobId);
    if (!claim.claimed) return { runId: claim.runId, status: 'running', skipped: true };
    runId = claim.runId;
  }

  const startTime = Date.now();
  activeRuns.set(runId, { status: 'running', progress: null, startedAt: startTime });
  const notifications = createJobNotificationTracker({
    job, feature: 'Rclone Sync', name: job.name, runId, startedAt: startTime,
  });

  try {
    job = validateRcloneJobInput(storedJob);
    const localPath = job.sync_direction === 'download'
      ? ensureDirectoryWithinPrefix(job.local_path, job.allowedRoot).path
      : resolveExistingPathWithinPrefix(job.local_path, job.allowedRoot).path;
    const remote = `${job.remote_name}:${job.remote_path}`;
    let args;

    if (job.sync_direction === 'bisync') {
      await assertLocalSourceHasEntries(localPath, 'Rclone local source');
      await assertRcloneRemoteHasEntries(remote);
      args = ['bisync', localPath, remote, '-v'];

      // First run or after reset needs --resync
      if (job.bisync_resync_needed) {
        args.push('--resync');
      }
    } else if (job.sync_direction === 'upload') {
      await assertLocalSourceHasEntries(localPath, 'Rclone upload source');
      args = ['sync', localPath, remote, '-v'];
    } else {
      // download
      await assertRcloneRemoteHasEntries(remote);
      args = ['sync', remote, localPath, '-v'];
    }
    notifications.start();

    args.push('--stats-one-line', '--stats', '2s', '--transfers', '16', '--checkers', '16', '--fast-list', '--retries', '1',
      '--drive-pacer-min-sleep', '10ms', '--drive-pacer-burst', '200');

    const insertFile = db.prepare(`
      INSERT INTO backup_run_files (run_id, file_path, action, size, error) VALUES (?, ?, ?, ?, ?)
    `);
    const insertAllFiles = db.transaction((entries) => {
      for (const entry of entries) insertFile.run(entry.runId, entry.path, entry.action, entry.size, entry.error);
    });
    let fileBatch = [];
    // Kept for the run summary. Bounded: only failures, and only what is needed
    // to name the cause, so a run that fails on everything cannot grow this
    // without limit.
    const failures = [];
    const MAX_TRACKED_FAILURES = 5_000;
    const flushFiles = () => {
      if (fileBatch.length === 0) return;
      insertAllFiles(fileBatch);
      fileBatch = [];
    };
    const logProcessor = createRcloneLogProcessor({
      onFileEntry(file) {
        fileBatch.push({ runId, path: file.path, action: file.action, size: file.size || 0, error: file.error || null });
        if (file.action === 'error' && failures.length < MAX_TRACKED_FAILURES) {
          failures.push({ path: file.path, error: file.error });
        }
        if (fileBatch.length >= 1000) flushFiles();
      },
    });

    const result = await runRclone(args, runId, (line) => {
      logProcessor.processLine(line);
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
        notifications.progress(update);
      }
    });
    flushFiles();

    const stats = logProcessor.stats;

    // If bisync with --resync succeeded, clear the flag
    if (job.sync_direction === 'bisync' && job.bisync_resync_needed && result.exitCode === 0) {
      db.prepare('UPDATE rclone_jobs SET bisync_resync_needed = 0 WHERE id = ?').run(jobId);
    }

    const duration = (Date.now() - startTime) / 1000;
    const wasCancelled = result.exitCode === null || result.exitCode === 143 || result.exitCode === -15;
    const status = wasCancelled ? 'cancelled'
      : result.exitCode === 0
        ? (stats.filesFailed > 0 ? 'partial' : 'completed')
        : stats.filesCopied > 0 ? 'partial' : 'failed';

    // Compare against the previous run so a job that has been failing the same
    // way for weeks cannot hide the one failure that is new tonight.
    let comparison = null;
    if (failures.length > 0) {
      const previousRun = db.prepare(`
        SELECT id FROM backup_runs
        WHERE feature = 'rclone' AND config_id = ? AND id < ? AND status IN ('completed', 'partial', 'failed')
        ORDER BY id DESC LIMIT 1
      `).get(jobId, runId);
      if (previousRun) {
        const previousFailures = db.prepare(`
          SELECT error, COUNT(*) AS count FROM backup_run_files
          WHERE run_id = ? AND action = 'error' GROUP BY error
        `).all(previousRun.id);
        comparison = compareFailureSummaries(
          summariseRcloneFailures(failures),
          summariseRcloneFailures(previousFailures),
        );
      }
    }

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
      stats.filesFailed > 0 ? describeRcloneFailures(failures, comparison) || `${stats.filesFailed} file(s) failed` : null,
      runId,
    );

    // Notification
    if (status === 'completed' && shouldNotify(job, 'success')) {
      await notifyBackupResult('Rclone Sync', job.name, 'completed', {
        filesCopied: stats.filesCopied, filesFailed: stats.filesFailed,
        bytesTransferred: stats.bytesTransferred, duration,
      });
    } else if (status === 'partial' && shouldNotify(job, 'partial')) {
      await notifyBackupResult('Rclone Sync', job.name, 'partial', {
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
    notifications.close();
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
      reject(new Error(`rclone is not installed or not accessible: ${err.message}`));
      return;
    }
    if (runId) activeProcesses.set(runId, proc);
    let stdout = '';
    let stderr = '';
    let stderrRemainder = '';
    let lineHandlerError = null;
    const maxOutputBytes = runId ? 64 * 1024 : 1024 * 1024;

    proc.stdout.on('data', d => { stdout = appendOutputTail(stdout, d.toString(), maxOutputBytes); });
    proc.stderr.on('data', d => {
      const text = d.toString();
      stderr = appendOutputTail(stderr, text, maxOutputBytes);
      const lines = `${stderrRemainder}${text}`.split(/[\r\n]+/);
      stderrRemainder = lines.pop() || '';
      if (onStderrLine && !lineHandlerError) {
        try {
          for (const line of lines) if (line.trim()) onStderrLine(line);
        } catch (err) {
          lineHandlerError = err;
          proc.kill('SIGTERM');
        }
      }
    });

    proc.on('close', (exitCode) => {
      if (runId) activeProcesses.delete(runId);
      if (stderrRemainder && onStderrLine && !lineHandlerError) {
        try { onStderrLine(stderrRemainder); } catch (err) { lineHandlerError = err; }
      }
      if (lineHandlerError) {
        reject(new Error(`Failed to process rclone output: ${lineHandlerError.message}`));
        return;
      }
      resolve({ exitCode, stdout, stderr });
    });

    proc.on('error', (err) => {
      if (runId) activeProcesses.delete(runId);
      if (err.code === 'ENOENT' || err.code === 'EAGAIN') {
        reject(new Error('rclone is not installed. Install it with: curl https://rclone.org/install.sh | sudo bash'));
      } else {
        reject(new Error(`Failed to start rclone: ${err.message}`));
      }
    });
  });
}

export function createRcloneLogProcessor({ onFileEntry = null } = {}) {
  const stats = { filesTotal: 0, filesCopied: 0, filesFailed: 0, bytesTransferred: 0 };

  function processLine(line) {
    // Parse transferred files
    const transferMatch = line.match(/INFO\s*:\s*(.+?):\s*(Copied|Moved|Deleted|Updated)\s*/);
    if (transferMatch) {
      const [, path, action] = transferMatch;
      stats.filesTotal++;
      stats.filesCopied++;
      onFileEntry?.({ path, action: action.toLowerCase(), size: 0 });
      return;
    }

    // Parse errors (skip aggregate/retry lines that aren't file-level errors)
    const errorMatch = line.match(/ERROR\s*:\s*(.+?):\s*(.+)/);
    if (errorMatch) {
      const errPath = errorMatch[1].trim();
      // Skip rclone aggregate messages (retries, "not deleting" warnings, etc.)
      if (/^Attempt \d+\/\d+ failed/.test(errPath) ||
          /^Google drive root/.test(errPath) ||
          /^Failed to sync/.test(errPath)) {
        return;
      }
      stats.filesFailed++;
      // Strip redundant file paths from error message (already shown in the file column)
      const errMsg = errorMatch[2].replace(/\/mnt\/\S+:\s*/g, '').replace(/:\s*$/, '');
      onFileEntry?.({ path: errPath, action: 'error', size: 0, error: errMsg });
      return;
    }

    // Parse aggregate stats — format on stderr: "9.215 MiB / 9.215 MiB, 100%, ..."
    const bytesLine = line.match(/([\d.]+\s*\w+)\s*\/\s*([\d.]+\s*\w+),\s*\d+%/);
    if (bytesLine) {
      stats.bytesTransferred = parseRcloneSize(bytesLine[1]);
    }

    const xfrMatch = line.match(/\(xfr#(\d+)\/(\d+)\)/);
    if (xfrMatch) {
      stats.filesCopied = parseInt(xfrMatch[1]);
      stats.filesTotal = parseInt(xfrMatch[2]);
    }
  }

  return { stats, processLine };
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
  'type', 'token', 'client_id', 'client_secret', 'scope', 'root_folder_id', 'drive_id',
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

async function discoverOneDriveMetadata(params) {
  if (params.drive_id) return params;
  if (!params.token) {
    throw new Error('OneDrive requires an OAuth token to discover its drive ID');
  }

  let token;
  try {
    token = JSON.parse(params.token);
  } catch {
    throw new Error('OneDrive OAuth token must be valid JSON');
  }
  if (!token.access_token) {
    throw new Error('OneDrive OAuth token is missing an access token');
  }

  let response;
  try {
    response = await fetch('https://graph.microsoft.com/v1.0/me/drive?$select=id,driveType', {
      headers: { Authorization: `Bearer ${token.access_token}` },
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new Error('Unable to reach OneDrive while discovering the drive ID');
  }
  if (!response.ok) {
    throw new Error('Unable to discover the OneDrive drive ID; re-authorize and try again');
  }

  const drive = await response.json();
  if (!drive.id || !drive.driveType) {
    throw new Error('OneDrive returned incomplete drive metadata');
  }
  return { ...params, drive_id: drive.id, drive_type: drive.driveType };
}

// List available provider types
export function getProviderTypes() {
  return [...ALLOWED_TYPES].sort();
}

// Get full config for a remote (redacted sensitive fields)
export async function getRemoteConfig(name) {
  if (!isSafeRemoteName(name)) throw new Error('Invalid remote name');
  const result = await runRclone(['config', 'dump']);
  if (result.exitCode !== 0) throw new Error(`rclone config dump failed: ${result.stderr}`);
  const allConfig = JSON.parse(result.stdout);
  const config = allConfig[name];
  if (!config) throw new Error(`Remote "${name}" not found`);
  return { name, type: config.type, ...redactSensitive(config) };
}

// Create a new remote
export async function createRemote(name, type, params = {}) {
  if (!isSafeRemoteName(name)) {
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

  const resolvedParams = type === 'onedrive' ? await discoverOneDriveMetadata(params) : params;
  const safeParams = filterParams(resolvedParams);
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
  if (!isSafeRemoteName(name)) throw new Error('Invalid remote name');
  const existing = await listRemotes();
  if (!existing.includes(name)) {
    throw new Error(`Remote "${name}" not found`);
  }

  const current = await getRemoteConfig(name);
  const resolvedParams = current.type === 'onedrive' && !current.drive_id
    ? await discoverOneDriveMetadata(params)
    : params;
  const safeParams = filterParams(resolvedParams);
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
  if (!isSafeRemoteName(name)) throw new Error('Invalid remote name');
  const existing = await listRemotes();
  if (!existing.includes(name)) {
    throw new Error(`Remote "${name}" not found`);
  }

  const result = await runRclone(['config', 'delete', name]);
  if (result.exitCode !== 0) throw new Error(`Failed to delete remote: ${result.stderr}`);
}

// Test a remote is reachable
export async function testRemote(name) {
  if (!isSafeRemoteName(name)) throw new Error('Invalid remote name');
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

const SENSITIVE_KEYS = new Set([
  'token', 'password', 'secret', 'client_secret', 'pass', 'key',
  'service_account_credentials', 'service_account_file', 'access_key_id',
  'secret_access_key', 'key_file', 'key_pem', 'app_key', 'app_secret',
  '2fa', 'mailbox_password',
]);

export function redactSensitive(config) {
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

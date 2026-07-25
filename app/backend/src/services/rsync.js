// Rsync executor service
// Spawns rsync as a child process, parses output, stores reports

import { spawn, execFileSync } from 'child_process';
import { mkdir, access, constants } from 'fs/promises';
import { readdir } from 'fs/promises';
import { join } from 'path';
import os from 'os';
import db from '../db.js';
import { createJobNotificationTracker, notifyBackupResult, shouldNotify } from './notify.js';
import { pruneVersions } from './versionBrowser.js';
import { withConfigLock, rebaseDeltasWithTimestamp, deltaifySnapshot, computeVersionStats } from './deltaVersion.js';
import { backupDatabase } from './dbBackup.js';
import { isCancelledRun } from './runStatus.js';
import { claimBackupRun } from './runClaim.js';
import { terminateChildProcesses } from './childProcessShutdown.js';
import { listExcludePatterns } from './excludePolicy.js';
import { createRsyncOutputProcessor, parseItemizeAction } from './rsyncOutput.js';
import { localPathsOverlap, validateSsdBackupPaths } from '../middleware/validation.js';
import { storageConfig } from './storageConfig.js';

export { parseItemizeAction };

// Active runs tracked for progress reporting
const activeRuns = new Map();
const activeRunControllers = new Map();

// Active child processes tracked for graceful shutdown and cancellation
const activeProcesses = new Map(); // runId -> ChildProcess

const IS_MAC = os.platform() === 'darwin';

// Spawn rsync with line-buffered stdout.
// macOS openrsync buffers all output when piped — wrap with `script` to force a PTY.
// Linux GNU rsync supports --outbuf=L for line buffering.
function spawnRsync(args) {
  if (IS_MAC) {
    return spawn('script', ['-q', '/dev/null', 'rsync', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  return spawn('rsync', [...args, '--outbuf=L'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function getActiveRun(runId) {
  return activeRuns.get(runId);
}

export function cancelSsdRun(runId) {
  const proc = activeProcesses.get(runId);
  const controller = activeRunControllers.get(runId);
  if (!proc && !controller) return false;
  controller?.abort(new Error('Cancelled by user'));
  if (proc) {
    proc.kill('SIGTERM');
  }
  return true;
}

export async function executeSsdBackup(configId, existingRunId = null) {
  const config = db.prepare('SELECT * FROM ssd_backup_configs WHERE id = ?').get(configId);
  if (!config) throw new Error(`SSD backup config ${configId} not found`);

  let runId = existingRunId;
  if (runId) {
    db.prepare(`UPDATE backup_runs SET status = 'running' WHERE id = ?`).run(runId);
  } else {
    const claim = claimBackupRun(db, 'ssd-backup', configId);
    if (!claim.claimed) return { runId: claim.runId, status: 'running', skipped: true };
    runId = claim.runId;
  }

  const startTime = Date.now();
  const cancellation = new AbortController();
  activeRunControllers.set(runId, cancellation);
  const progress = {
    filesTotal: 0, filesCopied: 0, filesFailed: 0, bytesTransferred: 0,
    currentFile: null, startedAt: startTime,
    speed: null, percent: null, filesRemaining: null, eta: null,
  };
  activeRuns.set(runId, progress);
  const notifications = createJobNotificationTracker({
    job: config, feature: 'SSD Backup', name: config.name, runId, startedAt: startTime,
  });
  const persistCancelledProgress = () => {
    db.prepare(`
      UPDATE backup_runs SET
        files_total = ?, files_copied = ?, files_failed = ?, bytes_transferred = ?,
        duration_seconds = ?, error_message = 'Cancelled by user'
      WHERE id = ? AND status = 'cancelled'
    `).run(
      progress.filesTotal, progress.filesCopied, progress.filesFailed,
      progress.bytesTransferred, (Date.now() - startTime) / 1000, runId,
    );
  };

  try {
    const pathCheck = validateSsdBackupPaths(config.source_path, config.dest_path, [
      ...storageConfig.roots,
      storageConfig.mediaRoot,
    ]);
    if (!pathCheck.ok) throw new Error(pathCheck.error);
    const overlappingConfig = db.prepare('SELECT id, name, dest_path FROM ssd_backup_configs WHERE id != ?').all(configId)
      .find(other => localPathsOverlap(config.dest_path, other.dest_path));
    if (overlappingConfig) {
      throw new Error(`Destination overlaps backup "${overlappingConfig.name}" (${overlappingConfig.dest_path})`);
    }

    // Pre-flight checks
    try {
      await access(config.source_path, constants.R_OK);
    } catch {
      throw new Error(`Source path not accessible: ${config.source_path}`);
    }
    try {
      await access(config.dest_path, constants.W_OK);
    } catch {
      // Try to create it
      await mkdir(config.dest_path, { recursive: true });
    }

    // Check available disk space on destination
    try {
      const dfOutput = execFileSync('df', ['-k', config.dest_path], { encoding: 'utf-8' });
      const lines = dfOutput.trim().split('\n');
      const parts = lines[lines.length - 1].trim().split(/\s+/);
      // df -k output: filesystem 1K-blocks used available capacity mountpoint
      const availableKB = parseInt(parts[3]);
      if (!isNaN(availableKB)) {
        const availableGB = availableKB / (1024 * 1024);
        if (availableKB === 0) {
          // Unraid's shfs reports 0 available inside containers — skip the check
          console.warn(`[ssd-backup] df reports 0 available for "${config.dest_path}" (likely Unraid shfs) — skipping space check`);
        } else if (availableGB < 1) {
          throw new Error(`Destination has less than 1 GB free (${availableGB.toFixed(2)} GB). Aborting to prevent disk full.`);
        } else if (availableGB < 10) {
          console.warn(`[ssd-backup] Warning: destination "${config.dest_path}" has only ${availableGB.toFixed(1)} GB free`);
        }
      }
    } catch (err) {
      if (err.message.includes('Aborting to prevent')) throw err;
      // df failed (e.g. path doesn't support it) — continue anyway
    }

    // Empty-source safeguard: if the source is empty but the destination still
    // holds data, a lost/unmounted share would let --delete-after wipe the entire
    // backup on the next run. This is the classic rsync footgun. Abort unless the
    // user has explicitly opted in via the ssd_allow_empty_source setting.
    const allowEmptySource = db.prepare("SELECT value FROM settings WHERE key = 'ssd_allow_empty_source'").get()?.value === '1';
    if (!allowEmptySource) {
      const CONTROL_DIRS = new Set(['.versions', '.rsync-partial', '.redman-db-backup']);
      let sourceEntries = null;
      try { sourceEntries = await readdir(config.source_path); } catch { sourceEntries = null; }
      if (sourceEntries && sourceEntries.length === 0) {
        let destEntries = [];
        try { destEntries = await readdir(config.dest_path); } catch { destEntries = []; }
        const destData = destEntries.filter(e => !CONTROL_DIRS.has(e));
        if (destData.length > 0) {
          throw new Error(
            `Source "${config.source_path}" is empty but the destination still contains ${destData.length} item(s). ` +
            `Aborting to prevent rsync --delete from wiping the backup — the source may be unmounted or unavailable. ` +
            `If the source is intentionally empty, enable "ssd_allow_empty_source" in Settings.`
          );
        }
      }
    }
    notifications.start();

    // Build rsync command arguments
    const args = [
      '-av',
      '--no-owner',
      '--no-group',
      '--omit-dir-times',
      '--delete-after',
      '--exclude=.versions',
      '--exclude=.rsync-partial',
      '--exclude=.redman-db-backup',
      '--itemize-changes',
      '--stats',
      '--human-readable',
      // Resume partial transfers on interruption
      '--partial',
      '--partial-dir=.rsync-partial',
      // Abort if no data transferred for 5 minutes (protects against hangs)
      '--timeout=300',
      // GNU rsync: --info=progress2 gives byte-based overall progress
      // openrsync (macOS): only supports --progress (file-count based)
      IS_MAC ? '--progress' : '--info=progress2',
      '--out-format=%i %l %n',
    ];

    // User-defined excludes (newline- or comma-separated). Applied to both the
    // transfer and --delete scanning, so a nested backup destination can be
    // protected from a parent job's --delete-after wiping it out.
    if (config.exclude_patterns) {
      for (const pattern of listExcludePatterns(config.exclude_patterns)) {
        args.push(`--exclude=${pattern}`);
      }
    }

    // Add versioning if enabled
    let versionTimestamp = null;
    if (config.versioning_enabled) {
      versionTimestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const versionDir = join(config.dest_path, '.versions', versionTimestamp);
      await mkdir(versionDir, { recursive: true });
      args.push(`--backup`, `--backup-dir=${versionDir}`);
    }

    // Source must end with / for rsync to copy contents
    const source = config.source_path.endsWith('/') ? config.source_path : config.source_path + '/';
    args.push(source, config.dest_path + '/');

    const result = await runRsync(args, runId, progress, update => notifications.progress(update));

    // Determine status: exit code 23 = partial transfer (some attrs failed but data ok)
    // If any files failed we downgrade a clean exit to 'partial' so the UI reflects reality.
    const persistedStatus = db.prepare('SELECT status FROM backup_runs WHERE id = ?').get(runId)?.status;
    let status;
    if (isCancelledRun(persistedStatus, result.exitCode)) {
      status = 'cancelled';
    } else if (result.exitCode === 0) {
      status = progress.filesFailed > 0 ? 'partial' : 'completed';
    } else if (result.exitCode === 23 && progress.filesCopied > 0) {
      status = 'partial';
    } else {
      status = 'failed';
    }

    const postProcessingErrors = [];
    // 'verified' | 'skipped' | 'failed', or null when this run never reached the database backup stage.
    let databaseBackupStatus = null;
    const runPostProcessingStage = async (stage, operation) => {
      cancellation.signal.throwIfAborted();
      const stageStartedAt = Date.now();
      progress.stage = stage;
      console.log(`[ssd-backup] Post-processing ${stage} started for "${config.name}" (run ${runId})`);
      try {
        const value = await operation();
        cancellation.signal.throwIfAborted();
        console.log(`[ssd-backup] Post-processing ${stage} completed in ${((Date.now() - stageStartedAt) / 1000).toFixed(2)}s for "${config.name}" (run ${runId})`);
        return value;
      } catch (err) {
        if (cancellation.signal.aborted) throw err;
        const warning = `${stage}: ${err.message}`;
        postProcessingErrors.push(warning);
        console.error(`[ssd-backup] Post-processing ${stage} failed after ${((Date.now() - stageStartedAt) / 1000).toFixed(2)}s for "${config.name}" (run ${runId}):`, err.message);
        return null;
      }
    };

    // Prune old version snapshots after successful backup. The run remains
    // active until post-processing finishes so terminal status is trustworthy.
    if ((status === 'completed' || status === 'partial') && config.versioning_enabled) {
      // Delta versioning: rebase existing deltas then deltaify the new snapshot
      if (config.delta_versioning && versionTimestamp) {
        await runPostProcessingStage('delta versioning', async () => {
          // Get list of changed files from this run
          const runFiles = db.prepare('SELECT file_path FROM backup_run_files WHERE run_id = ? AND action IN (?, ?, ?)').all(runId, 'transferred', 'created', 'updated');
          const changedFiles = runFiles.map(f => f.file_path);

          await withConfigLock(configId, async () => {
            await rebaseDeltasWithTimestamp(configId, changedFiles, versionTimestamp, { signal: cancellation.signal });
            await deltaifySnapshot(configId, versionTimestamp, { signal: cancellation.signal });
          }, { signal: cancellation.signal });
        });
      }

      await runPostProcessingStage('version pruning', () => pruneVersions(configId, {
        signal: cancellation.signal,
        updateStats: false,
      }));

      // Update cached version stats
      await runPostProcessingStage('version statistics', () => computeVersionStats(configId, { signal: cancellation.signal }));

      // Back up the RedMan database to this destination
      const warningsBeforeDatabaseBackup = postProcessingErrors.length;
      const databaseBackupPath = await runPostProcessingStage('database backup', () => backupDatabase(config.dest_path, { signal: cancellation.signal }));
      if (postProcessingErrors.length > warningsBeforeDatabaseBackup) databaseBackupStatus = 'failed';
      else databaseBackupStatus = databaseBackupPath ? 'verified' : 'skipped';
    }

    delete progress.stage;
    if (postProcessingErrors.length > 0 && status === 'completed') status = 'partial';
    const duration = (Date.now() - startTime) / 1000;
    const runError = [
      status === 'cancelled' ? 'Cancelled by user' : result.errorOutput,
      ...postProcessingErrors.map(error => `Post-processing warning: ${error}`),
    ].filter(Boolean).join('\n') || null;
    const transition = db.prepare(`
      UPDATE backup_runs SET
        status = ?, completed_at = datetime('now'),
        files_total = ?, files_copied = ?, files_failed = ?,
        bytes_transferred = ?, duration_seconds = ?, error_message = ?,
        db_backup_status = ?
      WHERE id = ? AND status = 'running'
    `).run(
      status,
      progress.filesTotal, progress.filesCopied, progress.filesFailed,
      progress.bytesTransferred, duration, runError, databaseBackupStatus, runId,
    );
    if (transition.changes !== 1) {
      const currentStatus = db.prepare('SELECT status FROM backup_runs WHERE id = ?').get(runId)?.status;
      if (currentStatus === 'cancelled') {
        persistCancelledProgress();
        return { runId, status: 'cancelled' };
      }
      throw new Error(`Could not persist terminal SSD backup status from ${currentStatus || 'missing'} state`);
    }

    // Send notification only after post-processing and terminal persistence.
    if (status === 'completed' && shouldNotify(config, 'success')) {
      await notifyBackupResult('SSD Backup', config.name, status, {
        filesCopied: progress.filesCopied, filesFailed: progress.filesFailed,
        bytesTransferred: progress.bytesTransferred, duration,
      });
    } else if (status === 'partial' && shouldNotify(config, 'partial')) {
      await notifyBackupResult('SSD Backup', config.name, status, {
        filesCopied: progress.filesCopied, filesFailed: progress.filesFailed,
        bytesTransferred: progress.bytesTransferred, duration,
        errorMessage: runError || undefined,
      });
    } else if (status === 'failed' && shouldNotify(config, 'failure')) {
      await notifyBackupResult('SSD Backup', config.name, 'failed', {
        filesCopied: progress.filesCopied, filesFailed: progress.filesFailed,
        bytesTransferred: progress.bytesTransferred, duration,
      });
    }

    return { runId, status };
  } catch (err) {
    const persistedStatus = db.prepare('SELECT status FROM backup_runs WHERE id = ?').get(runId)?.status;
    if (persistedStatus === 'cancelled') {
      persistCancelledProgress();
      return { runId, status: 'cancelled' };
    }

    db.prepare(`
      UPDATE backup_runs SET status = 'failed', completed_at = datetime('now'),
        error_message = ?, duration_seconds = ?
      WHERE id = ?
    `).run(err.message, (Date.now() - startTime) / 1000, runId);

    if (shouldNotify(config, 'failure')) {
      await notifyBackupResult('SSD Backup', config.name, 'failed', {});
    }
    throw err;
  } finally {
    notifications.close();
    activeRunControllers.delete(runId);
    activeRuns.delete(runId);
  }
}

// Batch size for file inserts — flushes every N files in a single transaction
const FILE_INSERT_BATCH_SIZE = 1000;

// Run rsync and parse output
function runRsync(args, runId, progress, onProgress = null) {
  return new Promise((resolve, reject) => {
    const proc = spawnRsync(args);
    activeProcesses.set(runId, proc);

    const insertFile = db.prepare(`
      INSERT INTO backup_run_files (run_id, file_path, action, size) VALUES (?, ?, ?, ?)
    `);
    const flushBatch = db.transaction((batch) => {
      for (const entry of batch) insertFile.run(entry.runId, entry.path, entry.action, entry.size);
    });
    let fileBatch = [];
    let persistenceError = '';
    const processor = createRsyncOutputProcessor({
      progress,
      platform: IS_MAC ? 'darwin' : 'linux',
      onProgress,
      onFileEntry(entry) {
        fileBatch.push({ runId, ...entry });
        if (fileBatch.length >= FILE_INSERT_BATCH_SIZE) {
          flushBatch(fileBatch);
          fileBatch = [];
        }
      },
    });

    proc.stdout.on('data', (data) => {
      processor.writeStdout(data);
    });

    proc.stderr.on('data', (data) => {
      processor.writeStderr(data);
    });

    proc.on('close', (exitCode) => {
      activeProcesses.delete(runId);
      processor.flush();
      if (fileBatch.length > 0) {
        try { flushBatch(fileBatch); } catch (err) {
          persistenceError = `Failed to persist file batch: ${err.message}`;
        }
        fileBatch = [];
      }
      const { stderr } = processor.output();
      const errorOutput = [stderr.trim(), persistenceError].filter(Boolean).join('\n');
      resolve({ exitCode, errorOutput: errorOutput || null });
    });

    proc.on('error', (err) => {
      activeProcesses.delete(runId);
      if (fileBatch.length > 0) {
        try { flushBatch(fileBatch); } catch {}
        fileBatch = [];
      }
      reject(new Error(`Failed to start rsync: ${err.message}`));
    });
  });
}
// The local rsync binary may be openrsync (macOS) — use spawnRsync for line buffering.
export function runRsyncWithSsh(args, onProgress = null, runId = null, onFileEntry = null) {
  return new Promise((resolve, reject) => {
    const proc = spawnRsync(args);
    if (runId) activeProcesses.set(runId, proc);

    const processor = createRsyncOutputProcessor({
      platform: IS_MAC ? 'darwin' : 'linux',
      onProgress,
      onFileEntry,
    });

    proc.stdout.on('data', (data) => {
      processor.writeStdout(data);
    });

    proc.stderr.on('data', (data) => {
      processor.writeStderr(data);
    });

    proc.on('close', (exitCode) => {
      processor.flush();
      if (runId) activeProcesses.delete(runId);
      resolve({ exitCode, ...processor.output() });
    });

    proc.on('error', (err) => {
      if (runId) activeProcesses.delete(runId);
      reject(new Error(`Failed to start rsync: ${err.message}`));
    });
  });
}

// Kill all active rsync child processes (for graceful shutdown)
export function killActiveRsyncProcesses() {
  for (const controller of activeRunControllers.values()) {
    controller.abort(new Error('RedMan is shutting down'));
  }
  for (const proc of activeProcesses.values()) {
    try { proc.kill('SIGTERM'); } catch {}
  }
  activeProcesses.clear();
}

export async function stopActiveRsyncProcesses(timeoutMs = 10000) {
  for (const controller of activeRunControllers.values()) {
    controller.abort(new Error('RedMan is shutting down'));
  }
  return terminateChildProcesses(activeProcesses.values(), timeoutMs);
}

// Rsync executor service
// Spawns rsync as a child process, parses output, stores reports

import { spawn, execSync } from 'child_process';
import { mkdir, access, constants } from 'fs/promises';
import { join } from 'path';
import os from 'os';
import db from '../db.js';
import { notifyBackupResult } from './notify.js';
import { pruneVersions } from './versionBrowser.js';
import { withConfigLock, rebaseDeltasWithTimestamp, deltaifySnapshot, computeVersionStats } from './deltaVersion.js';
import { backupDatabase } from './dbBackup.js';

// Active runs tracked for progress reporting
const activeRuns = new Map();

// Active child processes tracked for graceful shutdown
const activeProcesses = new Set();

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

// Strip control chars injected by PTY wrapper (but NOT \r — we split on it)
function cleanLine(line) {
  return line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').trim();
}

export function getActiveRun(runId) {
  return activeRuns.get(runId);
}

export async function executeSsdBackup(configId, existingRunId = null) {
  const config = db.prepare('SELECT * FROM ssd_backup_configs WHERE id = ?').get(configId);
  if (!config) throw new Error(`SSD backup config ${configId} not found`);

  let runId = existingRunId;
  if (runId) {
    db.prepare(`UPDATE backup_runs SET status = 'running' WHERE id = ?`).run(runId);
  } else {
    const run = db.prepare(`
      INSERT INTO backup_runs (feature, config_id, status) VALUES ('ssd-backup', ?, 'running')
    `).run(configId);
    runId = Number(run.lastInsertRowid);
  }

  const startTime = Date.now();
  const progress = {
    filesTotal: 0, filesCopied: 0, filesFailed: 0, bytesTransferred: 0,
    currentFile: null, startedAt: startTime,
    speed: null, percent: null, filesRemaining: null, eta: null,
  };
  activeRuns.set(runId, progress);

  try {
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
      const dfOutput = execSync(`df -k "${config.dest_path}" 2>/dev/null | tail -1`, { encoding: 'utf-8' });
      const parts = dfOutput.trim().split(/\s+/);
      // df -k output: filesystem 1K-blocks used available capacity mountpoint
      const availableKB = parseInt(parts[3]);
      if (!isNaN(availableKB)) {
        const availableGB = availableKB / (1024 * 1024);
        if (availableGB < 1) {
          throw new Error(`Destination has less than 1 GB free (${availableGB.toFixed(2)} GB). Aborting to prevent disk full.`);
        }
        if (availableGB < 10) {
          console.warn(`[ssd-backup] Warning: destination "${config.dest_path}" has only ${availableGB.toFixed(1)} GB free`);
        }
      }
    } catch (err) {
      if (err.message.includes('Aborting to prevent')) throw err;
      // df failed (e.g. path doesn't support it) — continue anyway
    }

    // Build rsync command arguments
    const args = [
      '-av',
      '--delete',
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

    const result = await runRsync(args, runId, progress);

    // Update run record
    const duration = (Date.now() - startTime) / 1000;
    db.prepare(`
      UPDATE backup_runs SET
        status = ?, completed_at = datetime('now'),
        files_total = ?, files_copied = ?, files_failed = ?,
        bytes_transferred = ?, duration_seconds = ?, error_message = ?
      WHERE id = ?
    `).run(
      result.exitCode === 0 ? 'completed' : 'failed',
      progress.filesTotal, progress.filesCopied, progress.filesFailed,
      progress.bytesTransferred, duration, result.errorOutput || null,
      runId,
    );

    // Send notification
    if (config.notify_on_success && result.exitCode === 0) {
      await notifyBackupResult('SSD Backup', config.name, 'completed', {
        filesCopied: progress.filesCopied, filesFailed: progress.filesFailed,
        bytesTransferred: progress.bytesTransferred, duration,
      });
    } else if (config.notify_on_failure && result.exitCode !== 0) {
      await notifyBackupResult('SSD Backup', config.name, 'failed', {
        filesCopied: progress.filesCopied, filesFailed: progress.filesFailed,
        bytesTransferred: progress.bytesTransferred, duration,
      });
    }

    // Prune old version snapshots after successful backup
    if (result.exitCode === 0 && config.versioning_enabled) {
      // Delta versioning: rebase existing deltas then deltaify the new snapshot
      if (config.delta_versioning && versionTimestamp) {
        try {
          // Get list of changed files from this run
          const runFiles = db.prepare('SELECT file_path FROM backup_run_files WHERE run_id = ? AND action IN (?, ?, ?)').all(runId, 'transferred', 'created', 'updated');
          const changedFiles = runFiles.map(f => f.file_path);

          await withConfigLock(configId, async () => {
            await rebaseDeltasWithTimestamp(configId, changedFiles, versionTimestamp);
            await deltaifySnapshot(configId, versionTimestamp);
          });
        } catch (err) {
          console.error(`[ssd-backup] Delta versioning failed for "${config.name}":`, err.message);
        }
      }

      try {
        await pruneVersions(configId);
      } catch (err) {
        console.error(`[ssd-backup] Version pruning failed for "${config.name}":`, err.message);
      }

      // Update cached version stats
      try {
        await computeVersionStats(configId);
      } catch {}

      // Back up the RedMan database to this destination
      try {
        await backupDatabase(config.dest_path);
      } catch (err) {
        console.error(`[ssd-backup] DB backup failed for "${config.name}":`, err.message);
      }
    }

    return { runId, status: result.exitCode === 0 ? 'completed' : 'failed' };
  } catch (err) {
    db.prepare(`
      UPDATE backup_runs SET status = 'failed', completed_at = datetime('now'),
        error_message = ?, duration_seconds = ?
      WHERE id = ?
    `).run(err.message, (Date.now() - startTime) / 1000, runId);

    if (config.notify_on_failure) {
      await notifyBackupResult('SSD Backup', config.name, 'failed', {});
    }
    throw err;
  } finally {
    activeRuns.delete(runId);
  }
}

// Batch size for file inserts — flushes every N files in a single transaction
const FILE_INSERT_BATCH_SIZE = 1000;

// Run rsync and parse output
function runRsync(args, runId, progress) {
  return new Promise((resolve, reject) => {
    const proc = spawnRsync(args);
    activeProcesses.add(proc);

    const insertFile = db.prepare(`
      INSERT INTO backup_run_files (run_id, file_path, action, size) VALUES (?, ?, ?, ?)
    `);
    const flushBatch = db.transaction((batch) => {
      for (const entry of batch) insertFile.run(entry.runId, entry.path, entry.action, entry.size);
    });
    let fileBatch = [];

    let errorOutput = '';

    proc.stdout.on('data', (data) => {
      const lines = data.toString().split(/[\r\n]+/).map(cleanLine).filter(l => l);

      for (const line of lines) {
        // Parse --out-format=%i %l %n: itemize-changes flag, size, filename
        // {7,9} handles both macOS openrsync (9 char flags) and GNU rsync 3.x (11 char flags)
        const match = line.match(/^([<>.ch*][fdLDS][cstpoguax.+?]{7,9})\s+(\d+)\s+(.+)$/);
        if (match) {
          const [, flags, sizeStr, filename] = match;
          const size = parseInt(sizeStr) || 0;
          const action = parseItemizeAction(flags);

          progress.filesTotal++;
          progress.currentFile = filename;
          if (action === 'transferred' || action === 'created') {
            progress.filesCopied++;
            progress.bytesTransferred += size;
          }

          fileBatch.push({ runId, path: filename, action, size });
          if (fileBatch.length >= FILE_INSERT_BATCH_SIZE) {
            flushBatch(fileBatch);
            fileBatch = [];
          }
          continue;
        }

        // Parse progress output: --info=progress2 (GNU/Linux) or --progress (openrsync/macOS)
        // Only try progress2 on Linux — on macOS --progress emits per-file bytes
        // that look like progress2 output but would overwrite the accumulated total.
        if (IS_MAC || !parseProgress2Line(line, progress)) {
          parseProgressLine(line, progress);
        }

        // Handle *deleting lines (no size field): "*deleting   filename"
        const delMatch = line.match(/^\*deleting\s+(.+)$/);
        if (delMatch) {
          progress.filesTotal++;
          fileBatch.push({ runId, path: delMatch[1], action: 'deleted', size: 0 });
          if (fileBatch.length >= FILE_INSERT_BATCH_SIZE) {
            flushBatch(fileBatch);
            fileBatch = [];
          }
          continue;
        }

        // Parse --stats output for any remaining aggregate data
        const bytesMatch = line.match(/Total transferred file size:\s+([\d,]+)/);
        if (bytesMatch) {
          const bytes = parseInt(bytesMatch[1].replace(/,/g, ''));
          if (bytes > progress.bytesTransferred) progress.bytesTransferred = bytes;
        }
      }
    });

    proc.stderr.on('data', (data) => {
      const text = data.toString();
      errorOutput += text;

      // Count rsync errors (lines starting with "rsync:" or "rsync error:")
      const errorLines = text.split('\n').filter(l => l.startsWith('rsync:') || l.startsWith('rsync error:'));
      progress.filesFailed += errorLines.length;
    });

    proc.on('close', (exitCode) => {
      activeProcesses.delete(proc);
      // Flush remaining buffered file inserts
      if (fileBatch.length > 0) {
        flushBatch(fileBatch);
        fileBatch = [];
      }
      resolve({ exitCode, errorOutput: errorOutput.trim() || null });
    });

    proc.on('error', (err) => {
      activeProcesses.delete(proc);
      // Flush any buffered inserts before rejecting
      if (fileBatch.length > 0) {
        try { flushBatch(fileBatch); } catch {}
        fileBatch = [];
      }
      reject(new Error(`Failed to start rsync: ${err.message}`));
    });
  });
}

// Translate rsync itemize flags to a human-readable action
export function parseItemizeAction(flags) {
  if (!flags || flags.length < 2) return 'unknown';
  const type = flags[0];
  const kind = flags[1];

  if (type === '*' && flags.includes('deleting')) return 'deleted';
  if (type === '>' || type === '<') {
    if (flags.includes('+++++++')) return 'created';
    return 'transferred';
  }
  if (type === 'c' && kind === 'd') return 'directory';
  if (type === '.') return 'unchanged';
  return 'updated';
}

// Parse rsync --progress output line for speed, percentage, and remaining files.
// Format: "  51200 100%   48.79MB/s   00:00:00 (xfer#1, to-check=5/100)"
// openrsync (macOS) uses "to-check=CHECKED/TOTAL" (ascending).
// GNU rsync uses "to-chk=REMAINING/TOTAL" or "ir-chk=REMAINING/TOTAL" (descending).
// Returns true if the line was a progress line.
function parseProgressLine(line, progress) {
  // Match: bytes percent% speed time (xfer#N, to-check|to-chk|ir-chk=N/T)
  const m = line.match(/^\s*([\d,]+)\s+(\d+)%\s+([\d.]+\w+\/s)\s+(\S+)\s+\(xfe?r#(\d+),\s*(to-check|to-chk|ir-chk)=(\d+)\/(\d+)\)/);
  if (m) {
    progress.speed = m[3];
    const variant = m[6];
    const n = parseInt(m[7]);
    const total = parseInt(m[8]);
    if (total > 0) {
      // openrsync "to-check" = checked count (ascending), GNU "to-chk"/"ir-chk" = remaining (descending)
      const newPercent = variant === 'to-check'
        ? Math.round((n / total) * 100)
        : Math.round(((total - n) / total) * 100);
      // Never decrease — rsync's total can grow as the file list is built incrementally
      if (progress.percent == null || newPercent > progress.percent) {
        progress.percent = newPercent;
      }
    }
    return true;
  }

  // Simpler format without to-check (mid-file progress): "  51200 100%   48.79MB/s   00:00:00"
  const simple = line.match(/^\s*[\d,]+\s+\d+%\s+([\d.]+\w+\/s)/);
  if (simple) {
    progress.speed = simple[1];
    return true;
  }

  return false;
}

// Parse GNU rsync --info=progress2 overall progress line (Linux only).
// Format: "  1,234,567,890  42%  234.56MB/s    0:00:05  (xfr#50, to-chk=950/1000)"
// Also matches partial format without (xfr#) when rsync is still building the file list.
// Returns true if the line was a progress2 line.
function parseProgress2Line(line, progress) {
  const m = line.match(/^\s*([\d,]+)\s+(\d+)%\s+([\d.]+\w+\/s)\s+(\S+)/);
  if (!m) return false;

  progress.bytesTransferred = parseInt(m[1].replace(/,/g, ''));
  progress.speed = m[3];
  progress.eta = m[4] === '0:00:00' ? null : m[4];

  const pct = parseInt(m[2]);
  // Never decrease — file list may still be growing
  if (progress.percent == null || pct > progress.percent) {
    progress.percent = pct;
  }

  // Also extract xfr#/to-chk if present
  const xfr = line.match(/\(xfr#(\d+),\s*(?:to-chk|ir-chk)=(\d+)\/(\d+)\)/);
  if (xfr) {
    progress.filesCopied = parseInt(xfr[1]);
    const remaining = parseInt(xfr[2]);
    const total = parseInt(xfr[3]);
    progress.filesTotal = total;
    progress.filesRemaining = remaining;
  }

  return true;
}
// The local rsync binary may be openrsync (macOS) — use spawnRsync for line buffering.
export function runRsyncWithSsh(args, onProgress = null) {
  return new Promise((resolve, reject) => {
    const proc = spawnRsync(args);
    activeProcesses.add(proc);

    let stdout = '';
    let stderr = '';
    const progress = {
      filesTotal: 0, filesCopied: 0, filesFailed: 0, bytesTransferred: 0,
      currentFile: null, speed: null, percent: null, filesRemaining: null, eta: null,
    };

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;

      const lines = text.split(/[\r\n]+/).map(cleanLine).filter(l => l);
      for (const line of lines) {
        const match = line.match(/^([<>.ch*][fdLDS][cstpoguax.+?]{7,9})\s+(\d+)\s+(.+)$/);
        if (match) {
          const size = parseInt(match[2]) || 0;
          const action = parseItemizeAction(match[1]);
          progress.filesTotal++;
          progress.currentFile = match[3];
          if (action === 'transferred' || action === 'created') {
            progress.filesCopied++;
            progress.bytesTransferred += size;
          }
          if (onProgress) onProgress(progress);
          continue;
        }

        // Parse progress output: --info=progress2 (GNU/Linux) or --progress (openrsync/macOS)
        // Only try progress2 on Linux — on macOS --progress emits per-file bytes
        // that look like progress2 output but would overwrite the accumulated total.
        if ((!IS_MAC && parseProgress2Line(line, progress)) || parseProgressLine(line, progress)) {
          if (onProgress) onProgress(progress);
          continue;
        }

        // Handle *deleting lines (no size field)
        if (line.startsWith('*deleting')) {
          progress.filesTotal++;
          if (onProgress) onProgress(progress);
        }
      }
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (exitCode) => {
      activeProcesses.delete(proc);
      resolve({ exitCode, stdout, stderr, progress });
    });

    proc.on('error', (err) => {
      activeProcesses.delete(proc);
      reject(new Error(`Failed to start rsync: ${err.message}`));
    });
  });
}

// Kill all active rsync child processes (for graceful shutdown)
export function killActiveRsyncProcesses() {
  for (const proc of activeProcesses) {
    try { proc.kill('SIGTERM'); } catch {}
  }
  activeProcesses.clear();
}

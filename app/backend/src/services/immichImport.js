// Immich import service — spawns immich-go to upload photos from drives
// Parses output for progress tracking, handles delete-after and eject-after

import { spawn, execFileSync } from 'child_process';
import { open as openFile, readdir, rmdir, stat, readFile } from 'fs/promises';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import db from '../db.js';
import {
  notifyImportStarted, notifyImportCompleted, notifyImportError,
  createJobNotificationTracker, sendNotification,
} from './notify.js';
import {
  buildMediaImportLedger,
  classifyImmichLogOutcome,
  deleteVerifiedMediaSources,
  persistMediaImportLedger,
} from './mediaImportLedger.js';
import { resolveExistingPathWithinPrefix } from './pathConfinement.js';
import { buildImmichUploadInvocation } from './immichCommand.js';
import { resolveImportSourcePaths, supportsDriveSideEffects, assertSourceReadable } from './mediaImportSources.js';
import { terminateChildProcesses } from './childProcessShutdown.js';
import { resolveMediaImportStatus } from './runStatus.js';
import { createImmichRetryDirectory, removeImmichRetryDirectory } from './immichRetry.js';
import { summarizeImmichGoFailure } from './immichFailureSummary.js';

// Active imports tracked for progress polling
const activeImports = new Map();
const activeImportProcesses = new Map(); // runId -> ChildProcess

// Only the tail of immich-go's stderr is ever diagnosed, so the buffer is
// bounded to keep a failing import from growing the backend heap.
const MAX_STDERR_BUFFER_BYTES = 64 * 1024;

export function getActiveImport(runId) {
  return activeImports.get(runId);
}

export function cancelImport(runId) {
  const proc = activeImportProcesses.get(runId);
  if (proc) {
    proc.kill('SIGTERM');
    return true;
  }
  return false;
}

export async function stopActiveImportProcesses(timeoutMs = 10000) {
  return terminateChildProcesses(activeImportProcesses.values(), timeoutMs);
}

/**
 * Test Immich connectivity using immich-go or direct API call.
 */
export async function testImmichConnection() {
  const serverUrl = getSetting('immich_server_url');
  const apiKey = getSetting('immich_api_key');

  if (!serverUrl || !apiKey) {
    return { ok: false, error: 'Immich server URL and API key must be configured in Settings' };
  }

  try {
    const res = await fetch(`${serverUrl}/api/users/me`, {
      headers: { 'x-api-key': apiKey },
      signal: AbortSignal.timeout(10000),
    });

    if (res.status === 200) {
      const user = await res.json();
      return { ok: true, user: user.name || user.email, serverUrl };
    }
    if (res.status === 401) {
      return { ok: false, error: 'Invalid API key' };
    }
    return { ok: false, error: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: `Cannot reach Immich: ${err.message}` };
  }
}

/**
 * Check if immich-go binary is available.
 */
export function isImmichGoAvailable() {
  try {
    execFileSync('immich-go', ['--version'], { encoding: 'utf-8', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Start importing photos from a drive into Immich.
 */
export async function startImport(driveId) {
  const drive = db.prepare('SELECT * FROM media_drives WHERE id = ?').get(driveId);
  if (!drive) throw new Error(`Drive ${driveId} not found`);

  // The stored path was proven safe when it was declared; a folder can be
  // swapped for a symlink since, so it is proven again before anything reads it.
  assertSourceReadable(drive);

  const serverUrl = getSetting('immich_server_url');
  const apiKey = getSetting('immich_api_key');

  if (!serverUrl || !apiKey) {
    throw new Error('Immich server URL and API key must be configured in Settings');
  }

  // Check for existing active import on this drive (only block on running imports)
  for (const [runId, imp] of activeImports) {
    if (imp.driveId === driveId) {
      if (imp.status === 'running') {
        throw new Error('Import already running on this drive');
      }
      // Clear stale completed/failed imports
      activeImports.delete(runId);
    }
  }

  // Create run record
  const run = db.prepare(`
    INSERT INTO backup_runs (feature, config_id, status) VALUES ('media-import', ?, 'running')
  `).run(driveId);
  const runId = Number(run.lastInsertRowid);

  const startTime = Date.now();
  const progress = {
    driveId,
    runId,
    status: 'running',
    assetsFound: 0,
    uploaded: 0,
    duplicates: 0,
    errors: 0,
    currentFile: null,
    percent: 0,
    startedAt: startTime,
  };
  activeImports.set(runId, progress);
  const notifications = createJobNotificationTracker({
    feature: 'Media Import', name: drive.name || drive.label, runId, startedAt: startTime,
  });

  // Run import async
  notifications.start(() => notifyImportStarted(drive.name || drive.label));
  runImport(drive, runId, serverUrl, apiKey, startTime, progress, notifications).catch(err => {
    console.error(`[immich-import] Import failed for drive ${driveId}:`, err.message);
  });

  return { runId, status: 'running' };
}

async function runImport(drive, runId, serverUrl, apiKey, startTime, progress, notifications) {
  try {
    const importLogDir = join(dirname(db.name), 'import-logs');
    mkdirSync(importLogDir, { recursive: true });
    const primaryLogPath = join(importLogDir, `run-${runId}.log`);
    const retryLogPath = join(importLogDir, `run-${runId}-retry.log`);
    const logPaths = [primaryLogPath];
    const primaryInvocation = buildImmichUploadInvocation({
      serverUrl,
      apiKey,
      logPath: primaryLogPath,
      sourcePaths: resolveImportSourcePaths(drive),
      mode: drive.import_mode || 'folder',
    });

    const result = await spawnImmichGo(primaryInvocation.args, runId, progress, primaryInvocation.env, update => {
      notifications.progress({ ...update, filesCopied: update.uploaded });
    });

    // Retry failed files once — parse log for failed paths, symlink them into a temp dir
    const statusAfterInitialRun = db.prepare('SELECT status FROM backup_runs WHERE id = ?').get(runId)?.status;
    if (resolveMediaImportStatus(statusAfterInitialRun, result.exitCode, progress) !== 'cancelled'
      && result.exitCode !== 0 && progress.errors > 0 && progress.uploaded > 0
      // A failure inside a takeout archive has no file on disk to link to.
      && (drive.import_mode || 'folder') === 'folder') {
      const failedPaths = getFailedPathsFromLog(primaryLogPath, drive.mount_path);
      if (failedPaths.length > 0 && failedPaths.length <= 50) {
        console.log(`[immich-import] Retrying ${failedPaths.length} failed file(s)...`);
        let retryDir = null;
        try {
          retryDir = await createImmichRetryDirectory(runId);
          for (const fp of failedPaths) {
            if (existsSync(fp)) {
              const linkName = join(retryDir, fp.replace(/\//g, '_'));
              symlinkSync(fp, linkName);
            }
          }

          const retryInvocation = buildImmichUploadInvocation({
            serverUrl,
            apiKey,
            logPath: retryLogPath,
            sourcePath: retryDir,
          });
          const retryProgress = { errors: 0, uploaded: 0, assetsFound: 0, duplicates: 0, percent: 0 };
          logPaths.push(retryLogPath);
          const retryResult = await spawnImmichGo(retryInvocation.args, runId, retryProgress, retryInvocation.env, update => {
            notifications.progress({ ...progress, uploaded: progress.uploaded + update.uploaded, filesCopied: progress.uploaded + update.uploaded });
          });
          const recovered = retryProgress.uploaded || 0;
          if (recovered > 0) {
            progress.uploaded += recovered;
            progress.errors = Math.max(0, progress.errors - recovered);
            console.log(`[immich-import] Retry recovered ${recovered} file(s)`);
          }
          if (retryResult.exitCode === 0) {
            result.exitCode = 0;
            result.errorOutput = null;
          }
        } catch (retryErr) {
          console.warn(`[immich-import] Retry failed:`, retryErr.message);
        } finally {
          await removeImmichRetryDirectory(retryDir);
        }
      }
    }

    const duration = (Date.now() - startTime) / 1000;

    const persistedStatus = db.prepare('SELECT status FROM backup_runs WHERE id = ?').get(runId)?.status;
    const status = resolveMediaImportStatus(persistedStatus, result.exitCode, progress);

    const failureSummary = status === 'failed' ? summarizeImmichGoFailure(result.errorOutput) : null;

    db.prepare(`
      UPDATE backup_runs SET
        status = ?, completed_at = datetime('now'),
        files_total = ?, files_copied = ?, files_failed = ?,
        bytes_transferred = 0, duration_seconds = ?, error_message = ?
      WHERE id = ?
    `).run(
      status, progress.assetsFound, progress.uploaded,
      progress.errors, duration,
      status === 'cancelled' ? 'Cancelled by user' : failureSummary,
      runId
    );

    const ledgerEntries = await buildMediaImportLedger(logPaths, drive.mount_path);
    persistMediaImportLedger(db, runId, ledgerEntries);

    // Update drive last_import_at
    if (status === 'completed' || status === 'partial') {
      db.prepare(`
        UPDATE media_drives SET last_import_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ?
      `).run(drive.id);

      // Update detected camera if scan found one
      if (drive.detected_camera) {
        db.prepare(`
          UPDATE media_drives SET detected_camera = ? WHERE id = ? AND detected_camera IS NULL
        `).run(drive.detected_camera, drive.id);
      }
    }

    // Send notification
    if (status === 'completed' || status === 'partial') {
      notifyImportCompleted(drive.name || drive.label, {
        uploaded: progress.uploaded, duplicates: progress.duplicates,
        errors: progress.errors, duration,
      });
    } else if (status === 'failed') {
      notifyImportError(drive.name || drive.label, failureSummary);
    }

    if ((status === 'completed' || status === 'partial') && drive.delete_after_import
      && supportsDriveSideEffects(drive)) {
      const deletion = await deleteVerifiedMediaSources(db, runId, drive.mount_path);
      await sendNotification(
        `Deleted ${deletion.deleted} verified file(s); preserved ${deletion.preserved} changed or unsafe file(s)`,
        { title: 'Media Import — Verified cleanup', tags: 'wastebasket' },
      );
    }

    // Handle eject-after-import
    if ((status === 'completed' || status === 'partial') && drive.eject_after_import
      && supportsDriveSideEffects(drive)) {
      console.log(`[immich-import] Ejecting drive ${drive.mount_path}`);
      const ejected = ejectDrive(drive.mount_path);
      if (ejected.ok) {
        await sendNotification(`⏏️ Drive ejected: ${drive.name || drive.label}`, {
          title: 'Media Import — Drive ejected', tags: 'eject'
        });
      } else {
        console.warn(`[immich-import] Eject skipped:`, ejected.error);
      }
    }

    progress.status = status;
    return { runId, status };
  } catch (err) {
    const duration = (Date.now() - startTime) / 1000;
    const persistedStatus = db.prepare('SELECT status FROM backup_runs WHERE id = ?').get(runId)?.status;
    if (persistedStatus === 'cancelled') {
      progress.status = 'cancelled';
      return { runId, status: 'cancelled' };
    }
    db.prepare(`
      UPDATE backup_runs SET status = 'failed', completed_at = datetime('now'),
        error_message = ?, duration_seconds = ?
      WHERE id = ?
    `).run(err.message, duration, runId);

    await notifyImportError(drive.name || drive.label, err.message);
    progress.status = 'failed';
    throw err;
  } finally {
    notifications.close();
    // Keep completed progress available for 5 minutes; remove failures immediately
    if (progress.status === 'failed') {
      activeImports.delete(runId);
    } else {
      setTimeout(() => activeImports.delete(runId), 5 * 60 * 1000);
    }
  }
}

export function spawnImmichGo(args, runId, progress, envOverrides = {}, onProgress = null) {
  return new Promise((resolve, reject) => {
    const proc = spawn('immich-go', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...envOverrides },
    });
    activeImportProcesses.set(runId, proc);

    let errorOutput = '';

    proc.stdout.on('data', (data) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        // Parse immich-go progress output
        const uploadedMatch = line.match(/Uploaded\s+(\d+)/);
        if (uploadedMatch && !progress.trackLogOutcomes) progress.uploaded = parseInt(uploadedMatch[1]);

        const assetsMatch = line.match(/Assets found:\s*(\d+)/);
        if (assetsMatch) progress.assetsFound = parseInt(assetsMatch[1]);

        const errorsMatch = line.match(/Upload errors:\s*(\d+)/);
        if (errorsMatch && !progress.trackLogOutcomes) progress.errors = parseInt(errorsMatch[1]);

        const dupeMatch = line.match(/server has duplicate.*?:\s*(\d+)/);
        if (dupeMatch && !progress.trackLogOutcomes) progress.duplicates = parseInt(dupeMatch[1]);

        const percentMatch = line.match(/Immich read\s+(\d+)%/);
        if (percentMatch) progress.percent = parseInt(percentMatch[1]);
      }
      onProgress?.(progress);
    });

    proc.stderr.on('data', (data) => {
      // A looping or chatty immich-go failure must not grow the backend heap:
      // only the tail is ever useful, and the summariser copies this buffer.
      errorOutput = `${errorOutput}${data.toString()}`.slice(-MAX_STDERR_BUFFER_BYTES);
    });

    proc.on('close', (exitCode) => {
      activeImportProcesses.delete(runId);
      resolve({ exitCode, errorOutput: errorOutput.trim() || null });
    });

    proc.on('error', (err) => {
      activeImportProcesses.delete(runId);
      reject(new Error(`Failed to start immich-go: ${err.message}. Is it installed?`));
    });
  });
}

export function applyImmichLogProgress(line, progress) {
  const outcome = classifyImmichLogOutcome(line);
  if (outcome === 'uploaded') progress.uploaded = (progress.uploaded || 0) + 1;
  else if (outcome === 'duplicate') progress.duplicates = (progress.duplicates || 0) + 1;
  else if (outcome === 'error') progress.errors = (progress.errors || 0) + 1;
  else return false;
  progress.scanned = (progress.uploaded || 0) + (progress.duplicates || 0) + (progress.errors || 0);
  return true;
}

export function watchImmichLogProgress(logPath, progress, onProgress) {
  const MAX_BYTES_PER_TICK = 256 * 1024;
  const MAX_REMAINDER_BYTES = 64 * 1024;
  let offset = 0;
  let remainder = '';
  let reading = false;
  let stopped = false;
  let activeRead = Promise.resolve(false);
  const readChunk = async () => {
    if (!existsSync(logPath)) return false;
    let handle = null;
    try {
      const size = (await stat(logPath)).size;
      const bytesToRead = Math.min(MAX_BYTES_PER_TICK, Math.max(0, size - offset));
      if (bytesToRead === 0) return false;
      handle = await openFile(logPath, 'r');
      const buffer = Buffer.allocUnsafe(bytesToRead);
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, offset);
      offset += bytesRead;
      const lines = `${remainder}${buffer.toString('utf8', 0, bytesRead)}`.split('\n');
      remainder = (lines.pop() || '').slice(-MAX_REMAINDER_BYTES);
      let changed = false;
      for (const line of lines) changed = applyImmichLogProgress(line, progress) || changed;
      if (changed) onProgress?.(progress);
      return bytesRead > 0;
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn(`[immich-import] Progress log read failed: ${error.message}`);
      return false;
    } finally {
      await handle?.close();
    }
  };
  const listener = () => {
    if (stopped) return Promise.resolve(false);
    if (reading) return activeRead;
    reading = true;
    activeRead = readChunk().finally(() => {
      reading = false;
    });
    return activeRead;
  };
  const timer = setInterval(listener, 500);
  timer.unref?.();
  return async () => {
    clearInterval(timer);
    stopped = true;
    await activeRead;
    while (await readChunk()) { /* bounded chunks, draining a stable closed-child log */ }
  };
}

export async function uploadTakeoutArchive({ archivePath, runId, progress, logPath, onProgress }) {
  const serverUrl = getSetting('immich_server_url');
  const apiKey = getSetting('immich_api_key');
  if (!serverUrl || !apiKey) throw new Error('Immich server URL and API key must be configured in Settings');
  const invocation = buildImmichUploadInvocation({
    serverUrl,
    apiKey,
    logPath,
    sourcePath: archivePath,
    mode: 'google-photos',
  });
  progress.trackLogOutcomes = true;
  const stopWatching = watchImmichLogProgress(logPath, progress, onProgress);
  try {
    return await spawnImmichGo(invocation.args, runId, progress, invocation.env, onProgress);
  } finally {
    await stopWatching();
  }
}

/**
 * Eject a drive by unmounting it.
 */
export function isEjectSupported(helperPath = process.env.MEDIA_EJECT_HELPER) {
  if (!helperPath || !helperPath.startsWith('/')) return false;
  try {
    accessSync(helperPath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function ejectDrive(mountPath, helperPath = process.env.MEDIA_EJECT_HELPER) {
  if (!isEjectSupported(helperPath)) {
    return { ok: false, unsupported: true, error: 'Drive ejection is unavailable; configure an executable MEDIA_EJECT_HELPER host integration' };
  }
  try {
    execFileSync(helperPath, [mountPath], { encoding: 'utf-8', timeout: 30000 });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Extract confined absolute paths of failed files from this run's immich-go log.
 * Log lines: ERR server error file=DriveName:relative/path.TIF error=...
 */
function getFailedPathsFromLog(logPath, mountPath) {
  try {
    if (!existsSync(logPath)) return [];
    const content = readFileSync(logPath, 'utf-8');
    const failed = [];

    for (const line of content.split('\n')) {
      const match = line.match(/ERR\s+server error\s+file=(.+?)\s+error=/);
      if (match) {
        const fileRef = match[1].trim();
        // fileRef is "DriveName:relative/path.TIF" — extract relative path after colon
        const colonIdx = fileRef.indexOf(':');
        const relPath = colonIdx >= 0 ? fileRef.slice(colonIdx + 1) : fileRef;
        try {
          failed.push(resolveExistingPathWithinPrefix(join(mountPath, relPath), mountPath).path);
        } catch { /* ignore malformed or escaping log paths */ }
      }
    }

    return failed;
  } catch (err) {
    console.warn(`[immich-import] Failed to parse log for retry paths:`, err.message);
    return [];
  }
}

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row?.value || '';
}

// Immich import service — spawns immich-go to upload photos from drives
// Parses output for progress tracking, handles delete-after and eject-after

import { spawn, execSync } from 'child_process';
import { readdir, unlink, rmdir, stat } from 'fs/promises';
import { join, extname } from 'path';
import db from '../db.js';
import {
  notifyImportStarted, notifyImportCompleted, notifyImportError,
  sendNotification, notifyBackupResult,
} from './notify.js';

// Active imports tracked for progress polling
const activeImports = new Map();

const MEDIA_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.tif', '.webp', '.heic', '.heif',
  '.cr2', '.cr3', '.nef', '.arw', '.rw2', '.raf', '.orf', '.dng', '.pef', '.srw', '.x3f',
  '.mp4', '.mov', '.avi', '.mkv', '.m4v', '.3gp', '.mts', '.m2ts', '.wmv', '.flv', '.webm',
]);

export function getActiveImport(runId) {
  return activeImports.get(runId);
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
    execSync('immich-go --version 2>/dev/null', { encoding: 'utf-8', timeout: 5000 });
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

  const serverUrl = getSetting('immich_server_url');
  const apiKey = getSetting('immich_api_key');

  if (!serverUrl || !apiKey) {
    throw new Error('Immich server URL and API key must be configured in Settings');
  }

  // Check for existing active import on this drive
  for (const [, imp] of activeImports) {
    if (imp.driveId === driveId) {
      throw new Error('Import already running on this drive');
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

  // Run import async
  notifyImportStarted(drive.name || drive.label);
  runImport(drive, runId, serverUrl, apiKey, startTime, progress).catch(err => {
    console.error(`[immich-import] Import failed for drive ${driveId}:`, err.message);
  });

  return { runId, status: 'running' };
}

async function runImport(drive, runId, serverUrl, apiKey, startTime, progress) {
  try {
    const args = [
      'upload', 'from-folder',
      `--server=${serverUrl}`,
      `--api-key=${apiKey}`,
      '--no-ui',
      '--on-errors', 'continue',
      drive.mount_path,
    ];

    const result = await spawnImmichGo(args, runId, progress);

    const duration = (Date.now() - startTime) / 1000;
    const status = result.exitCode === 0 ? 'completed' : 'failed';

    db.prepare(`
      UPDATE backup_runs SET
        status = ?, completed_at = datetime('now'),
        files_total = ?, files_copied = ?, files_failed = ?,
        bytes_transferred = 0, duration_seconds = ?, error_message = ?
      WHERE id = ?
    `).run(
      status, progress.assetsFound, progress.uploaded,
      progress.errors, duration, result.errorOutput || null, runId
    );

    // Update drive last_import_at
    if (status === 'completed') {
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
    if (status === 'completed') {
      notifyImportCompleted(drive.name || drive.label, {
        uploaded: progress.uploaded, duplicates: progress.duplicates,
        errors: progress.errors, duration,
      });
    } else {
      notifyImportError(drive.name || drive.label, result.errorOutput);
    }

    // Handle delete-after-import
    if (status === 'completed' && drive.delete_after_import && progress.uploaded > 0) {
      console.log(`[immich-import] Deleting imported files from ${drive.mount_path}`);
      await deleteMediaFiles(drive.mount_path);
      await sendNotification(`🗑️ Cleaned ${progress.uploaded} files from ${drive.name || drive.label}`, {
        title: 'Media Import — Files deleted', tags: 'wastebasket'
      });
    }

    // Handle eject-after-import
    if (drive.eject_after_import) {
      console.log(`[immich-import] Ejecting drive ${drive.mount_path}`);
      try {
        execSync(`umount "${drive.mount_path}" 2>/dev/null`, { timeout: 30000 });
        await sendNotification(`⏏️ Drive ejected: ${drive.name || drive.label}`, {
          title: 'Media Import — Drive ejected', tags: 'eject'
        });
      } catch (err) {
        console.warn(`[immich-import] Eject failed:`, err.message);
      }
    }

    progress.status = status;
    return { runId, status };
  } catch (err) {
    const duration = (Date.now() - startTime) / 1000;
    db.prepare(`
      UPDATE backup_runs SET status = 'failed', completed_at = datetime('now'),
        error_message = ?, duration_seconds = ?
      WHERE id = ?
    `).run(err.message, duration, runId);

    await notifyImportError(drive.name || drive.label, err.message);
    progress.status = 'failed';
    throw err;
  } finally {
    // Keep progress available for 5 minutes after completion
    setTimeout(() => activeImports.delete(runId), 5 * 60 * 1000);
  }
}

function spawnImmichGo(args, runId, progress) {
  return new Promise((resolve, reject) => {
    const proc = spawn('immich-go', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let errorOutput = '';

    proc.stdout.on('data', (data) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        // Parse immich-go progress output
        const uploadedMatch = line.match(/Uploaded\s+(\d+)/);
        if (uploadedMatch) progress.uploaded = parseInt(uploadedMatch[1]);

        const assetsMatch = line.match(/Assets found:\s*(\d+)/);
        if (assetsMatch) progress.assetsFound = parseInt(assetsMatch[1]);

        const errorsMatch = line.match(/Upload errors:\s*(\d+)/);
        if (errorsMatch) progress.errors = parseInt(errorsMatch[1]);

        const dupeMatch = line.match(/server has duplicate.*?:\s*(\d+)/);
        if (dupeMatch) progress.duplicates = parseInt(dupeMatch[1]);

        const percentMatch = line.match(/Immich read\s+(\d+)%/);
        if (percentMatch) progress.percent = parseInt(percentMatch[1]);
      }
    });

    proc.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    proc.on('close', (exitCode) => {
      resolve({ exitCode, errorOutput: errorOutput.trim() || null });
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to start immich-go: ${err.message}. Is it installed?`));
    });
  });
}

/**
 * Delete media files from a drive after successful import.
 * Only removes known photo/video extensions, not other files.
 */
async function deleteMediaFiles(dirPath) {
  const stack = [dirPath];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch { continue; }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name === 'System Volume Information') continue;
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (MEDIA_EXTENSIONS.has(ext)) {
          try { await unlink(fullPath); } catch { /* skip errors */ }
        }
      }
    }
  }
}

/**
 * Eject a drive by unmounting it.
 */
export function ejectDrive(mountPath) {
  try {
    execSync(`umount "${mountPath}" 2>&1`, { encoding: 'utf-8', timeout: 30000 });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row?.value || '';
}

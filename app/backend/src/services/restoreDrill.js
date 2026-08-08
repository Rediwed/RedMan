// Restore drill — restores a whole snapshot folder into a scratch destination.
// A single file proves the mechanism; a folder is what proves the dataset is
// recoverable, which is the claim a backup actually makes.

import { statfs } from 'fs/promises';
import db from '../db.js';
import { browseSnapshot, materializeRestoredFile } from './versionBrowser.js';
import {
  prepareRestoreDestination,
  resolveAlternateRestoreRoot,
  normalizeSnapshotRelativePath,
  validateSnapshotTimestamp,
} from './snapshotPathPolicy.js';
import { storageConfig } from './storageConfig.js';
import { claimBackupRun } from './runClaim.js';
import { notifyJobCancelled, shouldNotify } from './notify.js';

const activeDrills = new Map();
const MAX_RECORDED_ERRORS = 100;

export function getActiveRestoreDrill(runId) {
  return activeDrills.get(Number(runId))?.progress || null;
}

async function enumerateSnapshotFiles(configId, timestamp, subPath, signal) {
  const files = [];
  const directories = [subPath];
  let totalBytes = 0;

  while (directories.length > 0) {
    signal?.throwIfAborted();
    const directory = directories.pop();
    for (const entry of await browseSnapshot(configId, timestamp, directory)) {
      const relativePath = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        directories.push(relativePath);
      } else {
        files.push(relativePath);
        totalBytes += entry.size || 0;
      }
    }
  }
  return { files, totalBytes };
}

/**
 * Free bytes at a destination, or null when the filesystem cannot say.
 * Unraid's shfs reports zeroes for user shares, and "unknown" must never be
 * read as "full" — that would block every drill on the platform RedMan targets.
 */
export function availableBytes(stats) {
  const blockSize = Number(stats?.bsize ?? 0);
  const blocks = Number(stats?.bavail ?? 0);
  if (!(blockSize > 0) || !(blocks > 0)) return null;
  return blocks * blockSize;
}

async function assertRoomFor(totalBytes, destinationRoot) {
  let available = null;
  try {
    available = availableBytes(await statfs(destinationRoot));
  } catch {
    available = null;
  }
  if (available !== null && totalBytes > available) {
    throw new Error(`Restore folder has ${Math.round(available / 1e6)} MB free but the snapshot needs ${Math.round(totalBytes / 1e6)} MB`);
  }
}

async function runDrill(configId, timestamp, subPath, destinationRoot, verify, state) {
  const { signal } = state.controller;
  const { files, totalBytes } = await enumerateSnapshotFiles(configId, timestamp, subPath, signal);
  await assertRoomFor(totalBytes, destinationRoot);

  state.progress = { ...state.progress, total: files.length, totalBytes };
  let restored = 0;
  let failed = 0;
  let bytes = 0;
  const errors = [];

  for (const relativePath of files) {
    signal?.throwIfAborted();
    try {
      const prepared = prepareRestoreDestination(destinationRoot, relativePath);
      const result = await materializeRestoredFile(configId, timestamp, prepared, { verify });
      restored++;
      bytes += result.bytes;
    } catch (err) {
      failed++;
      if (errors.length < MAX_RECORDED_ERRORS) errors.push({ filePath: relativePath, error: err.message });
    }
    state.progress = { ...state.progress, restored, failed, bytes, current: relativePath };
  }

  return { total: files.length, restored, failed, bytes, errors, errorsTruncated: failed > errors.length };
}

export function startRestoreDrill(configId, { timestamp, path = '', destinationRoot, verify = true } = {}) {
  const config = db.prepare('SELECT * FROM ssd_backup_configs WHERE id = ?').get(configId);
  if (!config) throw new Error('Config not found');

  validateSnapshotTimestamp(timestamp);
  const subPath = normalizeSnapshotRelativePath(path, { allowEmpty: true });
  const drillRoot = resolveAlternateRestoreRoot(destinationRoot, {
    snapshotRoot: config.dest_path,
    allowedRoots: [...storageConfig.roots, storageConfig.mediaRoot],
  });
  // A drill that writes over the live source is not a drill.
  if (drillRoot === config.source_path) {
    const error = new Error('Restore folder must differ from the backup source');
    error.status = 400;
    throw error;
  }

  const claim = claimBackupRun(db, 'restore-drill', configId);
  if (!claim.claimed) return { runId: claim.runId, status: 'running', existing: true };

  const controller = new AbortController();
  const state = {
    controller,
    progress: { status: 'running', total: 0, totalBytes: 0, restored: 0, failed: 0, bytes: 0, current: null },
    promise: null,
  };

  state.promise = runDrill(configId, timestamp, subPath, drillRoot, verify, state).then(result => {
    const status = result.failed > 0 ? 'partial' : 'completed';
    db.prepare(`
      UPDATE backup_runs SET status = ?, completed_at = datetime('now'),
        files_total = ?, files_copied = ?, files_failed = ?, bytes_transferred = ?, error_message = ?
      WHERE id = ?
    `).run(
      status,
      result.total,
      result.restored,
      result.failed,
      result.bytes,
      result.failed > 0 ? JSON.stringify(result.errors) : null,
      claim.runId,
    );
    // One audit row for the drill, not one per file: a folder can hold millions.
    db.prepare(`
      INSERT INTO restore_events (config_id, snapshot_timestamp, file_path, restored_to, status, verified_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      configId,
      timestamp,
      subPath || '.',
      drillRoot,
      result.failed > 0 ? 'failed' : (verify ? 'verified' : 'completed'),
      result.failed === 0 && verify ? new Date().toISOString() : null,
    );
    state.progress = { status, ...result };
  }).catch(err => {
    const cancelled = controller.signal.aborted || err.name === 'AbortError';
    const status = cancelled ? 'cancelled' : 'failed';
    db.prepare(`
      UPDATE backup_runs SET status = ?, completed_at = datetime('now'), error_message = ? WHERE id = ?
    `).run(status, cancelled ? 'Cancelled by user' : err.message, claim.runId);
    if (cancelled && shouldNotify(config, 'cancel')) notifyJobCancelled('Restore Drill', config.name);
    state.progress = { ...state.progress, status, error: err.message };
  }).finally(() => {
    setTimeout(() => activeDrills.delete(claim.runId), 5 * 60 * 1000).unref?.();
  });

  activeDrills.set(claim.runId, state);
  return { runId: claim.runId, status: 'running', existing: false, destinationRoot: drillRoot };
}

export function cancelRestoreDrill(runId) {
  const state = activeDrills.get(Number(runId));
  if (!state || state.progress.status !== 'running') return false;
  state.controller.abort();
  return true;
}

export async function stopActiveRestoreDrills() {
  const states = [...activeDrills.values()].filter(state => state.progress.status === 'running');
  for (const state of states) state.controller.abort();
  await Promise.allSettled(states.map(state => state.promise));
  activeDrills.clear();
  return { stopped: states.length, forced: 0 };
}

// Database backup service
// Copies the SQLite DB to backup destinations after each successful run.
// Also provides recovery: rebuilds configs from .versions/ filesystem manifests.

import { readdir, readFile, stat, mkdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import db from '../db.js';
import {
  createOnlineDatabaseBackup,
  stageDatabaseRestore,
} from './databaseFileSafety.js';

const DB_BACKUP_DIR = '_db_backups';
const MAX_DB_BACKUPS = 5;
const AUTOMATIC_DB_BACKUP_INTERVAL_MS = 24 * 60 * 60_000;

// ── Automatic DB Backup ──

/**
 * Copy the RedMan database to a backup destination.
 * Called after successful SSD backup runs, but automatically writes at most once per day.
 * Stores up to MAX_DB_BACKUPS rotated copies in dest_path/.versions/_db_backups/
 */
export async function backupDatabase(destPath, options = {}) {
  const force = options.force === true;
  const minimumIntervalMs = options.minimumIntervalMs ?? AUTOMATIC_DB_BACKUP_INTERVAL_MS;
  const now = options.now ?? Date.now();
  const signal = options.signal;
  signal?.throwIfAborted();
  if (!Number.isFinite(minimumIntervalMs) || minimumIntervalMs < 0 || minimumIntervalMs > AUTOMATIC_DB_BACKUP_INTERVAL_MS) {
    throw new Error(`Database backup interval must be between 0 and ${AUTOMATIC_DB_BACKUP_INTERVAL_MS} milliseconds`);
  }
  const dbPath = db.name; // better-sqlite3 exposes the DB file path
  if (!dbPath || !existsSync(dbPath)) {
    console.warn('[db-backup] Database file not found, skipping backup');
    return null;
  }

  const backupDir = join(destPath, '.versions', DB_BACKUP_DIR);
  await mkdir(backupDir, { recursive: true });

  signal?.throwIfAborted();
  const existingBackups = await listBackupFiles(backupDir);
  if (!force && existingBackups[0] && now - existingBackups[0].modifiedMs < minimumIntervalMs) {
    await rotateBackups(backupDir, MAX_DB_BACKUPS);
    console.log(`[db-backup] Skipping automatic backup; latest copy is ${Math.max(0, Math.round((now - existingBackups[0].modifiedMs) / 60_000))} minute(s) old`);
    return null;
  }

  // Leave room before writing so failed validation cannot grow the backup set indefinitely.
  signal?.throwIfAborted();
  await rotateBackups(backupDir, MAX_DB_BACKUPS - 1);

  // Create timestamped backup
  const timestamp = new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupName = `redman-${timestamp}.db`;
  const backupPath = join(backupDir, backupName);

  await createOnlineDatabaseBackup(db, backupPath, { signal });
  console.log(`[db-backup] Database backed up to ${backupPath}`);

  // Rotate: keep only the most recent MAX_DB_BACKUPS copies
  signal?.throwIfAborted();
  await rotateBackups(backupDir, MAX_DB_BACKUPS);

  return backupPath;
}

async function listBackupFiles(backupDir) {
  const files = await readdir(backupDir);
  const backups = [];
  for (const filename of files.filter(file => file.startsWith('redman-') && file.endsWith('.db'))) {
    const info = await stat(join(backupDir, filename));
    backups.push({ filename, modifiedMs: info.mtimeMs });
  }
  return backups.sort((left, right) => right.modifiedMs - left.modifiedMs);
}

async function rotateBackups(backupDir, keep = MAX_DB_BACKUPS) {
  try {
    const backups = await listBackupFiles(backupDir);
    for (const old of backups.slice(keep)) {
      const { unlink } = await import('fs/promises');
      await unlink(join(backupDir, old.filename));
      console.log(`[db-backup] Rotated old backup: ${old.filename}`);
    }
  } catch (err) {
    console.warn('[db-backup] Rotation cleanup error:', err.message);
  }
}

// ── Database Recovery from Filesystem ──

/**
 * Scan a backup destination's .versions/ directory and recover config metadata.
 * Returns a reconstructed config object (does NOT write to DB).
 */
export async function recoverConfigFromFilesystem(destPath) {
  const versionsDir = join(destPath, '.versions');
  if (!existsSync(versionsDir)) {
    return { error: 'No .versions directory found', destPath };
  }

  const entries = await readdir(versionsDir);
  const snapshots = entries
    .filter(e => /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/.test(e))
    .sort();

  if (snapshots.length === 0) {
    return { error: 'No version snapshots found', destPath };
  }

  // Analyze manifests to determine delta versioning settings
  let hasDelta = false;
  let totalFiles = 0;
  let totalDeltaFiles = 0;
  let totalFullFiles = 0;
  let maxChainLength = 0;
  const snapshotDetails = [];

  for (const ts of snapshots) {
    const manifestPath = join(versionsDir, ts, '_manifest.json');
    let manifest = null;
    try {
      const raw = await readFile(manifestPath, 'utf-8');
      manifest = JSON.parse(raw);
    } catch {
      // No manifest — plain versioning snapshot
    }

    const detail = { timestamp: ts, hasDelta: false, files: 0, deltaFiles: 0 };

    if (manifest?.files) {
      for (const [, meta] of Object.entries(manifest.files)) {
        totalFiles++;
        detail.files++;
        if (meta.type === 'delta') {
          hasDelta = true;
          totalDeltaFiles++;
          detail.deltaFiles++;
          detail.hasDelta = true;
        } else {
          totalFullFiles++;
        }
      }
    }

    snapshotDetails.push(detail);
  }

  // Calculate time span for retention estimation
  const oldest = snapshots[0];
  const newest = snapshots[snapshots.length - 1];
  const oldestDate = parseTimestamp(oldest);
  const newestDate = parseTimestamp(newest);
  const spanDays = oldestDate && newestDate
    ? Math.ceil((newestDate - oldestDate) / (1000 * 60 * 60 * 24))
    : 0;

  return {
    destPath,
    snapshotCount: snapshots.length,
    oldestSnapshot: oldest,
    newestSnapshot: newest,
    spanDays,
    deltaVersioning: hasDelta,
    totalFiles,
    totalDeltaFiles,
    totalFullFiles,
    snapshots: snapshotDetails,
  };
}

/**
 * Scan all known backup destinations (from existing configs or from provided paths)
 * and return recovery info for each.
 */
export async function scanForRecoverableConfigs(additionalPaths = []) {
  const results = [];

  // Check existing configs in DB
  try {
    const configs = db.prepare('SELECT id, name, source_path, dest_path FROM ssd_backup_configs').all();
    for (const config of configs) {
      const info = await recoverConfigFromFilesystem(config.dest_path);
      results.push({ ...info, existingConfig: config });
    }
  } catch {
    // DB might be broken — that's the whole point of recovery
  }

  // Check additional paths provided by user
  for (const destPath of additionalPaths) {
    const info = await recoverConfigFromFilesystem(destPath);
    results.push(info);
  }

  return results;
}

/**
 * Restore the database from a backup stored in a destination's .versions/_db_backups/.
 * Returns the path of the restored backup, or null if none found.
 */
export async function getAvailableDbBackups(destPath) {
  const backupDir = join(destPath, '.versions', DB_BACKUP_DIR);
  if (!existsSync(backupDir)) return [];

  const files = await readdir(backupDir);
  const backups = [];

  for (const f of files.filter(f => f.startsWith('redman-') && f.endsWith('.db'))) {
    const filePath = join(backupDir, f);
    const info = await stat(filePath);
    backups.push({
      filename: f,
      path: filePath,
      size: info.size,
      created: info.mtime.toISOString(),
    });
  }

  return backups.sort((a, b) => b.filename.localeCompare(a.filename)); // newest first
}

export async function restoreDbFromBackup(backupFilePath) {
  const dbPath = db.name;
  const pendingPath = await stageDatabaseRestore(backupFilePath, dbPath);

  return {
    staged: backupFilePath,
    pendingPath,
    message: 'Database restore verified and staged. Restart RedMan to install it safely.',
  };
}

function parseTimestamp(ts) {
  try {
    // Convert "2024-05-10T14-32-15" to a Date
    const iso = ts.replace(/T(\d{2})-(\d{2})-(\d{2})$/, 'T$1:$2:$3');
    return new Date(iso);
  } catch {
    return null;
  }
}

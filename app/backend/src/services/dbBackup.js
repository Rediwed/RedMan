// Database backup service
// Copies the SQLite DB to backup destinations after each successful run.
// Also provides recovery: rebuilds configs from .versions/ filesystem manifests.

import { copyFile, readdir, readFile, stat, mkdir } from 'fs/promises';
import { join, basename, dirname } from 'path';
import { existsSync } from 'fs';
import db from '../db.js';

const DB_BACKUP_DIR = '_db_backups';
const MAX_DB_BACKUPS = 5;

// ── Automatic DB Backup ──

/**
 * Copy the RedMan database to a backup destination.
 * Called after each successful SSD backup run.
 * Stores up to MAX_DB_BACKUPS rotated copies in dest_path/.versions/_db_backups/
 */
export async function backupDatabase(destPath) {
  const dbPath = db.name; // better-sqlite3 exposes the DB file path
  if (!dbPath || !existsSync(dbPath)) {
    console.warn('[db-backup] Database file not found, skipping backup');
    return null;
  }

  const backupDir = join(destPath, '.versions', DB_BACKUP_DIR);
  await mkdir(backupDir, { recursive: true });

  // Checkpoint WAL to ensure all data is in the main DB file
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch (err) {
    console.warn('[db-backup] WAL checkpoint failed, copying anyway:', err.message);
  }

  // Create timestamped backup
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupName = `redman-${timestamp}.db`;
  const backupPath = join(backupDir, backupName);

  await copyFile(dbPath, backupPath);
  console.log(`[db-backup] Database backed up to ${backupPath}`);

  // Rotate: keep only the most recent MAX_DB_BACKUPS copies
  await rotateBackups(backupDir);

  return backupPath;
}

async function rotateBackups(backupDir) {
  try {
    const files = await readdir(backupDir);
    const dbFiles = files
      .filter(f => f.startsWith('redman-') && f.endsWith('.db'))
      .sort()
      .reverse(); // newest first

    for (const old of dbFiles.slice(MAX_DB_BACKUPS)) {
      const { unlink } = await import('fs/promises');
      await unlink(join(backupDir, old));
      console.log(`[db-backup] Rotated old backup: ${old}`);
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
  if (!existsSync(backupFilePath)) {
    throw new Error(`Backup file not found: ${backupFilePath}`);
  }

  // Validate it's a real SQLite file
  const header = Buffer.alloc(16);
  const { open } = await import('fs/promises');
  const fh = await open(backupFilePath, 'r');
  await fh.read(header, 0, 16, 0);
  await fh.close();
  if (header.toString('utf-8', 0, 15) !== 'SQLite format 3') {
    throw new Error('Backup file is not a valid SQLite database');
  }

  // Close current DB, copy backup over, reopen
  // NOTE: This requires a process restart to take full effect
  const backupDir = dirname(dbPath);
  const safeCopy = join(backupDir, `redman-pre-restore-${Date.now()}.db`);

  // Save current (possibly broken) DB as safety net
  if (existsSync(dbPath)) {
    await copyFile(dbPath, safeCopy);
  }

  await copyFile(backupFilePath, dbPath);

  return {
    restored: backupFilePath,
    previousSavedAs: safeCopy,
    message: 'Database restored. Restart RedMan for changes to take effect.',
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

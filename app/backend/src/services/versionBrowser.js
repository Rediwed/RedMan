// Version browser service
// Scans .versions/<timestamp>/ directories under a backup destination
// and reconstructs file trees at any point in time.

import { readdir, stat, copyFile, mkdir } from 'fs/promises';
import { join, relative, dirname } from 'path';
import { existsSync } from 'fs';
import db from '../db.js';

/**
 * List all available snapshots (version timestamps) for a config.
 * Returns newest-first.
 */
export async function listSnapshots(configId) {
  const config = db.prepare('SELECT * FROM ssd_backup_configs WHERE id = ?').get(configId);
  if (!config) throw new Error('Config not found');

  const versionsDir = join(config.dest_path, '.versions');
  if (!existsSync(versionsDir)) return [];

  const entries = await readdir(versionsDir, { withFileTypes: true });
  const snapshots = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Timestamp format: YYYY-MM-DDTHH-MM-SS
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/.test(entry.name)) continue;

    const dirPath = join(versionsDir, entry.name);
    const info = await stat(dirPath);
    const fileCount = await countFiles(dirPath);

    snapshots.push({
      timestamp: entry.name,
      date: entry.name.replace(/T(\d{2})-(\d{2})-(\d{2})$/, 'T$1:$2:$3'),
      fileCount,
      sizeBytes: info.size,
      created: info.birthtime.toISOString(),
    });
  }

  // Sort newest first
  snapshots.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return snapshots;
}

/**
 * Browse the file tree at a specific snapshot timestamp.
 * Combines current destination state with version overlay.
 *
 * How versioning works:
 * - dest_path/ contains the CURRENT state of files
 * - .versions/<timestamp>/ contains files that were REPLACED or DELETED at that backup run
 *   (the old version before the change)
 *
 * To see the state AT a given snapshot time:
 * - Start with the current dest_path tree
 * - For each version NEWER than the requested timestamp, overlay those files
 *   (they represent what was replaced, i.e., the previous state)
 * - Exclude files from versions OLDER or equal to the requested timestamp
 *
 * @param {number} configId
 * @param {string} timestamp - The snapshot timestamp (YYYY-MM-DDTHH-MM-SS)
 * @param {string} subPath - Relative path within the backup to browse
 */
export async function browseSnapshot(configId, timestamp, subPath = '') {
  const config = db.prepare('SELECT * FROM ssd_backup_configs WHERE id = ?').get(configId);
  if (!config) throw new Error('Config not found');

  const destRoot = config.dest_path;
  const versionsDir = join(destRoot, '.versions');

  // Build a merged view: start with current dest, then overlay newer versions
  const browsePath = subPath ? join(destRoot, subPath) : destRoot;
  const entries = new Map(); // name -> entry info

  // 1. Read current destination directory
  if (existsSync(browsePath)) {
    const dirEntries = await readdir(browsePath, { withFileTypes: true });
    for (const entry of dirEntries) {
      if (entry.name === '.versions') continue; // Skip the versions dir itself
      const fullPath = join(browsePath, entry.name);
      const info = await stat(fullPath);
      entries.set(entry.name, {
        name: entry.name,
        isDirectory: entry.isDirectory(),
        size: info.size,
        modified: info.mtime.toISOString(),
        source: 'current',
      });
    }
  }

  // 2. Find all version timestamps newer than the requested one
  //    These versions contain the OLD files that were replaced — we need to overlay them
  if (existsSync(versionsDir)) {
    const allVersions = (await readdir(versionsDir, { withFileTypes: true }))
      .filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/.test(e.name))
      .map(e => e.name)
      .sort();

    // Versions NEWER than the requested timestamp have files that represent what was REPLACED
    const newerVersions = allVersions.filter(v => v > timestamp);

    for (const ver of newerVersions) {
      const verSubPath = subPath ? join(versionsDir, ver, subPath) : join(versionsDir, ver);
      if (!existsSync(verSubPath)) continue;

      const verEntries = await readdir(verSubPath, { withFileTypes: true });
      for (const entry of verEntries) {
        const fullPath = join(verSubPath, entry.name);
        const info = await stat(fullPath);
        // Overlay: the versioned file is what existed BEFORE this newer backup replaced it
        entries.set(entry.name, {
          name: entry.name,
          isDirectory: entry.isDirectory(),
          size: info.size,
          modified: info.mtime.toISOString(),
          source: 'version',
          versionTimestamp: ver,
        });
      }
    }

    // 3. Also check the requested version itself for files that only exist there
    //    (files that were deleted in a later backup and only preserved in this version)
    const versionPath = subPath ? join(versionsDir, timestamp, subPath) : join(versionsDir, timestamp);
    if (existsSync(versionPath)) {
      const verEntries = await readdir(versionPath, { withFileTypes: true });
      for (const entry of verEntries) {
        if (entries.has(entry.name)) continue; // Don't overwrite — current/newer version has this
        const fullPath = join(versionPath, entry.name);
        const info = await stat(fullPath);
        entries.set(entry.name, {
          name: entry.name,
          isDirectory: entry.isDirectory(),
          size: info.size,
          modified: info.mtime.toISOString(),
          source: 'version',
          versionTimestamp: timestamp,
        });
      }
    }
  }

  // Sort: directories first, then by name
  const result = [...entries.values()].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return result;
}

/**
 * Resolve the actual file path for a file at a given snapshot.
 * Checks version directories (newer than requested timestamp) first,
 * then falls back to the current destination.
 */
export async function resolveFilePath(configId, timestamp, filePath) {
  const config = db.prepare('SELECT * FROM ssd_backup_configs WHERE id = ?').get(configId);
  if (!config) throw new Error('Config not found');

  const destRoot = config.dest_path;
  const versionsDir = join(destRoot, '.versions');

  // Check newer versions first (they contain the old state that was valid at our timestamp)
  if (existsSync(versionsDir)) {
    const allVersions = (await readdir(versionsDir, { withFileTypes: true }))
      .filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/.test(e.name))
      .map(e => e.name)
      .sort()
      .reverse(); // Check newest first

    // Newer versions contain what was replaced → the state at our timestamp
    for (const ver of allVersions) {
      if (ver <= timestamp) break; // Only check versions newer than requested
      const candidate = join(versionsDir, ver, filePath);
      if (existsSync(candidate)) return candidate;
    }

    // Check the requested version itself
    const candidate = join(versionsDir, timestamp, filePath);
    if (existsSync(candidate)) return candidate;
  }

  // Fall back to current destination (file hasn't changed since this snapshot)
  const currentPath = join(destRoot, filePath);
  if (existsSync(currentPath)) return currentPath;

  throw new Error('File not found at the specified snapshot');
}

/**
 * Restore a file from a snapshot to the original source location.
 */
export async function restoreFile(configId, timestamp, filePath) {
  const config = db.prepare('SELECT * FROM ssd_backup_configs WHERE id = ?').get(configId);
  if (!config) throw new Error('Config not found');

  const resolvedPath = await resolveFilePath(configId, timestamp, filePath);
  const restoreDest = join(config.source_path, filePath);

  // Ensure parent directory exists
  await mkdir(dirname(restoreDest), { recursive: true });

  await copyFile(resolvedPath, restoreDest);

  return { restored: filePath, to: restoreDest };
}

/**
 * Count files recursively in a directory.
 */
async function countFiles(dirPath) {
  let count = 0;
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        count += await countFiles(join(dirPath, entry.name));
      } else {
        count++;
      }
    }
  } catch {
    // Directory may have been removed
  }
  return count;
}

// Version browser service
// Scans .versions/<timestamp>/ directories under a backup destination
// and reconstructs file trees at any point in time.
// Supports delta-compressed versions and GFS tiered retention pruning.

import { readdir, stat, copyFile, mkdir, rename, rm } from 'fs/promises';
import { join, relative, dirname } from 'path';
import { createReadStream, existsSync } from 'fs';
import { createHash, randomBytes } from 'crypto';
import db from '../db.js';
import { readManifest, reconstructFile, promoteDeltaToFull, cleanupTempFile, computeVersionStats, withConfigLock } from './deltaVersion.js';
import { applyVersionOverlay, getNewerVersions, parseVersionTimestamp } from './versionSelection.js';
import { getOrCreateSnapshotSummary, readSnapshotSummary } from './snapshotSummary.js';
import {
  normalizeSnapshotRelativePath,
  prepareRestoreDestination,
  resolveExistingSnapshotPath,
  resolveSnapshotRoot,
  validateSnapshotTimestamp,
} from './snapshotPathPolicy.js';

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
  let scannedLegacySnapshot = false;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Timestamp format: YYYY-MM-DDTHH-MM-SS
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/.test(entry.name)) continue;

    const dirPath = join(versionsDir, entry.name);
    const manifest = await readManifest(dirPath);
    let summary = await readSnapshotSummary(dirPath);
    if (!summary) {
      summary = await getOrCreateSnapshotSummary(dirPath, manifest, {
        scanLimit: scannedLegacySnapshot ? 1 : 5_000,
        timeBudgetMs: scannedLegacySnapshot ? 100 : 2_000,
        cacheIncomplete: true,
      });
      scannedLegacySnapshot = true;
    }

    // Determine retention tier for display
    const tier = getSnapshotTier(entry.name, config);

    snapshots.push({
      timestamp: entry.name,
      date: entry.name.replace(/T(\d{2})-(\d{2})-(\d{2})$/, 'T$1:$2:$3'),
      fileCount: summary.fileCount,
      sizeBytes: summary.diskSize,
      diskSize: summary.diskSize,
      originalSize: summary.originalSize,
      summaryIncomplete: summary.incomplete === true,
      tier,
      created: summary.created,
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
  validateSnapshotTimestamp(timestamp);
  const normalizedSubPath = normalizeSnapshotRelativePath(subPath, { allowEmpty: true });

  // Build a merged view: start with current dest, then overlay newer versions
  const browsePath = resolveExistingSnapshotPath(destRoot, normalizedSubPath, { allowEmpty: true });
  const entries = new Map(); // name -> entry info

  // 1. Read current destination directory
  if (browsePath) {
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
      .filter(e => e.isDirectory())
      .map(e => e.name);

    // Versions NEWER than the requested timestamp have files that represent what was REPLACED
    const newerVersions = getNewerVersions(allVersions, timestamp);

    for (const ver of newerVersions) {
      const versionRoot = resolveSnapshotRoot(versionsDir, ver);
      if (!versionRoot) continue;
      const verSubPath = resolveExistingSnapshotPath(versionRoot, normalizedSubPath, { allowEmpty: true });
      if (!verSubPath) continue;

      // Read manifest for this version to handle delta files
      const manifest = await readManifest(versionRoot);

      const verEntries = await readdir(verSubPath, { withFileTypes: true });
      for (const entry of verEntries) {
        if (entry.name === '_manifest.json' || entry.name === '_summary.json') continue;
        let displayName = entry.name;
        let isDelta = false;

        // If file ends in .rdelta, strip extension for display
        if (displayName.endsWith('.rdelta')) {
          displayName = displayName.slice(0, -7);
          isDelta = true;
        }

        const fullPath = join(verSubPath, entry.name);
        const info = await stat(fullPath);

        // Use original size from manifest for delta files
        let displaySize = info.size;
        if (isDelta && manifest) {
          const relPath = normalizedSubPath ? `${normalizedSubPath}/${displayName}` : displayName;
          const mEntry = manifest.files[relPath];
          if (mEntry) displaySize = mEntry.originalSize || info.size;
        }

        // The earliest newer version containing this path is its state at the requested snapshot.
        applyVersionOverlay(entries, displayName, {
          name: displayName,
          isDirectory: entry.isDirectory(),
          size: displaySize,
          modified: info.mtime.toISOString(),
          source: 'version',
          versionTimestamp: ver,
          isDelta,
        });
      }
    }

    // 3. Also check the requested version itself for files that only exist there
    //    (files that were deleted in a later backup and only preserved in this version)
    const requestedVersionRoot = resolveSnapshotRoot(versionsDir, timestamp);
    const versionPath = requestedVersionRoot
      ? resolveExistingSnapshotPath(requestedVersionRoot, normalizedSubPath, { allowEmpty: true })
      : null;
    if (versionPath) {
      const selfManifest = await readManifest(requestedVersionRoot);

      const verEntries = await readdir(versionPath, { withFileTypes: true });
      for (const entry of verEntries) {
        if (entry.name === '_manifest.json' || entry.name === '_summary.json') continue;
        let displayName = entry.name;
        let isDelta = false;

        if (displayName.endsWith('.rdelta')) {
          displayName = displayName.slice(0, -7);
          isDelta = true;
        }

        if (entries.has(displayName)) continue; // Don't overwrite — current/newer version has this
        const fullPath = join(versionPath, entry.name);
        const info = await stat(fullPath);

        let displaySize = info.size;
        if (isDelta && selfManifest) {
          const relPath = normalizedSubPath ? `${normalizedSubPath}/${displayName}` : displayName;
          const mEntry = selfManifest.files[relPath];
          if (mEntry) displaySize = mEntry.originalSize || info.size;
        }

        entries.set(displayName, {
          name: displayName,
          isDirectory: entry.isDirectory(),
          size: displaySize,
          modified: info.mtime.toISOString(),
          source: 'version',
          versionTimestamp: timestamp,
          isDelta,
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
 * If the file is a delta, reconstructs it and returns a temp path.
 * Returns { path, isTemp } — caller must clean up temp files.
 */
export async function resolveFilePath(configId, timestamp, filePath) {
  const config = db.prepare('SELECT * FROM ssd_backup_configs WHERE id = ?').get(configId);
  if (!config) throw new Error('Config not found');

  const destRoot = config.dest_path;
  const versionsDir = join(destRoot, '.versions');
  validateSnapshotTimestamp(timestamp);
  const normalizedFilePath = normalizeSnapshotRelativePath(filePath);

  // Check newer versions first (they contain the old state that was valid at our timestamp)
  if (existsSync(versionsDir)) {
    const allVersions = (await readdir(versionsDir, { withFileTypes: true }))
      .filter(e => e.isDirectory())
      .map(e => e.name);

    // The earliest newer version containing the path holds its state at this snapshot.
    for (const ver of getNewerVersions(allVersions, timestamp)) {
      const versionRoot = resolveSnapshotRoot(versionsDir, ver);
      if (!versionRoot) continue;

      // Check for delta file first (.rdelta)
      const deltaCandidate = resolveExistingSnapshotPath(versionRoot, normalizedFilePath, { suffix: '.rdelta' });
      if (deltaCandidate) {
        const result = await reconstructFile(destRoot, versionsDir, ver, normalizedFilePath);
        if (result) return result;
      }

      // Check for full file
      const candidate = resolveExistingSnapshotPath(versionRoot, normalizedFilePath);
      if (candidate) return { path: candidate, isTemp: false };
    }

    // Check the requested version itself
    const requestedVersionRoot = resolveSnapshotRoot(versionsDir, timestamp);
    const deltaCandidate = requestedVersionRoot
      ? resolveExistingSnapshotPath(requestedVersionRoot, normalizedFilePath, { suffix: '.rdelta' })
      : null;
    if (deltaCandidate) {
      const result = await reconstructFile(destRoot, versionsDir, timestamp, normalizedFilePath);
      if (result) return result;
    }

    const candidate = requestedVersionRoot
      ? resolveExistingSnapshotPath(requestedVersionRoot, normalizedFilePath)
      : null;
    if (candidate) return { path: candidate, isTemp: false };
  }

  // Fall back to current destination (file hasn't changed since this snapshot)
  const currentPath = resolveExistingSnapshotPath(destRoot, normalizedFilePath);
  if (currentPath) return { path: currentPath, isTemp: false };

  throw new Error('File not found at the specified snapshot');
}

/**
 * Restore a file from a snapshot to the original source location.
 * Handles delta-compressed files by reconstructing them first.
 */
function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export async function restoreFile(configId, timestamp, filePath, { verify = true } = {}) {
  const config = db.prepare('SELECT * FROM ssd_backup_configs WHERE id = ?').get(configId);
  if (!config) throw new Error('Config not found');

  validateSnapshotTimestamp(timestamp);
  const restore = prepareRestoreDestination(config.source_path, filePath);
  const restoreDest = restore.path;
  filePath = restore.relativePath;
  const event = db.prepare(`
    INSERT INTO restore_events (config_id, snapshot_timestamp, file_path, restored_to)
    VALUES (?, ?, ?, ?)
  `).run(configId, timestamp, filePath, restoreDest);
  const eventId = Number(event.lastInsertRowid);
  let resolved;
  const restoreTemporary = join(dirname(restoreDest), `.${randomBytes(8).toString('hex')}.${process.pid}.redman-restore`);

  try {
    resolved = await resolveFilePath(configId, timestamp, filePath);
    await copyFile(resolved.path, restoreTemporary);

    let verified = false;
    if (verify) {
      const [expectedHash, restoredHash] = await Promise.all([
        hashFile(resolved.path),
        hashFile(restoreTemporary),
      ]);
      if (expectedHash !== restoredHash) throw new Error('Restored file verification failed');
      verified = true;
    }
    await rename(restoreTemporary, restoreDest);

    db.prepare(`
      UPDATE restore_events SET status = ?, verified_at = ?, completed_at = datetime('now') WHERE id = ?
    `).run(verified ? 'verified' : 'completed', verified ? new Date().toISOString() : null, eventId);
    return { restored: filePath, to: restoreDest, verified, restoreEventId: eventId };
  } catch (err) {
    db.prepare(`
      UPDATE restore_events SET status = 'failed', error_message = ?, completed_at = datetime('now') WHERE id = ?
    `).run(err.message, eventId);
    throw err;
  } finally {
    await rm(restoreTemporary, { force: true }).catch(() => {});
    if (resolved?.isTemp) await cleanupTempFile(resolved.path);
  }
}

/**
 * Prune version snapshots using GFS (Grandfather-Father-Son) tiered retention.
 * Tiers: hourly (keep all), daily (1/day), weekly (1/week), monthly (1/month), quarterly (1/quarter).
 * Delta-aware: promotes dependent deltas to full before deleting their keyframes.
 * Falls back to simple retention_days if no retention_policy is set.
 */
export async function pruneVersions(configId, options = {}) {
  const signal = options.signal;
  signal?.throwIfAborted();
  return withConfigLock(configId, async () => {
    const config = db.prepare('SELECT * FROM ssd_backup_configs WHERE id = ?').get(configId);
    if (!config) throw new Error('Config not found');

    const policy = parseRetentionPolicy(config);
    if (!policy) return { pruned: 0, message: 'Retention policy disabled' };

    const versionsDir = join(config.dest_path, '.versions');
    if (!existsSync(versionsDir)) return { pruned: 0 };

    const entries = await readdir(versionsDir, { withFileTypes: true });
    const allTimestamps = entries
      .filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/.test(e.name))
      .map(e => e.name)
      .sort()
      .reverse(); // newest first

    if (allTimestamps.length === 0) return { pruned: 0 };

    const now = Date.now();
    const keep = new Set();
    const periodBuckets = new Map(); // "tier:period" → newest timestamp

    for (const ts of allTimestamps) {
      signal?.throwIfAborted();
      const date = parseVersionTimestamp(ts);
      const ageHours = (now - date.getTime()) / 3600_000;
      const ageDays = ageHours / 24;

      // Hourly tier: keep all within hourly window
      if (policy.hourly > 0 && ageHours <= policy.hourly) {
        keep.add(ts);
        continue;
      }

      // Daily tier: keep newest per calendar day
      if (policy.daily > 0 && ageDays <= policy.daily) {
        const dayKey = `daily:${ts.slice(0, 10)}`; // YYYY-MM-DD
        if (!periodBuckets.has(dayKey)) {
          periodBuckets.set(dayKey, ts);
          keep.add(ts);
        }
        continue;
      }

      // Weekly tier: keep newest per ISO week
      if (policy.weekly > 0 && ageDays <= policy.weekly) {
        const weekKey = `weekly:${getISOWeek(date)}`;
        if (!periodBuckets.has(weekKey)) {
          periodBuckets.set(weekKey, ts);
          keep.add(ts);
        }
        continue;
      }

      // Monthly tier: keep newest per calendar month
      if (policy.monthly > 0 && ageDays <= policy.monthly) {
        const monthKey = `monthly:${ts.slice(0, 7)}`; // YYYY-MM
        if (!periodBuckets.has(monthKey)) {
          periodBuckets.set(monthKey, ts);
          keep.add(ts);
        }
        continue;
      }

      // Quarterly tier: keep newest per quarter
      if (policy.quarterly > 0 && ageDays <= policy.quarterly) {
        const quarter = Math.floor(date.getMonth() / 3);
        const quarterKey = `quarterly:${date.getFullYear()}-Q${quarter}`;
        if (!periodBuckets.has(quarterKey)) {
          periodBuckets.set(quarterKey, ts);
          keep.add(ts);
        }
        continue;
      }

      // Beyond all tiers — will be pruned
    }

    // Delete snapshots not in the keep set
    let pruned = 0;
    const destRoot = config.dest_path;

    for (const ts of allTimestamps) {
      signal?.throwIfAborted();
      if (keep.has(ts)) continue;

      const dirPath = join(versionsDir, ts);

      // Delta-aware: refuse deletion unless every retained dependent is safe.
      await promoteDependent(destRoot, versionsDir, ts, allTimestamps, signal);

      await rm(dirPath, { recursive: true, force: true });
      pruned++;
      console.log(`[version-prune] Deleted snapshot: ${ts} (config ${config.name})`);
    }

    if (pruned > 0) {
      console.log(`[version-prune] Pruned ${pruned} snapshot(s) for "${config.name}"`);
    }

    // Update cached version stats
    if (options.updateStats !== false) {
      try {
        await computeVersionStats(configId, { signal });
      } catch (err) {
        if (signal?.aborted) throw err;
      }
    }

    return { pruned, kept: keep.size };
  }, { signal });
}

/**
 * Before deleting a snapshot, promote any delta files in newer kept snapshots
 * that reference this snapshot as their base to full copies.
 */
async function promoteDependent(destRoot, versionsDir, deletingTimestamp, allTimestamps, signal) {
  for (const dependentTimestamp of allTimestamps) {
    signal?.throwIfAborted();
    if (dependentTimestamp >= deletingTimestamp) continue; // Older snapshots can reference newer bases
    const dependentDir = join(versionsDir, dependentTimestamp);
    const manifest = await readManifest(dependentDir);
    if (!manifest) continue;

    for (const [filePath, entry] of Object.entries(manifest.files)) {
      signal?.throwIfAborted();
      if (entry.type === 'delta' && entry.base === deletingTimestamp) {
        await promoteDeltaToFull(destRoot, versionsDir, dependentTimestamp, filePath, { signal });
      }
    }
  }
}

/**
 * Parse retention policy from config. Supports both new JSON policy and legacy retention_days.
 */
function parseRetentionPolicy(config) {
  if (config.retention_policy) {
    try {
      const policy = JSON.parse(config.retention_policy);
      // Validate all values are non-negative numbers
      const keys = ['hourly', 'daily', 'weekly', 'monthly', 'quarterly'];
      const valid = keys.every(k => typeof policy[k] === 'number' && policy[k] >= 0);
      if (valid) return policy;
    } catch {}
  }

  // Fall back to legacy retention_days as simple daily cutoff
  if (config.retention_days && config.retention_days > 0) {
    return { hourly: 24, daily: config.retention_days, weekly: 0, monthly: 0, quarterly: 0 };
  }

  return null; // Disabled
}

const DEFAULT_RETENTION_POLICY = { hourly: 24, daily: 7, weekly: 30, monthly: 90, quarterly: 365 };
export { DEFAULT_RETENTION_POLICY };

/**
 * Determine which retention tier a snapshot falls into.
 */
function getSnapshotTier(timestamp, config) {
  const policy = parseRetentionPolicy(config);
  if (!policy) return null;

  const date = parseVersionTimestamp(timestamp);
  const ageHours = (Date.now() - date.getTime()) / 3600_000;
  const ageDays = ageHours / 24;

  if (policy.hourly > 0 && ageHours <= policy.hourly) return 'hourly';
  if (policy.daily > 0 && ageDays <= policy.daily) return 'daily';
  if (policy.weekly > 0 && ageDays <= policy.weekly) return 'weekly';
  if (policy.monthly > 0 && ageDays <= policy.monthly) return 'monthly';
  if (policy.quarterly > 0 && ageDays <= policy.quarterly) return 'quarterly';
  return 'expired';
}

/**
 * Get ISO week string for a date: "YYYY-W##"
 */
function getISOWeek(date) {
  const d = new Date(date.getTime());
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7);
  const week1 = new Date(d.getFullYear(), 0, 4);
  const weekNum = 1 + Math.round(((d.getTime() - week1.getTime()) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
  return `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

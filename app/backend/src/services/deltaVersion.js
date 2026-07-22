// Delta versioning service
// Uses rdiff (librsync) to compute binary deltas between file versions.
// Replaces full-copy storage with compact deltas where savings exceed threshold.
// Supports delta chain walking, reconstruction, rebasing, and integrity verification.

import { spawn } from 'child_process';
import { readFile, writeFile, readdir, opendir, stat, unlink, rename, mkdir, rm } from 'fs/promises';
import { join, dirname, relative } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import db from '../db.js';
import { parseVersionTimestamp } from './versionSelection.js';
import { getOrCreateSnapshotSummary, refreshSnapshotSummary } from './snapshotSummary.js';
import { getRuntimeResourceBudget } from './resourceBudget.js';
import {
  normalizeSnapshotRelativePath,
  resolveExistingSnapshotPath,
  resolveSnapshotRoot,
  validateSnapshotTimestamp,
} from './snapshotPathPolicy.js';

// ── Async config lock (Phase 8) ──
// Prevents concurrent write operations (deltaify, rebase, prune) on the same config.
const configLocks = new Map();

function waitForConfigLock(lock, signal) {
  if (!signal) return lock;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => {
      cleanup();
      reject(signal.reason instanceof Error ? signal.reason : new Error('Delta processing cancelled'));
    };
    signal.addEventListener('abort', abort, { once: true });
    lock.then(
      value => { cleanup(); resolve(value); },
      error => { cleanup(); reject(error); },
    );
  });
}

export async function withConfigLock(configId, fn, options = {}) {
  const signal = options.signal;
  while (configLocks.has(configId)) {
    await waitForConfigLock(configLocks.get(configId), signal);
  }
  signal?.throwIfAborted();
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  configLocks.set(configId, promise);
  try {
    return await fn();
  } finally {
    configLocks.delete(configId);
    resolve();
  }
}

// ── Temp file tracking (Phase 8) ──
const activeTempFiles = new Set();
const TEMP_PREFIX = 'redman-delta-';
const TEMP_DIRECTORY = join(tmpdir(), 'redman-delta');
const TEMP_CLEANUP_SCAN_LIMIT = 1_000;
const TEMP_CLEANUP_DELETE_LIMIT = 100;
const TEMP_MAX_AGE_MS = 3600_000;

function tempPath() {
  mkdirSync(TEMP_DIRECTORY, { recursive: true, mode: 0o700 });
  const name = `${TEMP_PREFIX}${randomBytes(8).toString('hex')}`;
  return join(TEMP_DIRECTORY, name);
}

export function registerTempFile(path) {
  activeTempFiles.add(path);
}

export async function cleanupTempFile(path) {
  activeTempFiles.delete(path);
  try { await unlink(path); } catch {}
}

let tempCleanupTimer = null;
let tempCleanupRunning = false;

export async function cleanupOrphanedTempFiles(options = {}) {
  const tempDirectory = options.tempDirectory || TEMP_DIRECTORY;
  const scanLimit = Number.parseInt(options.scanLimit ?? TEMP_CLEANUP_SCAN_LIMIT, 10);
  const deleteLimit = Number.parseInt(options.deleteLimit ?? TEMP_CLEANUP_DELETE_LIMIT, 10);
  const cutoff = Number.parseInt(options.cutoff ?? Date.now() - TEMP_MAX_AGE_MS, 10);
  if (!Number.isInteger(scanLimit) || scanLimit < 1 || scanLimit > TEMP_CLEANUP_SCAN_LIMIT) {
    throw new Error(`Temp cleanup scan limit must be between 1 and ${TEMP_CLEANUP_SCAN_LIMIT}`);
  }
  if (!Number.isInteger(deleteLimit) || deleteLimit < 1 || deleteLimit > TEMP_CLEANUP_DELETE_LIMIT) {
    throw new Error(`Temp cleanup delete limit must be between 1 and ${TEMP_CLEANUP_DELETE_LIMIT}`);
  }
  if (!Number.isFinite(cutoff)) throw new Error('Temp cleanup cutoff must be a timestamp');

  await mkdir(tempDirectory, { recursive: true, mode: 0o700 });
  const directory = await opendir(tempDirectory);
  let scanned = 0;
  let deleted = 0;
  for await (const entry of directory) {
    if (scanned >= scanLimit || deleted >= deleteLimit) break;
    scanned += 1;
    if (!entry.isFile() || !entry.name.startsWith(TEMP_PREFIX)) continue;
    const fullPath = join(tempDirectory, entry.name);
    if (activeTempFiles.has(fullPath)) continue;
    try {
      const info = await stat(fullPath);
      if (info.mtimeMs < cutoff) {
        await unlink(fullPath);
        deleted += 1;
      }
    } catch {}
  }
  return { scanned, deleted, complete: scanned < scanLimit && deleted < deleteLimit };
}

// Periodic cleanup of orphaned temp files (older than 1 hour)
export function startTempCleanup() {
  if (tempCleanupTimer) return tempCleanupTimer;
  tempCleanupTimer = setInterval(() => {
    if (tempCleanupRunning) return;
    tempCleanupRunning = true;
    cleanupOrphanedTempFiles()
      .catch(() => {})
      .finally(() => { tempCleanupRunning = false; });
  }, 30 * 60_000); // every 30 minutes
  tempCleanupTimer.unref();
  return tempCleanupTimer;
}

export function stopTempCleanup() {
  if (tempCleanupTimer) {
    clearInterval(tempCleanupTimer);
    tempCleanupTimer = null;
  }
  tempCleanupRunning = false;
}

// ── rdiff subprocess helpers ──

function spawnRdiff(args, signal) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const proc = spawn('rdiff', args, { stdio: ['pipe', 'pipe', 'pipe'], signal });
    const chunks = [];
    let stderr = '';
    proc.stdout.on('data', d => chunks.push(d));
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`rdiff exited ${code}: ${stderr.trim()}`));
    });
    proc.on('error', err => {
      if (signal?.aborted) reject(signal.reason instanceof Error ? signal.reason : new Error('Delta processing cancelled'));
      else reject(new Error(`rdiff not found: ${err.message}`));
    });
  });
}

async function rdiffSignature(filePath, signal) {
  return spawnRdiff(['signature', filePath], signal);
}

async function rdiffDelta(signatureBuffer, newFilePath, outputPath, signal) {
  // rdiff delta <signature> <newfile> <deltafile>
  // We pipe signature via temp file since rdiff needs file args
  const sigPath = tempPath() + '.sig';
  await writeFile(sigPath, signatureBuffer);
  try {
    await spawnRdiff(['delta', sigPath, newFilePath, outputPath], signal);
  } finally {
    try { await unlink(sigPath); } catch {}
  }
}

async function rdiffPatch(basisPath, deltaPath, outputPath, signal) {
  await spawnRdiff(['patch', basisPath, deltaPath, outputPath], signal);
}

// ── Manifest helpers ──

const MANIFEST_NAME = '_manifest.json';

export async function readManifest(versionDir) {
  const manifestPath = join(versionDir, MANIFEST_NAME);
  if (!existsSync(manifestPath)) return null;
  try {
    const raw = await readFile(manifestPath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeManifest(versionDir, manifest, options = {}) {
  const manifestPath = join(versionDir, MANIFEST_NAME);
  const temporaryPath = `${manifestPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    await rename(temporaryPath, manifestPath);
  } catch (err) {
    try { await unlink(temporaryPath); } catch {}
    throw err;
  }
  if (options.refreshSummary !== false) {
    await refreshSnapshotSummary(versionDir, manifest, options);
  }
}

// ── Walk files in a version dir ──
// Iterative (explicit stack) to avoid call-stack exhaustion on deeply nested
// trees, and to avoid `push(...bigArray)` which blows V8's argument limit
// (~65k) when a subtree returns a very large file list.

async function walkFiles(dir, base = '', signal) {
  const results = [];
  const stack = [{ dir, base }];
  while (stack.length > 0) {
    signal?.throwIfAborted();
    const { dir: cur, base: curBase } = stack.pop();
    let entries;
    try { entries = await readdir(cur, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      signal?.throwIfAborted();
      if (entry.name === MANIFEST_NAME) continue;
      const relPath = curBase ? `${curBase}/${entry.name}` : entry.name;
      const fullPath = join(cur, entry.name);
      if (entry.isDirectory()) {
        stack.push({ dir: fullPath, base: relPath });
      } else {
        const info = await stat(fullPath);
        results.push({ relPath, fullPath, size: info.size });
      }
    }
  }
  return results;
}

// ── Concurrency pool for parallel I/O ──
async function parallelMap(items, concurrency, fn, signal) {
  const results = [];
  let index = 0;
  async function worker() {
    while (index < items.length) {
      signal?.throwIfAborted();
      const i = index++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

// ── Core: deltaify a snapshot after rsync completes ──

export async function deltaifySnapshot(configId, timestamp, options = {}) {
  const signal = options.signal;
  signal?.throwIfAborted();
  const config = db.prepare('SELECT * FROM ssd_backup_configs WHERE id = ?').get(configId);
  if (!config || !config.delta_versioning) return;

  const destRoot = config.dest_path;
  const versionsDir = join(destRoot, '.versions');
  const versionDir = join(versionsDir, timestamp);

  if (!existsSync(versionDir)) return;

  const threshold = config.delta_threshold || 50; // minimum % savings
  const maxChain = config.delta_max_chain || 10;
  const keyframeDays = config.delta_keyframe_days || 7;

  const files = await walkFiles(versionDir, '', signal);
  if (files.length === 0) return;

  // Pre-load all version timestamps and manifests once (avoid repeated readdir + JSON parse per file)
  const allVersionsSorted = (await readdir(versionsDir, { withFileTypes: true }))
    .filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/.test(e.name))
    .map(e => e.name)
    .sort();
  const manifestCache = new Map();
  for (const ver of allVersionsSorted) {
    signal?.throwIfAborted();
    const m = await readManifest(join(versionsDir, ver));
    if (m) manifestCache.set(ver, m);
  }

  const newerVersions = allVersionsSorted.filter(v => v > timestamp);
  const olderOrEqualVersions = allVersionsSorted.filter(v => v <= timestamp);

  const manifest = { files: {} };
  const convertedFiles = [];

  // Process files in parallel with concurrency limit
  const deltaConcurrency = getRuntimeResourceBudget().deltaConcurrency;
  await parallelMap(files, deltaConcurrency, async (file) => {
    // Determine the base file (current copy in dest or a newer version)
    const basePath = findBaseFile(destRoot, file.relPath);
    if (!basePath) {
      manifest.files[file.relPath] = { type: 'full', originalSize: file.size };
      return;
    }

    // Check chain length using cached manifests
    let chainLen = 0;
    for (const ver of newerVersions) {
      const m = manifestCache.get(ver);
      if (!m) continue;
      const entry = m.files[file.relPath];
      if (entry && entry.type === 'delta') chainLen++;
    }
    if (chainLen >= maxChain) {
      manifest.files[file.relPath] = { type: 'full', originalSize: file.size, reason: 'keyframe-chain' };
      return;
    }

    // Check keyframe days using cached manifests
    let oldestKeyframe = null;
    for (const ver of olderOrEqualVersions) {
      const m = manifestCache.get(ver);
      if (!m) { oldestKeyframe = ver; break; }
      const entry = m.files[file.relPath];
      if (!entry || entry.type === 'full') { oldestKeyframe = ver; break; }
    }
    if (oldestKeyframe) {
      const keyframeDate = parseVersionTimestamp(oldestKeyframe);
      const daysSinceKeyframe = (Date.now() - keyframeDate.getTime()) / (86400_000);
      if (daysSinceKeyframe >= keyframeDays) {
        manifest.files[file.relPath] = { type: 'full', originalSize: file.size, reason: 'keyframe-age' };
        return;
      }
    }

    // Compute delta (rdiff subprocess — parallelized)
    const deltaPath = file.fullPath + '.rdelta';
    try {
      const signature = await rdiffSignature(basePath, signal);
      await rdiffDelta(signature, file.fullPath, deltaPath, signal);

      const deltaInfo = await stat(deltaPath);
      const savingsPercent = ((file.size - deltaInfo.size) / file.size) * 100;

      if (savingsPercent >= threshold) {
        manifest.files[file.relPath] = {
          type: 'delta',
          originalSize: file.size,
          deltaSize: deltaInfo.size,
          base: 'current',
        };
        convertedFiles.push(file.fullPath);
      } else {
        await unlink(deltaPath);
        manifest.files[file.relPath] = { type: 'full', originalSize: file.size, reason: 'below-threshold' };
      }
    } catch (err) {
      try { await unlink(deltaPath); } catch {}
      if (signal?.aborted) throw err;
      console.error(`[delta] Failed to compute delta for ${file.relPath}:`, err.message);
      manifest.files[file.relPath] = { type: 'full', originalSize: file.size, reason: 'error' };
    }
  }, signal);

  signal?.throwIfAborted();
  await writeManifest(versionDir, manifest, { signal, refreshSummary: false });

  // Once the manifest is atomically visible, full files may be removed. A
  // crash before this point leaves a full snapshot; a crash after it leaves
  // at worst a harmless duplicate full file beside the authoritative delta.
  for (const fullPath of convertedFiles) {
    try { await unlink(fullPath); } catch (err) {
      console.warn(`[delta] Could not remove converted full file ${fullPath}:`, err.message);
    }
  }
  await refreshSnapshotSummary(versionDir, manifest);
}

// ── Rebase: update existing delta base pointers when current files change ──

// Frozen v1 compatibility export; the abandoned implementation never changed data.
export async function rebaseDeltas() {
  return undefined;
}

export async function rebaseDeltasWithTimestamp(configId, changedFiles, newTimestamp, options = {}) {
  const signal = options.signal;
  signal?.throwIfAborted();
  const config = db.prepare('SELECT * FROM ssd_backup_configs WHERE id = ?').get(configId);
  if (!config || !config.delta_versioning) return;

  const versionsDir = join(config.dest_path, '.versions');
  if (!existsSync(versionsDir)) return;

  const allVersions = (await readdir(versionsDir, { withFileTypes: true }))
    .filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/.test(e.name))
    .map(e => e.name)
    .sort()
    .reverse();

  const changedSet = new Set(changedFiles);

  for (const ver of allVersions) {
    signal?.throwIfAborted();
    if (ver === newTimestamp) continue; // Skip the new snapshot itself
    const versionDir = join(versionsDir, ver);
    const manifest = await readManifest(versionDir);
    if (!manifest) continue;

    let dirty = false;
    for (const [filePath, entry] of Object.entries(manifest.files)) {
      signal?.throwIfAborted();
      if (entry.type === 'delta' && entry.base === 'current' && changedSet.has(filePath)) {
        // Point to the new version snapshot (which now holds the old "current" file)
        entry.base = newTimestamp;
        dirty = true;
      }
    }
    if (dirty) await writeManifest(versionDir, manifest, { signal });
    break; // Only the most recent can reference "current"
  }
}

// ── Reconstruct a file from a delta chain ──

export async function reconstructFile(destRoot, versionsDir, timestamp, filePath, options = {}) {
  const signal = options.signal;
  signal?.throwIfAborted();
  validateSnapshotTimestamp(timestamp);
  filePath = normalizeSnapshotRelativePath(filePath);
  const versionDir = resolveSnapshotRoot(versionsDir, timestamp);
  if (!versionDir) return null;

  // Check manifest
  const manifest = await readManifest(versionDir);

  // No manifest = old-style full copy snapshot
  if (!manifest) {
    const fullPath = resolveExistingSnapshotPath(versionDir, filePath);
    if (fullPath) return { path: fullPath, isTemp: false };
    return null;
  }

  const entry = manifest.files[filePath];

  // Not in manifest or full copy — return directly
  if (!entry || entry.type === 'full') {
    const fullPath = resolveExistingSnapshotPath(versionDir, filePath);
    if (fullPath) return { path: fullPath, isTemp: false };
    return null;
  }

  // Delta — walk the chain to find the base, then reconstruct
  const chain = []; // Array of { deltaPath, baseTimestamp }
  let current = { timestamp, entry };

  while (current.entry.type === 'delta') {
    const currentVersionRoot = resolveSnapshotRoot(versionsDir, current.timestamp);
    const deltaPath = currentVersionRoot
      ? resolveExistingSnapshotPath(currentVersionRoot, filePath, { suffix: '.rdelta' })
      : null;
    if (!deltaPath) {
      throw new Error(`Delta file missing for ${current.timestamp}/${filePath}`);
    }

    const baseRef = current.entry.base;
    chain.push({ deltaPath });

    if (baseRef === 'current') {
      // Base is the current file in dest
      break;
    }

    // Base is another version — follow the chain
    validateSnapshotTimestamp(baseRef);
    const baseDir = resolveSnapshotRoot(versionsDir, baseRef);
    if (!baseDir) throw new Error(`Base snapshot not found for delta chain at ${baseRef}`);
    const baseManifest = await readManifest(baseDir);
    if (!baseManifest) {
      // No manifest = full copy; base file is in that version dir
      break;
    }

    const baseEntry = baseManifest.files[filePath];
    if (!baseEntry || baseEntry.type === 'full') {
      // Base is a full copy in that version
      break;
    }

    current = { timestamp: baseRef, entry: baseEntry };
  }

  // Find the ultimate base file
  let basePath;
  const ultimateBase = current.entry.base;

  if (ultimateBase === 'current') {
    basePath = resolveExistingSnapshotPath(destRoot, filePath);
  } else {
    // Check if the base version has a full file
    validateSnapshotTimestamp(ultimateBase);
    const baseVersionRoot = resolveSnapshotRoot(versionsDir, ultimateBase);
    basePath = baseVersionRoot ? resolveExistingSnapshotPath(baseVersionRoot, filePath) : null;
    if (!basePath) {
      throw new Error(`Base file not found for delta chain at ${ultimateBase}/${filePath}`);
    }
  }

  if (!basePath) throw new Error(`Base file not found: ${filePath}`);

  // Apply patches in reverse order (from base → target)
  // chain is ordered: [newest delta, ..., oldest delta closest to base]
  // We need to apply from base outward, so reverse the chain
  let currentFile = basePath;
  let isCurrentTemp = false;

  for (let i = chain.length - 1; i >= 0; i--) {
    signal?.throwIfAborted();
    const output = tempPath();
    registerTempFile(output);
    try {
      await rdiffPatch(currentFile, chain[i].deltaPath, output, signal);
    } catch (err) {
      // Clean up temp files on error
      if (isCurrentTemp) await cleanupTempFile(currentFile);
      await cleanupTempFile(output);
      throw new Error(`Failed to reconstruct ${filePath} at step ${chain.length - i}: ${err.message}`);
    }
    if (isCurrentTemp) await cleanupTempFile(currentFile);
    currentFile = output;
    isCurrentTemp = true;
  }

  return { path: currentFile, isTemp: isCurrentTemp };
}

export async function getChainLength(destRoot, versionsDir, timestamp, filePath) {
  let length = 0;
  const versions = (await readdir(versionsDir, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/.test(entry.name))
    .map(entry => entry.name)
    .sort()
    .reverse();

  for (const version of versions) {
    if (version <= timestamp) continue;
    const manifest = await readManifest(join(versionsDir, version));
    if (manifest?.files[filePath]?.type === 'delta') length++;
  }
  return length;
}

// ── Find base file for a versioned file ──

function findBaseFile(destRoot, filePath) {
  // The base for the newest delta is the current file in dest
  const currentPath = join(destRoot, filePath);
  if (existsSync(currentPath)) return currentPath;
  return null;
}

// ── Integrity verification (Phase 5) ──

export async function verifyDeltaChain(configId, { signal, onProgress } = {}) {
  const config = db.prepare('SELECT * FROM ssd_backup_configs WHERE id = ?').get(configId);
  if (!config) throw new Error('Config not found');

  const destRoot = config.dest_path;
  const versionsDir = join(destRoot, '.versions');
  if (!existsSync(versionsDir)) return { verified: 0, broken: 0, errors: [] };

  const allVersions = (await readdir(versionsDir, { withFileTypes: true }))
    .filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/.test(e.name))
    .map(e => e.name)
    .sort();

  const manifests = [];
  let total = 0;
  for (const timestamp of allVersions) {
    if (signal?.aborted) throw new Error('Verification cancelled');
    const manifest = await readManifest(join(versionsDir, timestamp));
    if (!manifest) continue;
    manifests.push({ timestamp, manifest });
    total += Object.values(manifest.files).filter(entry => entry.type === 'delta').length;
  }

  let verified = 0;
  let broken = 0;
  const errors = [];
  onProgress?.({ total, verified, broken, current: null });

  for (const { timestamp: ver, manifest } of manifests) {
    for (const [filePath, entry] of Object.entries(manifest.files)) {
      if (entry.type !== 'delta') continue;
      if (signal?.aborted) throw new Error('Verification cancelled');

      let result;
      try {
        result = await reconstructFile(destRoot, versionsDir, ver, filePath, { signal });
        if (!result) throw new Error('Version could not be reconstructed');
        if (signal?.aborted) throw new Error('Verification cancelled');
        verified++;
      } catch (err) {
        if (signal?.aborted || err.message === 'Verification cancelled') throw err;
        broken++;
        if (errors.length < 100) errors.push({ timestamp: ver, filePath, error: err.message });
        console.error(`[delta-verify] Broken chain: ${ver}/${filePath}: ${err.message}`);
      } finally {
        if (result?.isTemp) await cleanupTempFile(result.path);
      }
      onProgress?.({ total, verified, broken, current: `${ver}/${filePath}` });
    }
  }

  return { total, verified, broken, errors, errorsTruncated: broken > errors.length };
}

// ── Promote delta to full copy (for prune safety) ──

export async function promoteDeltaToFull(destRoot, versionsDir, timestamp, filePath, options = {}) {
  const signal = options.signal;
  signal?.throwIfAborted();
  const versionDir = join(versionsDir, timestamp);
  const manifest = await readManifest(versionDir);
  if (!manifest) return;

  const entry = manifest.files[filePath];
  if (!entry || entry.type !== 'delta') return;

  // Reconstruct the file
  const result = await reconstructFile(destRoot, versionsDir, timestamp, filePath, { signal });
  if (!result) throw new Error(`Cannot reconstruct ${filePath} at ${timestamp}`);

  const deltaPath = join(versionDir, filePath + '.rdelta');
  const fullPath = join(versionDir, filePath);

  // Ensure parent directory exists
  await mkdir(dirname(fullPath), { recursive: true });

  // Copy reconstructed file to the full path
  const { copyFile: copyFileFn } = await import('fs/promises');
  await copyFileFn(result.path, fullPath);
  if (result.isTemp) await cleanupTempFile(result.path);

  // Publish the full-file metadata before deleting the delta. A crash leaves
  // either the old reconstructable delta or the new full copy authoritative.
  manifest.files[filePath] = { type: 'full', originalSize: entry.originalSize, reason: 'promoted' };
  await writeManifest(versionDir, manifest, { signal, refreshSummary: false });

  try { await unlink(deltaPath); } catch {}
  await refreshSnapshotSummary(versionDir, manifest, { signal });
}

// ── Compute version stats for cache (Phase 7) ──

export async function computeVersionStats(configId, options = {}) {
  const signal = options.signal;
  signal?.throwIfAborted();
  const config = db.prepare('SELECT * FROM ssd_backup_configs WHERE id = ?').get(configId);
  if (!config) return null;

  const versionsDir = join(config.dest_path, '.versions');
  if (!existsSync(versionsDir)) return { snapshotCount: 0, totalDiskSize: 0, totalOriginalSize: 0, spaceSaved: 0 };

  const allVersions = (await readdir(versionsDir, { withFileTypes: true }))
    .filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/.test(e.name))
    .map(e => e.name);

  let totalDiskSize = 0;
  let totalOriginalSize = 0;
  let incompleteSnapshots = 0;

  for (const ver of allVersions) {
    signal?.throwIfAborted();
    const versionDir = join(versionsDir, ver);
    const manifest = await readManifest(versionDir);
    const summary = await getOrCreateSnapshotSummary(versionDir, manifest, {
      signal,
      retryIncomplete: true,
      cacheIncomplete: true,
    });
    if (summary.incomplete) {
      incompleteSnapshots += 1;
      continue;
    }
    totalDiskSize += summary.diskSize;
    totalOriginalSize += summary.originalSize;
  }

  const stats = {
    snapshotCount: allVersions.length,
    totalDiskSize,
    totalOriginalSize,
    spaceSaved: totalOriginalSize - totalDiskSize,
    incompleteSnapshots,
  };

  // Cache in DB
  db.prepare(`INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, datetime('now'))`)
    .run(`version_stats:${configId}`, JSON.stringify(stats));

  return stats;
}

// ── Get cached version stats ──

export function getCachedVersionStats(configId) {
  const row = db.prepare('SELECT value FROM cache WHERE key = ?').get(`version_stats:${configId}`);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

export function getAllCachedVersionStats() {
  const rows = db.prepare("SELECT key, value FROM cache WHERE key LIKE 'version_stats:%'").all();
  let totalDiskSize = 0;
  let totalOriginalSize = 0;
  let snapshotCount = 0;
  let incompleteSnapshots = 0;

  for (const row of rows) {
    try {
      const stats = JSON.parse(row.value);
      totalDiskSize += stats.totalDiskSize || 0;
      totalOriginalSize += stats.totalOriginalSize || 0;
      snapshotCount += stats.snapshotCount || 0;
      incompleteSnapshots += stats.incompleteSnapshots || 0;
    } catch {}
  }

  return {
    snapshotCount,
    totalDiskSize,
    totalOriginalSize,
    spaceSaved: totalOriginalSize - totalDiskSize,
    incompleteSnapshots,
  };
}

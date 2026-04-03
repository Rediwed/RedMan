// Delta versioning service
// Uses rdiff (librsync) to compute binary deltas between file versions.
// Replaces full-copy storage with compact deltas where savings exceed threshold.
// Supports delta chain walking, reconstruction, rebasing, and integrity verification.

import { spawn } from 'child_process';
import { readFile, writeFile, readdir, stat, unlink, rename, mkdir, rm } from 'fs/promises';
import { join, dirname, relative } from 'path';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import db from '../db.js';

// ── Async config lock (Phase 8) ──
// Prevents concurrent write operations (deltaify, rebase, prune) on the same config.
const configLocks = new Map();

export async function withConfigLock(configId, fn) {
  while (configLocks.has(configId)) {
    await configLocks.get(configId);
  }
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

function tempPath() {
  const name = `${TEMP_PREFIX}${randomBytes(8).toString('hex')}`;
  return join(tmpdir(), name);
}

export function registerTempFile(path) {
  activeTempFiles.add(path);
}

export async function cleanupTempFile(path) {
  activeTempFiles.delete(path);
  try { await unlink(path); } catch {}
}

// Periodic cleanup of orphaned temp files (older than 1 hour)
export function startTempCleanup() {
  const interval = setInterval(async () => {
    try {
      const entries = await readdir(tmpdir());
      const cutoff = Date.now() - 3600_000;
      for (const entry of entries) {
        if (!entry.startsWith(TEMP_PREFIX)) continue;
        const fullPath = join(tmpdir(), entry);
        try {
          const info = await stat(fullPath);
          if (info.mtimeMs < cutoff) {
            await unlink(fullPath);
            activeTempFiles.delete(fullPath);
          }
        } catch {}
      }
    } catch {}
  }, 30 * 60_000); // every 30 minutes
  interval.unref();
  return interval;
}

// ── rdiff subprocess helpers ──

function spawnRdiff(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('rdiff', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    let stderr = '';
    proc.stdout.on('data', d => chunks.push(d));
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`rdiff exited ${code}: ${stderr.trim()}`));
    });
    proc.on('error', err => reject(new Error(`rdiff not found: ${err.message}`)));
  });
}

async function rdiffSignature(filePath) {
  return spawnRdiff(['signature', filePath]);
}

async function rdiffDelta(signatureBuffer, newFilePath, outputPath) {
  // rdiff delta <signature> <newfile> <deltafile>
  // We pipe signature via temp file since rdiff needs file args
  const sigPath = tempPath() + '.sig';
  await writeFile(sigPath, signatureBuffer);
  try {
    await spawnRdiff(['delta', sigPath, newFilePath, outputPath]);
  } finally {
    try { await unlink(sigPath); } catch {}
  }
}

async function rdiffPatch(basisPath, deltaPath, outputPath) {
  await spawnRdiff(['patch', basisPath, deltaPath, outputPath]);
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

async function writeManifest(versionDir, manifest) {
  await writeFile(join(versionDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2));
}

// ── Walk files recursively in a version dir ──

async function walkFiles(dir, base = '') {
  const results = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return results; }
  for (const entry of entries) {
    if (entry.name === MANIFEST_NAME) continue;
    const relPath = base ? `${base}/${entry.name}` : entry.name;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await walkFiles(fullPath, relPath));
    } else {
      const info = await stat(fullPath);
      results.push({ relPath, fullPath, size: info.size });
    }
  }
  return results;
}

// ── Concurrency pool for parallel I/O ──
const DELTA_CONCURRENCY = 50;

async function parallelMap(items, concurrency, fn) {
  const results = [];
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

// ── Core: deltaify a snapshot after rsync completes ──

export async function deltaifySnapshot(configId, timestamp) {
  const config = db.prepare('SELECT * FROM ssd_backup_configs WHERE id = ?').get(configId);
  if (!config || !config.delta_versioning) return;

  const destRoot = config.dest_path;
  const versionsDir = join(destRoot, '.versions');
  const versionDir = join(versionsDir, timestamp);

  if (!existsSync(versionDir)) return;

  const threshold = config.delta_threshold || 50; // minimum % savings
  const maxChain = config.delta_max_chain || 10;
  const keyframeDays = config.delta_keyframe_days || 7;

  const files = await walkFiles(versionDir);
  if (files.length === 0) return;

  // Pre-load all version timestamps and manifests once (avoid repeated readdir + JSON parse per file)
  const allVersionsSorted = (await readdir(versionsDir, { withFileTypes: true }))
    .filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/.test(e.name))
    .map(e => e.name)
    .sort();
  const manifestCache = new Map();
  for (const ver of allVersionsSorted) {
    const m = await readManifest(join(versionsDir, ver));
    if (m) manifestCache.set(ver, m);
  }

  const newerVersions = allVersionsSorted.filter(v => v > timestamp);
  const olderOrEqualVersions = allVersionsSorted.filter(v => v <= timestamp);

  const manifest = { files: {} };

  // Process files in parallel with concurrency limit
  await parallelMap(files, DELTA_CONCURRENCY, async (file) => {
    // Determine the base file (current copy in dest or a newer version)
    const basePath = findBaseFile(destRoot, versionsDir, timestamp, file.relPath);
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
      const keyframeDate = parseTimestamp(oldestKeyframe);
      const daysSinceKeyframe = (Date.now() - keyframeDate.getTime()) / (86400_000);
      if (daysSinceKeyframe >= keyframeDays) {
        manifest.files[file.relPath] = { type: 'full', originalSize: file.size, reason: 'keyframe-age' };
        return;
      }
    }

    // Compute delta (rdiff subprocess — parallelized)
    try {
      const signature = await rdiffSignature(basePath);
      const deltaPath = file.fullPath + '.rdelta';
      await rdiffDelta(signature, file.fullPath, deltaPath);

      const deltaInfo = await stat(deltaPath);
      const savingsPercent = ((file.size - deltaInfo.size) / file.size) * 100;

      if (savingsPercent >= threshold) {
        await unlink(file.fullPath);
        manifest.files[file.relPath] = {
          type: 'delta',
          originalSize: file.size,
          deltaSize: deltaInfo.size,
          base: 'current',
        };
      } else {
        await unlink(deltaPath);
        manifest.files[file.relPath] = { type: 'full', originalSize: file.size, reason: 'below-threshold' };
      }
    } catch (err) {
      console.error(`[delta] Failed to compute delta for ${file.relPath}:`, err.message);
      manifest.files[file.relPath] = { type: 'full', originalSize: file.size, reason: 'error' };
    }
  });

  await writeManifest(versionDir, manifest);
}

// ── Rebase: update existing delta base pointers when current files change ──

export async function rebaseDeltas(configId, changedFiles) {
  const config = db.prepare('SELECT * FROM ssd_backup_configs WHERE id = ?').get(configId);
  if (!config || !config.delta_versioning) return;

  const versionsDir = join(config.dest_path, '.versions');
  if (!existsSync(versionsDir)) return;

  // Find all version timestamps, newest first
  const allVersions = (await readdir(versionsDir, { withFileTypes: true }))
    .filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/.test(e.name))
    .map(e => e.name)
    .sort()
    .reverse();

  if (allVersions.length === 0) return;

  const changedSet = new Set(changedFiles);

  // For each version (newest first), check if any delta points to "current" for a changed file
  for (const ver of allVersions) {
    const versionDir = join(versionsDir, ver);
    const manifest = await readManifest(versionDir);
    if (!manifest) continue;

    let dirty = false;
    for (const [filePath, entry] of Object.entries(manifest.files)) {
      if (entry.type === 'delta' && entry.base === 'current' && changedSet.has(filePath)) {
        // The file this delta was based on just changed.
        // The old "current" is now in the newest version snapshot, so we don't need to
        // update the base pointer — the new snapshot will contain the old file, and
        // deltaifySnapshot will set its base to "current" (the newly updated file).
        // But wait: the existing delta's base was the OLD current, which is now gone.
        // The old file has been moved by rsync --backup to the new version dir.
        // So this delta's base should now point to the new version timestamp.
        // However, we don't know the new timestamp yet (it's being created now).
        // We'll set it to a placeholder and let the caller fix it.
        // Actually, the caller knows the new timestamp — we need it as a parameter.
        // For simplicity: the newest version dir IS the new snapshot. Look for it.
        // The caller should pass the new timestamp.
        // DESIGN: rebaseDeltas is called BEFORE deltaifySnapshot, with the new timestamp.
        // We handle this by having the caller pass newTimestamp.
        break; // We'll handle this in the overload below
      }
    }
    if (dirty) await writeManifest(versionDir, manifest);

    // Only the most recent version can have base: "current" for a given file
    // (newer versions would have already been rebased), so break after first match
    break;
  }
}

// Overload: rebase with explicit new timestamp
export async function rebaseDeltasWithTimestamp(configId, changedFiles, newTimestamp) {
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
    if (ver === newTimestamp) continue; // Skip the new snapshot itself
    const versionDir = join(versionsDir, ver);
    const manifest = await readManifest(versionDir);
    if (!manifest) continue;

    let dirty = false;
    for (const [filePath, entry] of Object.entries(manifest.files)) {
      if (entry.type === 'delta' && entry.base === 'current' && changedSet.has(filePath)) {
        // Point to the new version snapshot (which now holds the old "current" file)
        entry.base = newTimestamp;
        dirty = true;
      }
    }
    if (dirty) await writeManifest(versionDir, manifest);
    break; // Only the most recent can reference "current"
  }
}

// ── Reconstruct a file from a delta chain ──

export async function reconstructFile(destRoot, versionsDir, timestamp, filePath) {
  const versionDir = join(versionsDir, timestamp);

  // Check manifest
  const manifest = await readManifest(versionDir);

  // No manifest = old-style full copy snapshot
  if (!manifest) {
    const fullPath = join(versionDir, filePath);
    if (existsSync(fullPath)) return { path: fullPath, isTemp: false };
    return null;
  }

  const entry = manifest.files[filePath];

  // Not in manifest or full copy — return directly
  if (!entry || entry.type === 'full') {
    const fullPath = join(versionDir, filePath);
    if (existsSync(fullPath)) return { path: fullPath, isTemp: false };
    return null;
  }

  // Delta — walk the chain to find the base, then reconstruct
  const chain = []; // Array of { deltaPath, baseTimestamp }
  let current = { timestamp, entry };

  while (current.entry.type === 'delta') {
    const deltaPath = join(versionsDir, current.timestamp, filePath + '.rdelta');
    if (!existsSync(deltaPath)) {
      throw new Error(`Delta file missing: ${deltaPath}`);
    }

    const baseRef = current.entry.base;
    chain.push({ deltaPath });

    if (baseRef === 'current') {
      // Base is the current file in dest
      break;
    }

    // Base is another version — follow the chain
    const baseDir = join(versionsDir, baseRef);
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
  const lastBase = chain.length > 0 ? chain[chain.length - 1] : null;
  const ultimateBase = current.entry.base;

  if (ultimateBase === 'current') {
    basePath = join(destRoot, filePath);
  } else {
    // Check if the base version has a full file
    basePath = join(versionsDir, ultimateBase, filePath);
    if (!existsSync(basePath)) {
      throw new Error(`Base file not found for delta chain at ${ultimateBase}/${filePath}`);
    }
  }

  if (!existsSync(basePath)) {
    throw new Error(`Base file not found: ${basePath}`);
  }

  // Apply patches in reverse order (from base → target)
  // chain is ordered: [newest delta, ..., oldest delta closest to base]
  // We need to apply from base outward, so reverse the chain
  let currentFile = basePath;
  let isCurrentTemp = false;

  for (let i = chain.length - 1; i >= 0; i--) {
    const output = tempPath();
    registerTempFile(output);
    try {
      await rdiffPatch(currentFile, chain[i].deltaPath, output);
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

// ── Chain length calculation ──

export async function getChainLength(destRoot, versionsDir, timestamp, filePath) {
  let length = 0;
  let currentTimestamp = timestamp;

  // Walk back through the chain
  const allVersions = (await readdir(versionsDir, { withFileTypes: true }))
    .filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/.test(e.name))
    .map(e => e.name)
    .sort()
    .reverse();

  // Find versions newer than the current one (they may have deltas for this file)
  for (const ver of allVersions) {
    if (ver <= currentTimestamp) continue;
    const manifest = await readManifest(join(versionsDir, ver));
    if (!manifest) continue;
    const entry = manifest.files[filePath];
    if (entry && entry.type === 'delta') {
      length++;
    }
  }

  return length;
}

// ── Find oldest keyframe for a file in the chain ──

async function findOldestKeyframe(versionsDir, timestamp, filePath) {
  const allVersions = (await readdir(versionsDir, { withFileTypes: true }))
    .filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/.test(e.name))
    .map(e => e.name)
    .sort(); // oldest first

  for (const ver of allVersions) {
    if (ver > timestamp) continue; // Only look at older or equal versions
    const manifest = await readManifest(join(versionsDir, ver));
    if (!manifest) return ver; // No manifest = all full copies = keyframe
    const entry = manifest.files[filePath];
    if (!entry || entry.type === 'full') return ver;
  }

  return null;
}

// ── Find base file for a versioned file ──

function findBaseFile(destRoot, versionsDir, timestamp, filePath) {
  // The base for the newest delta is the current file in dest
  const currentPath = join(destRoot, filePath);
  if (existsSync(currentPath)) return currentPath;
  return null;
}

// ── Parse timestamp string to Date ──

function parseTimestamp(ts) {
  // YYYY-MM-DDTHH-MM-SS → Date
  const d = ts.replace(/T(\d{2})-(\d{2})-(\d{2})$/, 'T$1:$2:$3');
  return new Date(d);
}

// ── Integrity verification (Phase 5) ──

export async function verifyDeltaChain(configId) {
  const config = db.prepare('SELECT * FROM ssd_backup_configs WHERE id = ?').get(configId);
  if (!config) throw new Error('Config not found');

  const destRoot = config.dest_path;
  const versionsDir = join(destRoot, '.versions');
  if (!existsSync(versionsDir)) return { verified: 0, broken: 0, errors: [] };

  const allVersions = (await readdir(versionsDir, { withFileTypes: true }))
    .filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/.test(e.name))
    .map(e => e.name)
    .sort();

  let verified = 0;
  let broken = 0;
  const errors = [];

  for (const ver of allVersions) {
    const versionDir = join(versionsDir, ver);
    const manifest = await readManifest(versionDir);
    if (!manifest) continue;

    for (const [filePath, entry] of Object.entries(manifest.files)) {
      if (entry.type !== 'delta') continue;

      try {
        const result = await reconstructFile(destRoot, versionsDir, ver, filePath);
        if (result && result.isTemp) await cleanupTempFile(result.path);
        verified++;
      } catch (err) {
        broken++;
        errors.push({ timestamp: ver, filePath, error: err.message });
        console.error(`[delta-verify] Broken chain: ${ver}/${filePath}: ${err.message}`);
      }
    }
  }

  return { verified, broken, errors };
}

// ── Promote delta to full copy (for prune safety) ──

export async function promoteDeltaToFull(destRoot, versionsDir, timestamp, filePath) {
  const versionDir = join(versionsDir, timestamp);
  const manifest = await readManifest(versionDir);
  if (!manifest) return;

  const entry = manifest.files[filePath];
  if (!entry || entry.type !== 'delta') return;

  // Reconstruct the file
  const result = await reconstructFile(destRoot, versionsDir, timestamp, filePath);
  if (!result) throw new Error(`Cannot reconstruct ${filePath} at ${timestamp}`);

  const deltaPath = join(versionDir, filePath + '.rdelta');
  const fullPath = join(versionDir, filePath);

  // Ensure parent directory exists
  await mkdir(dirname(fullPath), { recursive: true });

  // Copy reconstructed file to the full path
  const { copyFile: copyFileFn } = await import('fs/promises');
  await copyFileFn(result.path, fullPath);
  if (result.isTemp) await cleanupTempFile(result.path);

  // Remove the delta file
  try { await unlink(deltaPath); } catch {}

  // Update manifest
  manifest.files[filePath] = { type: 'full', originalSize: entry.originalSize, reason: 'promoted' };
  await writeManifest(versionDir, manifest);
}

// ── Compute version stats for cache (Phase 7) ──

export async function computeVersionStats(configId) {
  const config = db.prepare('SELECT * FROM ssd_backup_configs WHERE id = ?').get(configId);
  if (!config) return null;

  const versionsDir = join(config.dest_path, '.versions');
  if (!existsSync(versionsDir)) return { snapshotCount: 0, totalDiskSize: 0, totalOriginalSize: 0, spaceSaved: 0 };

  const allVersions = (await readdir(versionsDir, { withFileTypes: true }))
    .filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/.test(e.name))
    .map(e => e.name);

  let totalDiskSize = 0;
  let totalOriginalSize = 0;

  for (const ver of allVersions) {
    const versionDir = join(versionsDir, ver);
    const manifest = await readManifest(versionDir);
    const files = await walkFiles(versionDir);

    for (const file of files) {
      totalDiskSize += file.size;

      if (manifest && manifest.files[file.relPath.replace(/\.rdelta$/, '')]) {
        const entry = manifest.files[file.relPath.replace(/\.rdelta$/, '')];
        totalOriginalSize += entry.originalSize || file.size;
      } else {
        totalOriginalSize += file.size;
      }
    }
  }

  const stats = {
    snapshotCount: allVersions.length,
    totalDiskSize,
    totalOriginalSize,
    spaceSaved: totalOriginalSize - totalDiskSize,
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

  for (const row of rows) {
    try {
      const stats = JSON.parse(row.value);
      totalDiskSize += stats.totalDiskSize || 0;
      totalOriginalSize += stats.totalOriginalSize || 0;
      snapshotCount += stats.snapshotCount || 0;
    } catch {}
  }

  return {
    snapshotCount,
    totalDiskSize,
    totalOriginalSize,
    spaceSaved: totalOriginalSize - totalDiskSize,
  };
}

import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const SUMMARY_FILE = '_summary.json';
const EXCLUDED_FILES = new Set(['_manifest.json', SUMMARY_FILE]);
const DEFAULT_SCAN_LIMIT = 100_000;
const DEFAULT_TIME_BUDGET_MS = 30_000;

function assertSummaryBudget(scanned, startedAt, scanLimit, timeBudgetMs) {
  if (scanned > scanLimit) {
    const error = new Error(`Snapshot summary scan exceeded ${scanLimit} entries`);
    error.code = 'SNAPSHOT_SUMMARY_BUDGET';
    throw error;
  }
  if (Date.now() - startedAt > timeBudgetMs) {
    const error = new Error(`Snapshot summary scan exceeded ${timeBudgetMs}ms`);
    error.code = 'SNAPSHOT_SUMMARY_BUDGET';
    throw error;
  }
}

async function writeSummary(versionDir, summary) {
  const summaryPath = join(versionDir, SUMMARY_FILE);
  const temporaryPath = `${summaryPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(summary, null, 2), { mode: 0o600 });
    await rename(temporaryPath, summaryPath);
    return summary;
  } catch (err) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw err;
  }
}

export async function readSnapshotSummary(versionDir) {
  const summaryPath = join(versionDir, SUMMARY_FILE);
  if (!existsSync(summaryPath)) return null;
  try {
    return JSON.parse(await readFile(summaryPath, 'utf8'));
  } catch {
    return null;
  }
}

export async function refreshSnapshotSummary(versionDir, manifest = null, options = {}) {
  const signal = options.signal;
  const scanLimit = options.scanLimit ?? DEFAULT_SCAN_LIMIT;
  const timeBudgetMs = options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  if (!Number.isInteger(scanLimit) || scanLimit < 1 || scanLimit > DEFAULT_SCAN_LIMIT) {
    throw new Error(`Snapshot summary scan limit must be between 1 and ${DEFAULT_SCAN_LIMIT}`);
  }
  if (!Number.isInteger(timeBudgetMs) || timeBudgetMs < 1 || timeBudgetMs > DEFAULT_TIME_BUDGET_MS) {
    throw new Error(`Snapshot summary time budget must be between 1 and ${DEFAULT_TIME_BUDGET_MS} milliseconds`);
  }
  signal?.throwIfAborted();
  const startedAt = Date.now();
  const stack = [{ directory: versionDir, relative: '' }];
  let scanned = 0;
  let fileCount = 0;
  let diskSize = 0;
  let originalSize = 0;

  while (stack.length > 0) {
    signal?.throwIfAborted();
    const { directory, relative } = stack.pop();
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      signal?.throwIfAborted();
      scanned += 1;
      assertSummaryBudget(scanned, startedAt, scanLimit, timeBudgetMs);
      if (EXCLUDED_FILES.has(entry.name)) continue;
      const fullPath = join(directory, entry.name);
      const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        stack.push({ directory: fullPath, relative: relativePath });
        continue;
      }
      if (!entry.isFile()) continue;
      const manifestPath = relativePath.replace(/\.rdelta$/, '');
      const manifestEntry = manifest?.files?.[manifestPath];
      if (relativePath.endsWith('.rdelta') && manifestEntry?.type === 'full') {
        const fullCopyPath = fullPath.slice(0, -7);
        if (existsSync(fullCopyPath)) continue;
      }
      if (!relativePath.endsWith('.rdelta') && manifestEntry?.type === 'delta') {
        const deltaPath = `${fullPath}.rdelta`;
        if (existsSync(deltaPath)) continue;
      }
      const info = await stat(fullPath);
      fileCount++;
      diskSize += info.size;
      originalSize += manifestEntry?.originalSize || info.size;
    }
  }

  const directoryInfo = await stat(versionDir);
  const summary = {
    version: 1,
    fileCount,
    diskSize,
    originalSize,
    created: directoryInfo.birthtime.toISOString(),
    updated: new Date().toISOString(),
  };
  return writeSummary(versionDir, summary);
}

export async function getOrCreateSnapshotSummary(versionDir, manifest = null, options = {}) {
  options.signal?.throwIfAborted();
  const cached = await readSnapshotSummary(versionDir);
  if (cached && !(cached.incomplete && options.retryIncomplete === true)) return cached;
  try {
    return await refreshSnapshotSummary(versionDir, manifest, options);
  } catch (err) {
    if (err.code !== 'SNAPSHOT_SUMMARY_BUDGET' || options.cacheIncomplete !== true) throw err;
    const directoryInfo = await stat(versionDir);
    return writeSummary(versionDir, {
      version: 1,
      fileCount: null,
      diskSize: null,
      originalSize: null,
      created: directoryInfo.birthtime.toISOString(),
      updated: new Date().toISOString(),
      incomplete: true,
      reason: 'scan-budget-exceeded',
    });
  }
}
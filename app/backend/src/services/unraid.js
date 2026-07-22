// Storage/share auto-detection service.
// Parses Unraid share config when configured, otherwise scans storage roots.

import { readdir, readFile, stat } from 'fs/promises';
import { join } from 'path';
import { resolveAllowedBrowsePath } from './filesystemAccess.js';
import { getAvailableStorageRoots, storageConfig } from './storageConfig.js';

const SHARES_CONFIG_DIR = storageConfig.shareConfigDir;
const MNT_USER = storageConfig.roots.includes('/mnt/user') ? '/mnt/user' : storageConfig.roots[0];
const MNT_CACHE = storageConfig.roots.includes('/mnt/cache') ? '/mnt/cache' : null;

// Parse an Unraid share .cfg file (INI-like format)
function parseCfg(content, filename) {
  const config = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim().replace(/^"/, '').replace(/"$/, '');
    const value = trimmed.slice(eqIdx + 1).trim().replace(/^"/, '').replace(/"$/, '');
    config[key] = value;
  }
  return config;
}

// Get shares from Unraid config files
async function getShareConfigs() {
  if (!SHARES_CONFIG_DIR || !MNT_USER) return [];
  try {
    const files = await readdir(SHARES_CONFIG_DIR);
    const cfgFiles = files.filter(f => f.endsWith('.cfg'));
    const shares = [];

    for (const file of cfgFiles) {
      try {
        const content = await readFile(join(SHARES_CONFIG_DIR, file), 'utf-8');
        const cfg = parseCfg(content, file);
        const name = file.replace('.cfg', '');
        shares.push({
          name,
          comment: cfg.shareComment || cfg.comment || '',
          allocation: cfg.shareAllocator || cfg.allocator || 'highwater',
          useCache: cfg.shareUseCache || cfg.useCache || 'no',
          include: cfg.shareInclude || '',
          exclude: cfg.shareExclude || '',
          userPath: join(MNT_USER, name),
          cachePath: MNT_CACHE ? join(MNT_CACHE, name) : '',
        });
      } catch {
        // Skip unreadable files
      }
    }
    return shares;
  } catch {
    return [];
  }
}

// Scan a directory for top-level folders
async function scanDir(basePath) {
  try {
    const entries = await readdir(basePath, { withFileTypes: true });
    const dirs = [];
    for (const entry of entries) {
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        const fullPath = join(basePath, entry.name);
        try {
          const s = await stat(fullPath);
          if (s.isDirectory()) {
            dirs.push({ name: entry.name, path: fullPath });
          }
        } catch {
          // Skip inaccessible directories
        }
      }
    }
    return dirs;
  } catch {
    return [];
  }
}

// Main API: get all detected shares with paths
export async function getShares() {
  const cfgShares = await getShareConfigs();

  if (cfgShares.length > 0) {
    return cfgShares;
  }

  // Fallback: scan configured storage roots directly
  const userDirs = await scanDir(MNT_USER);
  const cacheDirs = MNT_CACHE ? await scanDir(MNT_CACHE) : [];

  const shareMap = new Map();

  for (const dir of userDirs) {
    shareMap.set(dir.name, {
      name: dir.name,
      comment: '',
      allocation: '',
      useCache: '',
      userPath: dir.path,
      cachePath: '',
    });
  }

  for (const dir of cacheDirs) {
    const existing = shareMap.get(dir.name);
    if (existing) {
      existing.cachePath = dir.path;
    } else {
      shareMap.set(dir.name, {
        name: dir.name,
        comment: '',
        allocation: '',
        useCache: 'only',
        userPath: '',
        cachePath: dir.path,
      });
    }
  }

  for (const root of storageConfig.roots) {
    if (root === MNT_USER || root === MNT_CACHE) continue;
    for (const dir of await scanDir(root)) {
      shareMap.set(`${root}:${dir.name}`, {
        name: dir.name,
        comment: '',
        allocation: '',
        useCache: '',
        path: dir.path,
        userPath: dir.path,
        cachePath: '',
      });
    }
  }

  return Array.from(shareMap.values());
}

// Browse a directory for its contents (for path picker)
export async function browsePath(dirPath) {
  try {
    const roots = getAvailableStorageRoots();
    const confined = resolveAllowedBrowsePath(dirPath, roots);
    const entries = await readdir(confined.path, { withFileTypes: true });
    return entries
      .filter(e => e.isDirectory())
      .map(e => ({
        name: e.name,
        path: join(confined.path, e.name),
        type: 'directory',
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    return [];
  }
}

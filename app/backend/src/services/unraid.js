// Unraid share auto-detection service
// Parses /boot/config/shares/*.cfg and scans /mnt/user/ + /mnt/cache/

import { readdir, readFile, stat } from 'fs/promises';
import { join } from 'path';

const SHARES_CONFIG_DIR = '/boot/config/shares';
const MNT_USER = '/mnt/user';
const MNT_CACHE = '/mnt/cache';

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
          cachePath: join(MNT_CACHE, name),
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

  // Fallback: scan /mnt/user/ and /mnt/cache/ directly
  const [userDirs, cacheDirs] = await Promise.all([
    scanDir(MNT_USER),
    scanDir(MNT_CACHE),
  ]);

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

  return Array.from(shareMap.values());
}

// Browse a directory for its contents (for path picker)
export async function browsePath(dirPath) {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries
      .filter(e => e.isDirectory())
      .map(e => ({
        name: e.name,
        path: join(dirPath, e.name),
        type: 'directory',
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    return [];
  }
}

// Filesystem browsing API — used by PathPicker across all features

import { Router } from 'express';
import { readdirSync, statSync, existsSync } from 'fs';
import { join, resolve, dirname } from 'path';
import os from 'os';
import db from '../db.js';

const router = Router();

// Candidate roots — only those that actually exist on the host are advertised/allowed.
function getAllowedRoots() {
  const home = os.homedir();
  const candidates = [
    { name: 'Home', path: home, icon: 'home' },
    { path: '/mnt/user', name: 'Shares', icon: 'drive' },
    { path: '/mnt/cache', name: 'Cache', icon: 'drive' },
    { path: '/mnt/disks', name: 'Disks', icon: 'drive' },
    { path: '/mnt', name: '/mnt', icon: 'folder' },
    { path: '/media', name: 'Media', icon: 'drive' },
    { path: '/Volumes', name: 'Volumes', icon: 'drive' },
    { path: '/', name: '/', icon: 'folder' },
  ];
  const out = [];
  for (const c of candidates) {
    try {
      if (existsSync(c.path) && statSync(c.path).isDirectory()) out.push(c);
    } catch { /* skip */ }
  }
  return out;
}

// True if `dir` is equal to, or a descendant of, at least one allowed root.
function isUnderAllowedRoot(dir, roots) {
  const target = resolve(dir);
  for (const r of roots) {
    const root = resolve(r.path);
    if (root === '/') return true; // '/' explicitly advertised → full access
    if (target === root) return true;
    if (target.startsWith(root + '/')) return true;
  }
  return false;
}

// Browse a directory
router.get('/browse', (req, res) => {
  const dir = req.query.dir || os.homedir();

  try {
    if (typeof dir !== 'string' || dir.length === 0) {
      return res.status(400).json({ error: 'dir must be a non-empty string' });
    }

    // Enforce that the requested path is within an allowed root. This is an
    // authenticated endpoint, but without this check any admin session could
    // list /app/backend/data/.ssh, /etc, /proc, etc.
    const roots = getAllowedRoots();
    if (!isUnderAllowedRoot(dir, roots)) {
      return res.status(403).json({ error: 'Path is outside allowed roots' });
    }

    if (!existsSync(dir)) {
      return res.status(404).json({ error: 'Directory not found' });
    }

    const stat = statSync(dir);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: 'Path is not a directory' });
    }

    const rawEntries = readdirSync(dir, { withFileTypes: true });
    const entries = [];

    for (const entry of rawEntries) {
      if (entry.name.startsWith('.')) continue;

      const fullPath = join(dir, entry.name);
      const isDir = entry.isDirectory();

      // Only return directories for path picking
      if (!isDir) continue;

      try {
        entries.push({
          name: entry.name,
          path: fullPath,
          type: 'directory',
        });
      } catch { /* permission denied — skip */ }
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    res.json({
      current: resolve(dir),
      parent: dirname(resolve(dir)),
      entries,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get common filesystem roots for quick navigation
router.get('/roots', (req, res) => {
  const home = os.homedir();
  const roots = [
    { name: 'Home', path: home, icon: 'home' },
  ];

  const mounts = [
    { path: '/mnt/user', name: 'Shares', icon: 'drive' },
    { path: '/mnt/cache', name: 'Cache', icon: 'drive' },
    { path: '/mnt/disks', name: 'Disks', icon: 'drive' },
    { path: '/mnt', name: '/mnt', icon: 'folder' },
    { path: '/media', name: 'Media', icon: 'drive' },
    { path: '/Volumes', name: 'Volumes', icon: 'drive' },
  ];

  for (const mp of mounts) {
    try {
      if (existsSync(mp.path) && statSync(mp.path).isDirectory()) {
        roots.push(mp);
      }
    } catch { /* skip */ }
  }

  roots.push({ name: '/', path: '/', icon: 'folder' });

  // Filter out hidden drives (unless include_hidden=true for the settings picker)
  if (req.query.include_hidden !== 'true') {
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'hidden_drives'").get();
      const hidden = JSON.parse(row?.value || '[]');
      if (hidden.length > 0) {
        const filtered = roots.filter(r => !hidden.some(h => r.path === h || r.path.startsWith(h + '/')));
        return res.json(filtered);
      }
    } catch { /* ignore */ }
  }

  res.json(roots);
});

export default router;

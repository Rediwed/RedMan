// Filesystem browsing API — used by PathPicker across all features

import { Router } from 'express';
import { readdirSync, statSync, existsSync } from 'fs';
import { join, resolve, dirname } from 'path';
import os from 'os';

const router = Router();

// Browse a directory
router.get('/browse', (req, res) => {
  const dir = req.query.dir || os.homedir();

  try {
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
router.get('/roots', (_req, res) => {
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

  res.json(roots);
});

export default router;

// Filesystem browsing API — used by PathPicker across all features

import { Router } from 'express';
import { readdirSync, statSync, existsSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import db from '../db.js';
import { resolveAllowedBrowsePath } from '../services/filesystemAccess.js';
import { getAvailableStorageRoots } from '../services/storageConfig.js';

const router = Router();
const backendDataDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');

function getSensitiveRoots() {
  return [
    backendDataDir,
    join(os.homedir(), '.ssh'),
    '/etc', '/proc', '/sys', '/dev', '/boot',
  ];
}

// Candidate roots — only those that actually exist on the host are advertised/allowed.
function getAllowedRoots() {
  const home = os.homedir();
  const candidates = [
    { name: 'Home', path: home, icon: 'home' },
    ...getAvailableStorageRoots(),
  ];
  const out = [];
  for (const c of candidates) {
    try {
      if (existsSync(c.path) && statSync(c.path).isDirectory()) out.push(c);
    } catch { /* skip */ }
  }
  return out;
}

// Browse a directory
router.get('/browse', (req, res) => {
  const dir = req.query.dir || os.homedir();

  try {
    if (typeof dir !== 'string' || dir.length === 0) {
      return res.status(400).json({ error: 'dir must be a non-empty string' });
    }

    if (!existsSync(dir)) {
      return res.status(404).json({ error: 'Directory not found' });
    }

    const roots = getAllowedRoots();
    let confined;
    try {
      confined = resolveAllowedBrowsePath(dir, roots, getSensitiveRoots());
    } catch (err) {
      return res.status(403).json({ error: err.message });
    }

    const stat = statSync(confined.path);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: 'Path is not a directory' });
    }

    const rawEntries = readdirSync(confined.path, { withFileTypes: true });
    const entries = [];

    for (const entry of rawEntries) {
      if (entry.name.startsWith('.')) continue;

      const fullPath = join(confined.path, entry.name);
      const isDir = entry.isDirectory();

      // Only return directories for path picking
      if (!isDir) continue;

      try {
        const allowedEntry = resolveAllowedBrowsePath(fullPath, roots, getSensitiveRoots());
        entries.push({
          name: entry.name,
          path: allowedEntry.path,
          type: 'directory',
        });
      } catch { /* permission denied — skip */ }
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    res.json({
      current: confined.path,
      parent: dirname(confined.path) === dirname(confined.root) || !confined.path.startsWith(confined.root + '/')
        ? confined.root
        : dirname(confined.path),
      entries,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get common filesystem roots for quick navigation
router.get('/roots', (req, res) => {
  const roots = getAllowedRoots();

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

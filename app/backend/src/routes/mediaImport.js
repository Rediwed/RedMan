// Media Import routes — USB/SD card drive detection, scanning, and Immich import

import { Router } from 'express';
import db from '../db.js';
import { detectDrives, isDriveMounted, getConnectedDrives } from '../services/driveMonitor.js';
import { startScan, getScanProgress, clearScan } from '../services/driveScanner.js';
import {
  startImport, getActiveImport, testImmichConnection, isImmichGoAvailable, ejectDrive,
} from '../services/immichImport.js';
import { notifyDriveScanStarted, notifyDriveScanCompleted } from '../services/notify.js';

const router = Router();

// ── Drives ────────────────────────────────────────────────────────

// List currently connected drives (live detection merged with DB data)
router.get('/drives', (req, res) => {
  try {
    const connected = getConnectedDrives();
    const drives = connected.map(drive => {
      const dbRow = findDriveInDb(drive);
      return {
        ...drive,
        id: dbRow?.id || null,
        name: dbRow?.name || drive.label || drive.name,
        detected_camera: dbRow?.detected_camera || null,
        auto_import: dbRow?.auto_import || 0,
        delete_after_import: dbRow?.delete_after_import || 0,
        eject_after_import: dbRow?.eject_after_import || 0,
        first_seen_at: dbRow?.first_seen_at || null,
        last_seen_at: dbRow?.last_seen_at || null,
        last_import_at: dbRow?.last_import_at || null,
        connected: true,
        scan: dbRow ? getScanProgress(dbRow.id) : null,
      };
    });
    res.json(drives);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List all known drives from DB (including disconnected)
router.get('/drives/known', (req, res) => {
  const drives = db.prepare('SELECT * FROM media_drives ORDER BY last_seen_at DESC').all();
  const connected = getConnectedDrives();
  const connectedPaths = new Set(connected.map(d => d.mountPath));

  const result = drives.map(d => ({
    ...d,
    connected: connectedPaths.has(d.mount_path),
    scan: getScanProgress(d.id),
  }));
  res.json(result);
});

// Get single drive details
router.get('/drives/:id', (req, res) => {
  const drive = db.prepare('SELECT * FROM media_drives WHERE id = ?').get(req.params.id);
  if (!drive) return res.status(404).json({ error: 'Drive not found' });

  drive.connected = isDriveMounted(drive.mount_path);
  drive.scan = getScanProgress(drive.id);

  // Get last few import runs
  drive.recent_runs = db.prepare(`
    SELECT id, status, started_at, completed_at, files_total, files_copied, files_failed, duration_seconds
    FROM backup_runs WHERE feature = 'media-import' AND config_id = ?
    ORDER BY started_at DESC LIMIT 5
  `).all(drive.id);

  res.json(drive);
});

// Update drive settings (name, auto_import, delete_after_import, eject_after_import)
router.put('/drives/:id', (req, res) => {
  const drive = db.prepare('SELECT * FROM media_drives WHERE id = ?').get(req.params.id);
  if (!drive) return res.status(404).json({ error: 'Drive not found' });

  const { name, auto_import, delete_after_import, eject_after_import } = req.body;

  db.prepare(`
    UPDATE media_drives SET
      name = COALESCE(?, name),
      auto_import = COALESCE(?, auto_import),
      delete_after_import = COALESCE(?, delete_after_import),
      eject_after_import = COALESCE(?, eject_after_import),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    name ?? null,
    auto_import ?? null,
    delete_after_import ?? null,
    eject_after_import ?? null,
    drive.id
  );

  const updated = db.prepare('SELECT * FROM media_drives WHERE id = ?').get(drive.id);
  res.json(updated);
});

// ── Scanning ──────────────────────────────────────────────────────

// Start an async scan of a drive
router.post('/drives/:id/scan', (req, res) => {
  const drive = db.prepare('SELECT * FROM media_drives WHERE id = ?').get(req.params.id);
  if (!drive) return res.status(404).json({ error: 'Drive not found' });
  if (!isDriveMounted(drive.mount_path)) {
    return res.status(400).json({ error: 'Drive is not currently connected' });
  }

  notifyDriveScanStarted(drive.mount_path);
  const scan = startScan(drive.id, drive.mount_path);

  // When scan completes, update DB with camera detection
  const checkComplete = setInterval(() => {
    const progress = getScanProgress(drive.id);
    if (progress && (progress.status === 'completed' || progress.status === 'failed')) {
      clearInterval(checkComplete);
      if (progress.status === 'completed') {
        if (progress.detectedCamera) {
          db.prepare('UPDATE media_drives SET detected_camera = ?, updated_at = datetime(\'now\') WHERE id = ?')
            .run(progress.detectedCamera, drive.id);
        }
        notifyDriveScanCompleted(drive.mount_path, progress);
      }
    }
  }, 1000);

  res.json(scan);
});

// Get scan progress
router.get('/drives/:id/scan', (req, res) => {
  const scan = getScanProgress(parseInt(req.params.id));
  if (!scan) return res.json({ status: 'none' });
  res.json(scan);
});

// ── Import ────────────────────────────────────────────────────────

// Start import from drive into Immich
router.post('/drives/:id/import', async (req, res) => {
  try {
    const result = await startImport(parseInt(req.params.id));
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Get import progress for a specific run
router.get('/runs/:id/progress', (req, res) => {
  const progress = getActiveImport(parseInt(req.params.id));
  if (!progress) return res.json({ status: 'none' });
  res.json(progress);
});

// ── Import History ────────────────────────────────────────────────

router.get('/runs', (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 10;
  const offset = (page - 1) * limit;
  const driveId = req.query.drive_id;

  let query = `SELECT r.*, d.name as drive_name, d.label as drive_label
    FROM backup_runs r
    LEFT JOIN media_drives d ON r.config_id = d.id
    WHERE r.feature = 'media-import'`;
  const params = [];

  if (driveId) {
    query += ' AND r.config_id = ?';
    params.push(driveId);
  }

  const total = db.prepare(query.replace(/SELECT r\.\*.*FROM/, 'SELECT COUNT(*) as count FROM')).get(...params);
  query += ' ORDER BY r.started_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const runs = db.prepare(query).all(...params);
  res.json({ runs, total: total.count, page, pages: Math.ceil(total.count / limit) });
});

router.get('/runs/:id', (req, res) => {
  const run = db.prepare(`
    SELECT r.*, d.name as drive_name, d.label as drive_label
    FROM backup_runs r
    LEFT JOIN media_drives d ON r.config_id = d.id
    WHERE r.id = ? AND r.feature = 'media-import'
  `).get(req.params.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });

  // Check for live progress
  const progress = getActiveImport(run.id);
  if (progress) run.progress = progress;

  res.json(run);
});

// ── Eject ─────────────────────────────────────────────────────────

router.post('/drives/:id/eject', (req, res) => {
  const drive = db.prepare('SELECT * FROM media_drives WHERE id = ?').get(req.params.id);
  if (!drive) return res.status(404).json({ error: 'Drive not found' });
  if (!isDriveMounted(drive.mount_path)) {
    return res.status(400).json({ error: 'Drive is not currently connected' });
  }

  const result = ejectDrive(drive.mount_path);
  res.json(result);
});

// ── Immich Connection Test ────────────────────────────────────────

router.post('/test-immich', async (req, res) => {
  const result = await testImmichConnection();
  res.json(result);
});

// ── Status ────────────────────────────────────────────────────────

router.get('/status', (req, res) => {
  res.json({
    immichGoAvailable: isImmichGoAvailable(),
    connectedDrives: getConnectedDrives().length,
    knownDrives: db.prepare('SELECT COUNT(*) as count FROM media_drives').get().count,
  });
});

// ── Helpers ───────────────────────────────────────────────────────

function findDriveInDb(drive) {
  if (drive.uuid) {
    const row = db.prepare('SELECT * FROM media_drives WHERE uuid = ?').get(drive.uuid);
    if (row) return row;
  }
  if (drive.serial) {
    const row = db.prepare('SELECT * FROM media_drives WHERE serial = ?').get(drive.serial);
    if (row) return row;
  }
  return db.prepare('SELECT * FROM media_drives WHERE mount_path = ?').get(drive.mountPath);
}

export default router;

// Media Import routes — USB/SD card drive detection, scanning, and Immich import

import { Router } from 'express';
import { existsSync } from 'node:fs';
import db from '../db.js';
import { validateDeleteAfterImportSetting } from '../services/mediaDeletionPolicy.js';
import {
  FOLDER_SOURCE_KIND, validateFolderSourceInput, countTakeoutArchives,
} from '../services/mediaImportSources.js';
import { detectDrives, isDriveMounted, getConnectedDrives } from '../services/driveMonitor.js';
import { startScan, getScanProgress, clearScan } from '../services/driveScanner.js';
import {
  startImport, getActiveImport, cancelImport, testImmichConnection, isImmichGoAvailable,
  ejectDrive, isEjectSupported,
} from '../services/immichImport.js';
import {
  cancelOnlineImport, getActiveOnlineImport, startOnlineImport, validateOnlineMediaSourceInput,
} from '../services/onlineMediaImport.js';
import { cancelRcloneProcess, discoverRemoteTakeoutFolder } from '../services/rclone.js';
import { notifyDriveScanStarted, notifyDriveScanCompleted, notifyJobCancelled } from '../services/notify.js';
import { cancelFeatureRun } from '../services/runLifecycle.js';

const router = Router();

// ── Drives ────────────────────────────────────────────────────────

// List currently connected drives (live detection merged with DB data)
router.get('/drives', (req, res) => {
  try {
    const connected = getConnectedDrives();

    // Get hidden drives list
    let hidden = [];
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'hidden_drives'").get();
      hidden = JSON.parse(row?.value || '[]');
    } catch { /* ignore */ }

    const drives = connected
      .filter(drive => !hidden.some(h => drive.mountPath === h || drive.mountPath?.startsWith(h + '/')))
      .map(drive => {
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
  const drives = db.prepare("SELECT * FROM media_drives WHERE source_kind = 'drive' ORDER BY last_seen_at DESC").all();
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
  const drive = db.prepare("SELECT * FROM media_drives WHERE id = ? AND source_kind = 'drive'").get(req.params.id);
  if (!drive) return res.status(404).json({ error: 'Drive not found' });

  const { name, auto_import, delete_after_import, eject_after_import } = req.body;

  let safeDeleteAfterImport = null;
  if (delete_after_import !== undefined) {
    try {
      safeDeleteAfterImport = validateDeleteAfterImportSetting(delete_after_import);
    } catch (err) {
      return res.status(409).json({ error: err.message });
    }
  }

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
    safeDeleteAfterImport,
    eject_after_import ?? null,
    drive.id
  );

  const updated = db.prepare('SELECT * FROM media_drives WHERE id = ?').get(drive.id);
  res.json(updated);
});

// ── Folder sources ────────────────────────────────────────────────

router.get('/sources', (req, res) => {
  const sources = db.prepare(`
    SELECT * FROM media_drives WHERE source_kind IN ('folder', 'online') ORDER BY name COLLATE NOCASE
  `).all();

  res.json(sources.map(source => ({
    ...source,
    // A takeout that has not been downloaded yet is the common case; say so
    // rather than failing at import time.
    archive_count: source.source_kind === 'folder' && source.import_mode === 'google-photos'
      ? countTakeoutArchives(source) : null,
    completed_archive_count: source.source_kind === 'online' ? db.prepare(`
      SELECT COUNT(*) AS count FROM media_online_import_archives WHERE source_id = ?
    `).get(source.id).count : null,
    available: source.source_kind === 'online' || existsSync(source.mount_path),
  })));
});

router.get('/online-discover/:remoteName', async (req, res) => {
  const processKey = `takeout-discovery:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const cancelIfAbandoned = () => {
    if (!res.writableEnded) cancelRcloneProcess(processKey);
  };
  res.once('close', cancelIfAbandoned);
  try {
    res.json(await discoverRemoteTakeoutFolder(req.params.remoteName, { processKey }));
  } catch (err) {
    if (!res.headersSent) res.status(400).json({ error: err.message });
  } finally {
    res.off('close', cancelIfAbandoned);
  }
});

router.post('/online-sources', async (req, res) => {
  let source;
  try {
    source = validateOnlineMediaSourceInput(req.body);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const clash = db.prepare("SELECT id FROM media_drives WHERE source_kind = 'online' AND remote_name = ? AND remote_path = ?")
    .get(source.remoteName, source.remotePath);
  if (clash) return res.status(409).json({ error: 'An online import source already uses that Google Drive folder' });
  const stagingClash = db.prepare('SELECT id FROM media_drives WHERE mount_path = ?').get(source.stagingPath);
  if (stagingClash) return res.status(409).json({ error: 'Another import source already uses that local staging folder' });

  const result = db.prepare(`
    INSERT INTO media_drives (name, label, mount_path, source_kind, import_mode, remote_name, remote_path)
    VALUES (?, ?, ?, 'online', 'google-photos', ?, ?)
  `).run(source.name, source.name, source.stagingPath, source.remoteName, source.remotePath);
  res.status(201).json(db.prepare('SELECT * FROM media_drives WHERE id = ?').get(result.lastInsertRowid));
});

router.post('/sources', (req, res) => {
  let source;
  try {
    source = validateFolderSourceInput(req.body);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const clash = db.prepare('SELECT id FROM media_drives WHERE mount_path = ?').get(source.path);
  if (clash) return res.status(409).json({ error: 'An import source already uses that path' });

  const result = db.prepare(`
    INSERT INTO media_drives (name, label, mount_path, source_kind, import_mode)
    VALUES (?, ?, ?, ?, ?)
  `).run(source.name, source.name, source.path, FOLDER_SOURCE_KIND, source.importMode);

  res.status(201).json(db.prepare('SELECT * FROM media_drives WHERE id = ?').get(result.lastInsertRowid));
});

router.put('/sources/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM media_drives WHERE id = ? AND source_kind = ?')
    .get(req.params.id, FOLDER_SOURCE_KIND);
  if (!existing) return res.status(404).json({ error: 'Import source not found' });

  let source;
  try {
    source = validateFolderSourceInput({
      name: req.body.name ?? existing.name,
      path: req.body.path ?? existing.mount_path,
      import_mode: req.body.import_mode ?? existing.import_mode,
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const clash = db.prepare('SELECT id FROM media_drives WHERE mount_path = ? AND id != ?')
    .get(source.path, existing.id);
  if (clash) return res.status(409).json({ error: 'An import source already uses that path' });

  db.prepare(`
    UPDATE media_drives SET name = ?, label = ?, mount_path = ?, import_mode = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(source.name, source.name, source.path, source.importMode, existing.id);

  res.json(db.prepare('SELECT * FROM media_drives WHERE id = ?').get(existing.id));
});

router.delete('/sources/:id', (req, res) => {
  const existing = db.prepare("SELECT * FROM media_drives WHERE id = ? AND source_kind IN ('folder', 'online')")
    .get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Import source not found' });
  if (getActiveImportForSource(existing.id)) {
    return res.status(409).json({ error: 'An import is still running on this source' });
  }

  // Removing the definition must not remove the evidence: past runs stay in
  // history, which is why config_id is not a foreign key.
  db.prepare('DELETE FROM media_drives WHERE id = ?').run(existing.id);
  res.json({ deleted: true });
});

// ── Scanning ──────────────────────────────────────────────────────

// Start an async scan of a drive
router.post('/drives/:id/scan', (req, res) => {
  const drive = db.prepare("SELECT * FROM media_drives WHERE id = ? AND source_kind = 'drive'").get(req.params.id);
  if (!drive) return res.status(404).json({ error: 'Drive not found' });
  if (!isDriveMounted(drive.mount_path)) {
    return res.status(400).json({ error: 'Drive is not currently connected' });
  }

  notifyDriveScanStarted(drive.mount_path);
  const scan = startScan(drive.id, drive.mount_path, {
    onComplete(progress) {
      if (progress.status === 'completed') {
        if (progress.detectedCamera) {
          db.prepare('UPDATE media_drives SET detected_camera = ?, updated_at = datetime(\'now\') WHERE id = ?')
            .run(progress.detectedCamera, drive.id);
        }
        notifyDriveScanCompleted(drive.mount_path, progress);
      }
    },
  });

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
    const source = db.prepare('SELECT source_kind FROM media_drives WHERE id = ?').get(req.params.id);
    const result = source?.source_kind === 'online'
      ? await startOnlineImport(parseInt(req.params.id))
      : await startImport(parseInt(req.params.id));
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Get import progress for a specific run
router.get('/runs/:id/progress', (req, res) => {
  const progress = getActiveImport(parseInt(req.params.id)) || getActiveOnlineImport(parseInt(req.params.id));
  if (!progress) return res.json({ status: 'none' });
  res.json(progress);
});

// Cancel a running import
router.post('/runs/:id/cancel', (req, res) => {
  const runId = parseInt(req.params.id);
  const result = cancelFeatureRun(db, {
    feature: 'media-import', runId,
    cancelProcess: id => cancelOnlineImport(id) || cancelImport(id),
  });
  if (!result.ok) return res.status(result.statusCode).json({ error: result.error });
  const drive = db.prepare('SELECT * FROM media_drives WHERE id = ?').get(result.run.config_id);
  notifyJobCancelled('Media Import', drive?.name || drive?.label || `Drive ${result.run.config_id}`);
  res.json({ status: 'cancelled' });
});

// ── Import History ────────────────────────────────────────────────

router.get('/runs', (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 10;
  const offset = (page - 1) * limit;
  const driveId = req.query.drive_id;

  let where = `WHERE r.feature = 'media-import'`;
  const params = [];

  if (driveId) {
    where += ' AND r.config_id = ?';
    params.push(driveId);
  }

  const total = db.prepare(`SELECT COUNT(*) as count FROM backup_runs r ${where}`).get(...params);
  let query = `SELECT r.*, d.name as drive_name, d.label as drive_label
    FROM backup_runs r
    LEFT JOIN media_drives d ON r.config_id = d.id
    ${where}`;
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
  const progress = getActiveImport(run.id) || getActiveOnlineImport(run.id);
  if (progress) run.progress = progress;

  res.json(run);
});

// Get per-file details for a run
router.get('/runs/:id/files', (req, res) => {
  const runId = req.params.id;
  const run = db.prepare('SELECT id FROM backup_runs WHERE id = ? AND feature = ?').get(runId, 'media-import');
  if (!run) return res.status(404).json({ error: 'Run not found' });

  const action = req.query.action; // filter by action: uploaded, error, duplicate
  let query = 'SELECT * FROM backup_run_files WHERE run_id = ?';
  const params = [runId];

  if (action) {
    query += ' AND action = ?';
    params.push(action);
  }

  query += ' ORDER BY id';
  const files = db.prepare(query).all(...params);

  // Summary counts
  const summary = db.prepare(`
    SELECT action, COUNT(*) as count FROM backup_run_files WHERE run_id = ? GROUP BY action
  `).all(runId);

  // Date range of imported photos (where Immich places them in timeline)
  const dateRange = db.prepare(`
    SELECT MIN(file_date) as earliest, MAX(file_date) as latest
    FROM backup_run_files WHERE run_id = ? AND file_date IS NOT NULL
  `).get(runId);

  res.json({ files, summary, dateRange: dateRange || null });
});

// ── Eject ─────────────────────────────────────────────────────────

router.post('/drives/:id/eject', (req, res) => {
  const drive = db.prepare("SELECT * FROM media_drives WHERE id = ? AND source_kind = 'drive'").get(req.params.id);
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
    ejectSupported: isEjectSupported(),
  });
});

// ── Helpers ───────────────────────────────────────────────────────

function getActiveImportForSource(sourceId) {
  const running = db.prepare(`
    SELECT id FROM backup_runs
    WHERE feature = 'media-import' AND config_id = ? AND status = 'running'
  `).get(sourceId);
  return running ? getActiveImport(running.id) || getActiveOnlineImport(running.id) || running : null;
}

function findDriveInDb(drive) {
  if (drive.uuid) {
    const row = db.prepare("SELECT * FROM media_drives WHERE uuid = ? AND source_kind = 'drive'").get(drive.uuid);
    if (row) return row;
  }
  if (drive.serial) {
    const row = db.prepare("SELECT * FROM media_drives WHERE serial = ? AND source_kind = 'drive'").get(drive.serial);
    if (row) return row;
  }
  return db.prepare("SELECT * FROM media_drives WHERE mount_path = ? AND source_kind = 'drive'").get(drive.mountPath);
}

export default router;

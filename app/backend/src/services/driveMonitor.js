// Drive monitor — polls /mnt/disks/ for USB/SD card mount changes
// Detects attach/detach events and triggers auto-import when configured

import { readdirSync, existsSync, statSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import db from '../db.js';
import { sendNotification, notifyDriveAttached, notifyDriveEjected, notifyDriveLost } from './notify.js';

const MOUNT_ROOT = '/mnt/disks';

let knownDrives = new Map(); // mountPath → driveInfo
let pollTimer = null;
let onDriveAttached = null; // callback for auto-import

/**
 * Detect drives mounted under /mnt/disks/ with lsblk metadata.
 * Returns array of { name, mountPath, uuid, serial, label, size, filesystem }
 */
export function detectDrives() {
  const drives = [];

  if (!existsSync(MOUNT_ROOT)) return drives;

  let lsblkData = {};
  try {
    const raw = execSync(
      'lsblk -J -o NAME,UUID,SERIAL,LABEL,SIZE,FSTYPE,MOUNTPOINT,HOTPLUG 2>/dev/null',
      { encoding: 'utf-8', timeout: 10000 }
    );
    const parsed = JSON.parse(raw);
    for (const dev of (parsed.blockdevices || [])) {
      for (const part of (dev.children || [dev])) {
        if (part.mountpoint) {
          lsblkData[part.mountpoint] = {
            uuid: part.uuid || null,
            serial: dev.serial || part.serial || null,
            label: part.label || null,
            size: part.size || null,
            filesystem: part.fstype || null,
            hotplug: part.hotplug ?? dev.hotplug ?? null,
          };
        }
      }
    }
  } catch {
    // lsblk not available or failed — fall back to directory enumeration
  }

  try {
    const entries = readdirSync(MOUNT_ROOT, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const mountPath = join(MOUNT_ROOT, entry.name);

      // Skip empty mount points
      try {
        const contents = readdirSync(mountPath);
        if (contents.length === 0) continue;
      } catch { continue; }

      const info = lsblkData[mountPath] || {};
      let sizeBytes = null;
      if (info.size) {
        sizeBytes = parseSizeToBytes(info.size);
      }

      drives.push({
        name: entry.name,
        mountPath,
        uuid: info.uuid || null,
        serial: info.serial || null,
        label: info.label || entry.name,
        sizeBytes,
        sizeHuman: info.size || null,
        filesystem: info.filesystem || 'unknown',
      });
    }
  } catch {
    // /mnt/disks not readable
  }

  return drives;
}

/**
 * Start polling for drive changes.
 * @param {Function} onAttach — callback(driveRow) fired when a new drive is detected
 */
export function startDriveMonitor(onAttach) {
  onDriveAttached = onAttach;

  // Seed with current drives to avoid false attach events on startup
  const initial = detectDrives();
  for (const drive of initial) {
    knownDrives.set(drive.mountPath, drive);
    upsertDrive(drive);
  }
  console.log(`[drive-monitor] Tracking ${knownDrives.size} drive(s) under ${MOUNT_ROOT}`);

  const interval = parseInt(getSetting('media_import_poll_interval') || '10', 10) * 1000;
  pollTimer = setInterval(poll, interval);
}

export function stopDriveMonitor() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function poll() {
  const current = detectDrives();
  const currentMap = new Map(current.map(d => [d.mountPath, d]));

  // Detect newly attached drives
  for (const [path, drive] of currentMap) {
    if (!knownDrives.has(path)) {
      console.log(`[drive-monitor] Drive attached: ${drive.label || drive.name} (${path})`);
      const row = upsertDrive(drive);
      notifyDriveAttached(drive);

      if (onDriveAttached && row) {
        onDriveAttached(row);
      }
    }
  }

  // Detect removed drives
  for (const [path, drive] of knownDrives) {
    if (!currentMap.has(path)) {
      const lost = !existsSync(path);
      const label = drive.label || drive.name;
      if (lost) {
        console.log(`[drive-monitor] Drive lost: ${label} (${path})`);
        notifyDriveLost(drive);
      } else {
        console.log(`[drive-monitor] Drive ejected: ${label} (${path})`);
        notifyDriveEjected(drive);
      }
    }
  }

  knownDrives = currentMap;
}

/**
 * Insert or update a drive record in the database.
 * Matches by UUID first, then serial, then mount path name.
 */
function upsertDrive(drive) {
  let existing = null;

  if (drive.uuid) {
    existing = db.prepare('SELECT * FROM media_drives WHERE uuid = ?').get(drive.uuid);
  }
  if (!existing && drive.serial) {
    existing = db.prepare('SELECT * FROM media_drives WHERE serial = ?').get(drive.serial);
  }
  if (!existing) {
    existing = db.prepare('SELECT * FROM media_drives WHERE mount_path = ?').get(drive.mountPath);
  }

  if (existing) {
    db.prepare(`
      UPDATE media_drives SET
        uuid = COALESCE(?, uuid), serial = COALESCE(?, serial),
        label = COALESCE(?, label), mount_path = ?,
        size_bytes = COALESCE(?, size_bytes), filesystem = COALESCE(?, filesystem),
        last_seen_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(drive.uuid, drive.serial, drive.label, drive.mountPath,
           drive.sizeBytes, drive.filesystem, existing.id);
    return db.prepare('SELECT * FROM media_drives WHERE id = ?').get(existing.id);
  }

  const result = db.prepare(`
    INSERT INTO media_drives (uuid, serial, label, name, mount_path, size_bytes, filesystem)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(drive.uuid, drive.serial, drive.label, drive.label || drive.name,
         drive.mountPath, drive.sizeBytes, drive.filesystem);
  return db.prepare('SELECT * FROM media_drives WHERE id = ?').get(result.lastInsertRowid);
}

/** Check if a specific drive is currently mounted */
export function isDriveMounted(mountPath) {
  return knownDrives.has(mountPath);
}

/** Get all currently connected drives */
export function getConnectedDrives() {
  return Array.from(knownDrives.values());
}

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row?.value || '';
}

function parseSizeToBytes(sizeStr) {
  if (!sizeStr) return null;
  const match = sizeStr.match(/([\d.]+)\s*([KMGTP]?)/i);
  if (!match) return null;
  const num = parseFloat(match[1]);
  const unit = (match[2] || '').toUpperCase();
  const multipliers = { '': 1, 'K': 1024, 'M': 1024 ** 2, 'G': 1024 ** 3, 'T': 1024 ** 4, 'P': 1024 ** 5 };
  return Math.round(num * (multipliers[unit] || 1));
}

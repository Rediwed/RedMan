// Drive scanner — scans USB/SD drives for photos and videos,
// detects camera brand from DCIM folder structure and file extensions

import { readdir, stat } from 'fs/promises';
import { join, extname } from 'path';

// Active scans tracked for progress polling
const activeScans = new Map();

const PHOTO_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.tif', '.webp', '.heic', '.heif',
  '.cr2', '.cr3', '.nef', '.arw', '.rw2', '.raf', '.orf', '.dng', '.pef', '.srw', '.x3f',
]);

const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mov', '.avi', '.mkv', '.m4v', '.3gp', '.mts', '.m2ts', '.wmv', '.flv', '.webm',
]);

// Camera brand detection from DCIM subfolder names
const CAMERA_PATTERNS = [
  { pattern: /CANON|EOS/i, brand: 'Canon' },
  { pattern: /GOPRO/i, brand: 'GoPro' },
  { pattern: /MSDCF/i, brand: 'Sony' },
  { pattern: /PANA/i, brand: 'Panasonic' },
  { pattern: /NIKON|NCD/i, brand: 'Nikon' },
  { pattern: /APPLE/i, brand: 'Apple' },
  { pattern: /FUJI/i, brand: 'Fujifilm' },
  { pattern: /OLYMP/i, brand: 'Olympus' },
  { pattern: /RICOH/i, brand: 'Ricoh' },
  { pattern: /SAMSUNG/i, brand: 'Samsung' },
  { pattern: /DJI/i, brand: 'DJI' },
];

// Camera brand detection from RAW file extensions
const RAW_BRAND_MAP = {
  '.cr2': 'Canon', '.cr3': 'Canon',
  '.nef': 'Nikon',
  '.arw': 'Sony',
  '.rw2': 'Panasonic',
  '.raf': 'Fujifilm',
  '.orf': 'Olympus',
  '.pef': 'Pentax',
  '.srw': 'Samsung',
  '.x3f': 'Sigma',
};

const MAX_FILES = 500_000;

/**
 * Scan a drive for photos and videos. Runs async to avoid blocking.
 * Returns a scan ID for progress polling.
 */
export function startScan(driveId, mountPath) {
  if (activeScans.has(driveId)) {
    return activeScans.get(driveId);
  }

  const scan = {
    driveId,
    mountPath,
    status: 'scanning',
    photos: 0,
    videos: 0,
    otherFiles: 0,
    photoBytes: 0,
    videoBytes: 0,
    totalBytes: 0,
    hasDCIM: false,
    detectedCamera: null,
    topFolders: [],
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
  };

  activeScans.set(driveId, scan);
  runScan(scan).catch(err => {
    scan.status = 'failed';
    scan.error = err.message;
    scan.completedAt = new Date().toISOString();
  });

  return scan;
}

export function getScanProgress(driveId) {
  return activeScans.get(driveId) || null;
}

export function clearScan(driveId) {
  activeScans.delete(driveId);
}

async function runScan(scan) {
  const { mountPath } = scan;
  const cameraBrandVotes = {};

  // Check for DCIM folder and detect camera
  try {
    const topEntries = await readdir(mountPath, { withFileTypes: true });
    scan.topFolders = topEntries
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .slice(0, 50);

    const dcimPath = topEntries.find(e => e.isDirectory() && e.name.toUpperCase() === 'DCIM');
    if (dcimPath) {
      scan.hasDCIM = true;
      // Read DCIM subfolders for camera brand hints
      try {
        const dcimEntries = await readdir(join(mountPath, dcimPath.name), { withFileTypes: true });
        for (const entry of dcimEntries) {
          if (!entry.isDirectory()) continue;
          for (const { pattern, brand } of CAMERA_PATTERNS) {
            if (pattern.test(entry.name)) {
              cameraBrandVotes[brand] = (cameraBrandVotes[brand] || 0) + 1;
            }
          }
        }
      } catch { /* DCIM not readable */ }
    }
  } catch {
    scan.status = 'failed';
    scan.error = 'Cannot read drive root directory';
    scan.completedAt = new Date().toISOString();
    return;
  }

  // Walk the file tree (stack-based to avoid recursion limits)
  const stack = [mountPath];
  let fileCount = 0;

  while (stack.length > 0 && fileCount < MAX_FILES) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch { continue; }

    for (const entry of entries) {
      if (fileCount >= MAX_FILES) break;

      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        // Skip hidden dirs and system dirs
        if (entry.name.startsWith('.') || entry.name === 'System Volume Information') continue;
        stack.push(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;
      fileCount++;

      const ext = extname(entry.name).toLowerCase();
      let fileSize = 0;
      try {
        const st = await stat(fullPath);
        fileSize = st.size;
      } catch { /* skip stat errors */ }

      scan.totalBytes += fileSize;

      if (PHOTO_EXTENSIONS.has(ext)) {
        scan.photos++;
        scan.photoBytes += fileSize;
        // Check for RAW brand hints
        if (RAW_BRAND_MAP[ext]) {
          const brand = RAW_BRAND_MAP[ext];
          cameraBrandVotes[brand] = (cameraBrandVotes[brand] || 0) + 1;
        }
      } else if (VIDEO_EXTENSIONS.has(ext)) {
        scan.videos++;
        scan.videoBytes += fileSize;
      } else {
        scan.otherFiles++;
      }
    }
  }

  // Determine camera brand from votes
  if (Object.keys(cameraBrandVotes).length > 0) {
    const sorted = Object.entries(cameraBrandVotes).sort((a, b) => b[1] - a[1]);
    scan.detectedCamera = sorted[0][0];
  }

  scan.status = 'completed';
  scan.completedAt = new Date().toISOString();
}

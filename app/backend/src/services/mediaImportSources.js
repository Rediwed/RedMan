// Media import sources that are not removable drives.
//
// The drive monitor discovers what is physically attached; a folder source is
// declared by hand and stays declared, so the two are stored in one table but
// must never be matched against each other — a folder that happens to sit at a
// former mount point is still a folder.

import { existsSync, opendirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalizeLocalPath, isWithinPrefix, normalizePath } from '../middleware/validation.js';
import { isSupportedImmichUploadMode } from './immichCommand.js';
import { storageConfig } from './storageConfig.js';

export const FOLDER_SOURCE_KIND = 'folder';
export const DRIVE_SOURCE_KIND = 'drive';

const MAX_NAME_LENGTH = 100;

// A takeout folder holds tens to hundreds of archives. Reading a directory is
// synchronous and there is one thread, so the walk stops well before a folder
// with a million entries could hold up every other request.
const MAX_SCANNED_ENTRIES = 5000;

function containedInStorageRoots(canonicalPath, config) {
  // The roots are compared in canonical form too: a root that is itself a
  // symlink would otherwise reject every legitimate path underneath it.
  return config.roots.some(root => isWithinPrefix(canonicalPath, canonicalizeLocalPath(root) || root));
}

/**
 * Validate an operator-declared folder source.
 * Returns { name, path, importMode } or throws with a human-readable reason.
 */
export function validateFolderSourceInput(input = {}, config = storageConfig) {
  const name = String(input.name || '').trim();
  if (!name) throw new Error('A name is required');
  if (name.length > MAX_NAME_LENGTH) {
    throw new Error(`Name must be ${MAX_NAME_LENGTH} characters or fewer`);
  }

  const importMode = String(input.import_mode || input.importMode || 'folder').trim();
  if (!isSupportedImmichUploadMode(importMode)) {
    throw new Error(`Unsupported import mode: ${importMode}`);
  }

  const normalized = normalizePath(String(input.path || '').trim());
  if (!normalized || normalized === '/') {
    throw new Error('Path must be an absolute directory below the filesystem root');
  }

  // Resolve symlinks before the containment check, so a link inside a storage
  // root cannot be used to read a directory outside every root.
  const canonical = canonicalizeLocalPath(normalized);
  if (!canonical) throw new Error(`Path does not exist: ${normalized}`);

  if (!containedInStorageRoots(canonical, config)) {
    throw new Error(`Path must be inside one of RedMan's storage roots: ${config.roots.join(', ')}`);
  }

  let info;
  try {
    info = statSync(canonical);
  } catch {
    throw new Error(`Path is not readable: ${normalized}`);
  }
  if (!info.isDirectory()) throw new Error(`Path is not a directory: ${normalized}`);

  return { name, path: canonical, importMode };
}

/**
 * Re-check a stored folder source immediately before reading it.
 *
 * The path was validated when it was declared, and that verdict was written to
 * the database — but a folder can be replaced by a symlink afterwards, and the
 * storage roots can be narrowed. Both would leave a stale row pointing outside
 * the boundary, so containment is proven again rather than remembered.
 */
export function assertSourceReadable(source, config = storageConfig) {
  if (source.source_kind !== FOLDER_SOURCE_KIND) return source.mount_path;

  // canonicalizeLocalPath resolves the deepest existing ancestor and re-appends
  // the rest, so it answers "where would this be" rather than "is this there".
  const canonical = canonicalizeLocalPath(source.mount_path);
  if (!canonical || !existsSync(canonical)) {
    throw new Error(`Import source folder no longer exists: ${source.mount_path}`);
  }
  if (canonical !== normalizePath(source.mount_path)) {
    throw new Error(`Import source folder now resolves elsewhere: ${source.mount_path}`);
  }
  if (!containedInStorageRoots(canonical, config)) {
    throw new Error(`Import source folder is no longer inside RedMan's storage roots: ${source.mount_path}`);
  }
  return canonical;
}

/**
 * Names of the takeout archives in a folder, bounded so that a directory with
 * an unreasonable number of entries cannot stall the process.
 */
export function listTakeoutArchives(root) {
  let dir;
  try {
    dir = opendirSync(root);
  } catch {
    return [];
  }

  const names = [];
  let scanned = 0;
  try {
    let entry = dir.readSync();
    while (entry !== null && scanned < MAX_SCANNED_ENTRIES) {
      scanned += 1;
      // On filesystems that do not report an entry type both checks are false,
      // so an unknown entry is kept rather than a real archive being dropped.
      if (!entry.isDirectory() && !entry.isSymbolicLink() && entry.name.toLowerCase().endsWith('.zip')) {
        names.push(entry.name);
      }
      entry = dir.readSync();
    }
  } catch {
    // A folder that becomes unreadable mid-walk is one broken source, not a
    // broken list: report what was found instead of failing every source.
    return names;
  } finally {
    dir.closeSync();
  }
  return names;
}

/**
 * Resolve the arguments immich-go should be pointed at for a source.
 *
 * A Google Photos takeout arrives as numbered zips. immich-go reads them
 * without unpacking, but only when it is handed the archives themselves, so the
 * folder is expanded here. A folder holding an already-extracted takeout has no
 * zips and is passed through unchanged.
 */
export function resolveImportSourcePaths(source, listArchives = listTakeoutArchives) {
  const root = source.mount_path;
  if (source.import_mode !== 'google-photos') return [root];

  const names = listArchives(root);
  if (names.length === 0) return [root];

  return names
    // Numbered takeout parts must be handed over in order: immich-go matches
    // sidecars across archive boundaries and reports on what it has seen.
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    .map(name => join(root, name));
}

/**
 * How many takeout archives a source currently holds, derived from the same
 * resolution the import uses so the count cannot drift from what gets uploaded.
 */
export function countTakeoutArchives(source, listArchives = listTakeoutArchives) {
  if (source.import_mode !== 'google-photos') return 0;
  const paths = resolveImportSourcePaths(source, listArchives);
  return paths.length === 1 && paths[0] === source.mount_path ? 0 : paths.length;
}

/**
 * Post-import source deletion and drive ejection only mean something for a
 * removable drive that a person is waiting to unplug.
 */
export function supportsDriveSideEffects(source) {
  return source.source_kind !== FOLDER_SOURCE_KIND;
}

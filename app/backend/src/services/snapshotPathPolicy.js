import { existsSync, lstatSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, posix } from 'node:path';
import { ensureDirectoryWithinPrefix, resolveExistingPathWithinPrefix } from './pathConfinement.js';
import { isWithinPrefix, localPathsOverlap, normalizePath } from '../middleware/validation.js';

function invalid(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

export function validateSnapshotTimestamp(value) {
  const match = typeof value === 'string'
    ? value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})$/)
    : null;
  if (!match) throw invalid('Invalid snapshot timestamp');

  const [, year, month, day, hour, minute, second] = match.map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1
      || parsed.getUTCDate() !== day || parsed.getUTCHours() !== hour
      || parsed.getUTCMinutes() !== minute || parsed.getUTCSeconds() !== second) {
    throw invalid('Invalid snapshot timestamp');
  }
  return value;
}

export function normalizeSnapshotRelativePath(value, { allowEmpty = false } = {}) {
  if (allowEmpty && (value === '' || value === undefined || value === null)) return '';
  if (typeof value !== 'string' || !value || isAbsolute(value) || value.includes('\\') || value.includes('\0')) {
    throw invalid('Snapshot path must be a relative path');
  }

  const segments = value.split('/');
  if (segments.some(segment => segment === '..' || segment === '.versions')) {
    throw invalid('Snapshot path is outside the backup root');
  }
  const normalized = posix.normalize(value).replace(/^\.\//, '');
  if (!normalized || normalized === '.' || normalized.startsWith('../')) {
    if (allowEmpty && normalized === '.') return '';
    throw invalid('Snapshot path must identify a file or directory');
  }
  return normalized;
}

export function resolveExistingSnapshotPath(root, relativePath, { allowEmpty = false, suffix = '' } = {}) {
  const normalized = normalizeSnapshotRelativePath(relativePath, { allowEmpty });
  const candidate = normalized ? join(root, `${normalized}${suffix}`) : root;
  if (!existsSync(candidate)) return null;
  try {
    return resolveExistingPathWithinPrefix(candidate, root).path;
  } catch {
    throw invalid('Snapshot path resolves outside the backup root');
  }
}

export function resolveSnapshotRoot(versionsDir, timestamp) {
  const validTimestamp = validateSnapshotTimestamp(timestamp);
  return resolveExistingSnapshotPath(versionsDir, validTimestamp);
}

/**
 * Validate a restore folder other than the job's own source.
 * Restoring somewhere harmless is the only way to prove recovery works without
 * overwriting the live file you are trying to protect.
 */
export function resolveAlternateRestoreRoot(requestedRoot, { snapshotRoot, allowedRoots = [] } = {}) {
  const normalized = normalizePath(String(requestedRoot ?? '').trim());
  if (!normalized || normalized === '/' || !isAbsolute(normalized)) {
    throw invalid('Restore folder must be an absolute path');
  }
  if (!allowedRoots.some(root => isWithinPrefix(normalized, root))) {
    throw invalid('Restore folder is outside the folders RedMan may write to');
  }
  if (!existsSync(normalized) || !statSync(normalized).isDirectory()) {
    throw invalid('Restore folder does not exist');
  }
  // Writing into the snapshot store would corrupt the history being restored from.
  if (snapshotRoot && localPathsOverlap(normalized, snapshotRoot)) {
    throw invalid('Restore folder overlaps the backup destination');
  }
  return normalized;
}

export function prepareRestoreDestination(sourceRoot, relativePath) {
  const normalized = normalizeSnapshotRelativePath(relativePath);
  const destination = join(sourceRoot, normalized);
  try {
    ensureDirectoryWithinPrefix(dirname(destination), sourceRoot);
    if (existsSync(destination)) {
      if (lstatSync(destination).isSymbolicLink()) throw new Error('symlink');
      resolveExistingPathWithinPrefix(destination, sourceRoot);
    }
  } catch {
    throw invalid('Restore destination resolves outside the source root');
  }
  return { path: destination, relativePath: normalized };
}
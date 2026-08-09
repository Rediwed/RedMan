// Path and input validation utilities for Hyper Backup security

import { existsSync, realpathSync } from 'node:fs';
import { resolve, normalize, posix } from 'path';
import { validatePrivatePeerBaseUrl } from '../services/peerUrlPolicy.js';

/**
 * Normalize a path: resolve '..' segments, ensure absolute, strip trailing slash.
 * Returns null if path is invalid (empty, not absolute after normalization).
 */
export function normalizePath(p) {
  if (!p || typeof p !== 'string') return null;
  // Reject shell metacharacters + newlines that could be used for command injection,
  // and NUL, which truncates the path in any syscall that later receives it.
  if (/[$`"\\|;&(){}\n\r\0]/.test(p)) return null;
  const normalized = posix.normalize(p);
  if (!normalized.startsWith('/')) return null;
  // Strip trailing slash (except for root '/')
  return normalized === '/' ? '/' : normalized.replace(/\/+$/, '');
}

/**
 * Check if a normalized path is within the allowed prefix.
 * Both paths should already be normalized.
 */
export function isWithinPrefix(path, prefix) {
  if (!path || !prefix) return false;
  const normalizedPath = normalizePath(path);
  const normalizedPrefix = normalizePath(prefix);
  if (!normalizedPath || !normalizedPrefix) return false;

  // Root prefix allows everything
  if (normalizedPrefix === '/') return true;

  // Path must equal prefix or start with prefix + '/'
  return normalizedPath === normalizedPrefix ||
    normalizedPath.startsWith(normalizedPrefix + '/');
}

/**
 * Return true if two paths overlap: they are equal, or one is an ancestor of
 * the other. Used to prevent an SSD backup whose destination overlaps another
 * backup's destination — with rsync --delete, the ancestor job wipes the nested
 * job's data on every run (the "ping-pong" data-loss scenario).
 */
export function pathsOverlap(a, b) {
  const na = normalizePath(a);
  const nb = normalizePath(b);
  if (!na || !nb) return false;
  return na === nb || isWithinPrefix(na, nb) || isWithinPrefix(nb, na);
}

export function canonicalizeLocalPath(path) {
  const normalizedPath = normalizePath(path);
  if (!normalizedPath) return null;
  let existingPath = normalizedPath;
  const missingSegments = [];

  while (!existsSync(existingPath)) {
    const parent = posix.dirname(existingPath);
    if (parent === existingPath) return null;
    missingSegments.unshift(posix.basename(existingPath));
    existingPath = parent;
  }

  try {
    return normalizePath(posix.join(realpathSync(existingPath), ...missingSegments));
  } catch {
    return null;
  }
}

export function localPathsOverlap(a, b) {
  const canonicalA = canonicalizeLocalPath(a);
  const canonicalB = canonicalizeLocalPath(b);
  return Boolean(canonicalA && canonicalB && pathsOverlap(canonicalA, canonicalB));
}

// Roots that must never be an rsync --delete destination: wiping stray files
// here would destroy the array, cache, boot config, or the OS itself.
const DANGEROUS_DEST_PATHS = new Set([
  '/', '/mnt', '/mnt/user', '/mnt/user0', '/mnt/cache', '/mnt/disks',
  '/boot', '/etc', '/root', '/var', '/usr', '/bin', '/lib', '/sys', '/proc', '/dev',
]);

/**
 * Validate the source/destination pair for a single SSD backup config.
 * Catches the destructive combinations that rsync --delete-after enables:
 *   - source === destination
 *   - destination nested inside source (recursive self-copy)
 *   - source nested inside destination (--delete removes sibling data)
 *   - destination is a protected system/mount root
 * Returns { ok: true } or { ok: false, error } with a human-readable reason.
 */
export function validateSsdBackupPaths(sourcePath, destPath, protectedRoots = []) {
  const source = normalizePath(sourcePath);
  const dest = normalizePath(destPath);

  if (!source) return { ok: false, error: 'Source path is invalid or contains unsafe characters.' };
  if (!dest) return { ok: false, error: 'Destination path is invalid or contains unsafe characters.' };
  const canonicalSource = canonicalizeLocalPath(source);
  const canonicalDest = canonicalizeLocalPath(dest);
  if (!canonicalSource || !canonicalDest) {
    return { ok: false, error: 'Source and destination paths must resolve within the local filesystem.' };
  }

  if (source === dest || canonicalSource === canonicalDest) {
    return { ok: false, error: 'Source and destination are the same path. This would delete data with rsync --delete.' };
  }
  const configuredProtectedRoots = new Set(protectedRoots.flatMap(root => {
    const normalizedRoot = normalizePath(root);
    const canonicalRoot = canonicalizeLocalPath(root);
    return [normalizedRoot, canonicalRoot].filter(Boolean);
  }));
  if (DANGEROUS_DEST_PATHS.has(dest) || DANGEROUS_DEST_PATHS.has(canonicalDest) || configuredProtectedRoots.has(dest) || configuredProtectedRoots.has(canonicalDest)) {
    return { ok: false, error: `Destination "${dest}" is a protected system/mount root. Choose a dedicated sub-folder to avoid --delete wiping unrelated data.` };
  }
  if (isWithinPrefix(dest, source) || isWithinPrefix(canonicalDest, canonicalSource)) {
    return { ok: false, error: `Destination "${dest}" is inside the source "${source}". The backup would recursively copy into itself.` };
  }
  if (isWithinPrefix(source, dest) || isWithinPrefix(canonicalSource, canonicalDest)) {
    return { ok: false, error: `Source "${source}" is inside the destination "${dest}". rsync --delete would remove every sibling file in the destination that is not in the source.` };
  }

  return { ok: true };
}

/**
 * Validate SSH port is within valid range.
 */
export function validateSshPort(port) {
  const raw = String(port ?? '').trim();
  if (!/^\d+$/.test(raw)) return false;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535;
}

/**
 * Validate SSH host: DNS name or IP, no shell metachars, no leading '-'
 * (prevents argv option-injection into ssh/rsync).
 */
export function validateSshHost(h) {
  if (!h || typeof h !== 'string') return false;
  if (h.length > 253) return false;
  if (h.startsWith('-')) return false;
  return /^[a-zA-Z0-9._-]+$/.test(h);
}

/**
 * Validate SSH username: alphanumeric + ._- , no leading '-'.
 */
export function validateSshUser(u) {
  if (!u || typeof u !== 'string') return false;
  if (u.length > 64) return false;
  if (u.startsWith('-')) return false;
  if (u.toLowerCase() === 'root') return false;
  return /^[a-zA-Z0-9._-]+$/.test(u);
}

/**
 * Validate direction is a known value.
 */
export function validateDirection(dir) {
  return ['push', 'pull'].includes(dir);
}

/**
 * Validate a URL string is well-formed.
 */
export function validateUrl(urlStr) {
  try {
    validatePrivatePeerBaseUrl(urlStr);
    return true;
  } catch {
    return false;
  }
}

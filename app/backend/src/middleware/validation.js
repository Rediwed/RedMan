// Path and input validation utilities for Hyper Backup security

import { resolve, normalize, posix } from 'path';

/**
 * Normalize a path: resolve '..' segments, ensure absolute, strip trailing slash.
 * Returns null if path is invalid (empty, not absolute after normalization).
 */
export function normalizePath(p) {
  if (!p || typeof p !== 'string') return null;
  // Reject shell metacharacters + newlines that could be used for command injection
  if (/[$`"\\|;&(){}\n\r]/.test(p)) return null;
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
 * Validate SSH port is within valid range.
 */
export function validateSshPort(port) {
  const p = parseInt(port);
  return Number.isInteger(p) && p >= 1 && p <= 65535;
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
    const url = new URL(urlStr);
    return ['http:', 'https:'].includes(url.protocol);
  } catch {
    return false;
  }
}

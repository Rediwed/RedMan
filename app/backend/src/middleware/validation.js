// Path and input validation utilities for Hyper Backup security

import { resolve, normalize, posix } from 'path';

/**
 * Normalize a path: resolve '..' segments, ensure absolute, strip trailing slash.
 * Returns null if path is invalid (empty, not absolute after normalization).
 */
export function normalizePath(p) {
  if (!p || typeof p !== 'string') return null;
  // Reject shell metacharacters that could be used for command injection
  if (/[$`"\\|;&(){}]/.test(p)) return null;
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

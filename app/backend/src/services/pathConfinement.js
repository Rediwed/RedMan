import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { isWithinPrefix, normalizePath } from '../middleware/validation.js';

function getConfinementRoot(prefix) {
  const normalizedPrefix = normalizePath(prefix);
  if (!normalizedPrefix || !existsSync(normalizedPrefix) || !statSync(normalizedPrefix).isDirectory()) {
    throw new Error('Allowed path prefix does not exist or is not a directory');
  }
  return { normalizedPrefix, realPrefix: realpathSync(normalizedPrefix) };
}

export function resolveExistingPathWithinPrefix(requestedPath, prefix) {
  const normalizedPath = normalizePath(requestedPath);
  const { normalizedPrefix, realPrefix } = getConfinementRoot(prefix);
  if (!normalizedPath || !isWithinPrefix(normalizedPath, normalizedPrefix)) {
    throw new Error('Path is outside the allowed prefix');
  }

  const realPath = realpathSync(normalizedPath);
  if (!isWithinPrefix(realPath, realPrefix)) {
    throw new Error('Path resolves outside the allowed prefix');
  }
  return { path: realPath, prefix: realPrefix };
}

export function ensureDirectoryWithinPrefix(requestedPath, prefix) {
  const normalizedPath = normalizePath(requestedPath);
  const { normalizedPrefix, realPrefix } = getConfinementRoot(prefix);
  if (!normalizedPath || !isWithinPrefix(normalizedPath, normalizedPrefix)) {
    throw new Error('Path is outside the allowed prefix');
  }

  const relativePath = relative(normalizedPrefix, normalizedPath);
  let currentPath = normalizedPrefix;
  for (const segment of relativePath.split('/').filter(Boolean)) {
    currentPath = join(currentPath, segment);
    if (existsSync(currentPath)) {
      const info = lstatSync(currentPath);
      if (info.isSymbolicLink()) throw new Error('Destination path may not traverse symbolic links');
      if (!info.isDirectory()) throw new Error('Destination path contains a non-directory segment');
    } else {
      mkdirSync(currentPath);
    }

    if (!isWithinPrefix(realpathSync(currentPath), realPrefix)) {
      throw new Error('Destination path resolves outside the allowed prefix');
    }
  }

  return { path: realpathSync(normalizedPath), prefix: realPrefix };
}
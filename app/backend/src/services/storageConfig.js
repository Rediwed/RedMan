import { existsSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { normalizePath } from '../middleware/validation.js';

const DEFAULT_STORAGE_ROOTS = [
  '/mnt/user',
  '/mnt/cache',
  '/mnt/disks',
  '/mnt',
  '/media',
  '/Volumes',
  '/storage',
];

function absoluteDirectoryPath(value, label) {
  const normalized = normalizePath(String(value || '').trim());
  if (!normalized || normalized === '/') {
    throw new Error(`${label} must be an absolute directory below the filesystem root`);
  }
  return normalized;
}

function rootName(root) {
  const names = {
    '/mnt/user': 'Shares',
    '/mnt/cache': 'Cache',
    '/mnt/disks': 'Disks',
    '/media-import': 'Removable Media',
    '/storage': 'Storage',
    '/Volumes': 'Volumes',
  };
  return names[root] || basename(root) || root;
}

export function getStorageConfig(env = process.env) {
  const configuredRoots = env.REDMAN_STORAGE_ROOTS;
  const sourceRoots = configuredRoots === undefined
    ? DEFAULT_STORAGE_ROOTS
    : configuredRoots.split(',').map(value => value.trim()).filter(Boolean);
  if (sourceRoots.length === 0) throw new Error('REDMAN_STORAGE_ROOTS must list at least one directory');

  const roots = [...new Set(sourceRoots.map((root, index) => absoluteDirectoryPath(
    root,
    `REDMAN_STORAGE_ROOTS entry ${index + 1}`,
  )))];
  const mediaRoot = absoluteDirectoryPath(env.REDMAN_MEDIA_ROOT || '/mnt/disks', 'REDMAN_MEDIA_ROOT');
  let shareConfigDir = '/boot/config/shares';
  if (Object.prototype.hasOwnProperty.call(env, 'REDMAN_SHARE_CONFIG_DIR')) {
    shareConfigDir = env.REDMAN_SHARE_CONFIG_DIR
      ? absoluteDirectoryPath(env.REDMAN_SHARE_CONFIG_DIR, 'REDMAN_SHARE_CONFIG_DIR')
      : null;
  }

  return Object.freeze({ roots, mediaRoot, shareConfigDir });
}

export function getAvailableStorageRoots(config = storageConfig) {
  return config.roots.flatMap(path => {
    try {
      if (!existsSync(path) || !statSync(path).isDirectory()) return [];
      return [{ name: rootName(path), path, icon: 'drive' }];
    } catch {
      return [];
    }
  });
}

export const storageConfig = getStorageConfig();
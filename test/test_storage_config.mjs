import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  getAvailableStorageRoots,
  getStorageConfig,
} from '../app/backend/src/services/storageConfig.js';

const fixture = resolve(import.meta.dirname, 'data', `storage-config-${process.pid}`);
const storage = resolve(fixture, 'storage');
const media = resolve(fixture, 'media');
mkdirSync(storage, { recursive: true });
mkdirSync(media, { recursive: true });

try {
  const config = getStorageConfig({
    REDMAN_STORAGE_ROOTS: `${storage},${media},${storage}`,
    REDMAN_MEDIA_ROOT: media,
    REDMAN_SHARE_CONFIG_DIR: '',
  });
  assert.deepEqual(config.roots, [storage, media]);
  assert.equal(config.mediaRoot, media);
  assert.equal(config.shareConfigDir, null);
  assert.deepEqual(getAvailableStorageRoots(config).map(root => root.path), [storage, media]);
  assert.throws(() => getStorageConfig({ REDMAN_STORAGE_ROOTS: '/' }), /below the filesystem root/);
  assert.throws(() => getStorageConfig({ REDMAN_STORAGE_ROOTS: 'relative' }), /absolute directory/);
  assert.throws(() => getStorageConfig({ REDMAN_STORAGE_ROOTS: '' }), /at least one/);
  console.log('Storage config: generic roots, media root, deduplication, and validation passed');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
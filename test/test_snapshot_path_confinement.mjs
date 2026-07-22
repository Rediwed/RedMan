import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const fixture = resolve(import.meta.dirname, 'data', `snapshot-confinement-${process.pid}`);
const source = resolve(fixture, 'source');
const destination = resolve(fixture, 'destination');
const outside = resolve(fixture, 'outside');
mkdirSync(source, { recursive: true });
mkdirSync(destination, { recursive: true });
mkdirSync(resolve(destination, 'nested'), { recursive: true });
mkdirSync(resolve(destination, '.versions', '2026-07-17T13-00-00'), { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(resolve(destination, 'safe.txt'), 'safe snapshot');
writeFileSync(resolve(destination, 'nested', 'safe.txt'), 'nested snapshot');
writeFileSync(resolve(outside, 'secret.txt'), 'outside secret');
symlinkSync(outside, resolve(destination, 'escape'));
symlinkSync(outside, resolve(source, 'escape'));
writeFileSync(resolve(destination, '.versions', '2026-07-17T13-00-00', 'tampered.txt.rdelta'), 'not a delta');
writeFileSync(resolve(destination, '.versions', '2026-07-17T13-00-00', '_manifest.json'), JSON.stringify({
  files: { 'tampered.txt': { type: 'delta', base: '../../outside' } },
}));
process.env.DB_PATH = resolve(fixture, 'redman.db');

const { default: db } = await import('../app/backend/src/db.js');
const { browseSnapshot, resolveFilePath, restoreFile } = await import('../app/backend/src/services/versionBrowser.js');

try {
  const config = db.prepare(`
    INSERT INTO ssd_backup_configs (name, source_path, dest_path) VALUES (?, ?, ?)
  `).run('Snapshot confinement', source, destination);
  const configId = Number(config.lastInsertRowid);
  const timestamp = '2026-07-17T12-00-00';

  assert.equal((await resolveFilePath(configId, timestamp, 'safe.txt')).path, resolve(destination, 'safe.txt'));
  await assert.rejects(resolveFilePath(configId, timestamp, '../outside/secret.txt'), /outside the backup root/);
  await assert.rejects(resolveFilePath(configId, timestamp, '/etc/passwd'), /relative path/);
  await assert.rejects(resolveFilePath(configId, '../../outside', 'safe.txt'), /snapshot timestamp/i);
  await assert.rejects(resolveFilePath(configId, timestamp, 'escape/secret.txt'), /resolves outside/);
  await assert.rejects(resolveFilePath(configId, timestamp, 'tampered.txt'), /Invalid snapshot timestamp/);
  await assert.rejects(browseSnapshot(configId, timestamp, '../outside'), /outside the backup root/);
  await assert.rejects(restoreFile(configId, timestamp, '../outside/secret.txt'), /outside the backup root/);
  await assert.rejects(restoreFile(configId, timestamp, 'escape/secret.txt'), /outside the source root/);

  const restored = await restoreFile(configId, timestamp, 'nested/safe.txt');
  assert.equal(restored.restored, 'nested/safe.txt');
  assert.equal(readFileSync(resolve(source, 'nested/safe.txt'), 'utf8'), 'nested snapshot');
  assert.equal(readFileSync(resolve(outside, 'secret.txt'), 'utf8'), 'outside secret');

  console.log('Snapshot paths: traversal, absolute paths, timestamps, and symlink escapes rejected');
} finally {
  db.close();
  rmSync(fixture, { recursive: true, force: true });
}
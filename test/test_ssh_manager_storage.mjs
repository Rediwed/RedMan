import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const fixture = mkdtempSync(join(tmpdir(), 'redman-ssh-manager-'));
const homeDirectory = join(fixture, 'home');
const homeSshDirectory = join(homeDirectory, '.ssh');
const dataDirectory = join(fixture, 'data');
mkdirSync(homeSshDirectory, { recursive: true, mode: 0o700 });
mkdirSync(join(dataDirectory, '.ssh'), { recursive: true, mode: 0o700 });
const sentinelPath = join(homeSshDirectory, 'id_ed25519');
writeFileSync(sentinelPath, 'developer-private-key-sentinel\n', { mode: 0o600 });
writeFileSync(join(dataDirectory, '.ssh', 'id_ed25519'), 'redman-private-key\n', { mode: 0o600 });
writeFileSync(join(dataDirectory, '.ssh', 'id_ed25519.pub'), 'ssh-ed25519 cmVkbWFu redman@test\n', { mode: 0o600 });

try {
  const moduleUrl = pathToFileURL(resolve(import.meta.dirname, '../app/backend/src/services/sshManager.js')).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const module = await import(${JSON.stringify(moduleUrl)});
    console.log(JSON.stringify(module.getSshStatus()));
  `], {
    env: {
      ...process.env,
      HOME: homeDirectory,
      DB_PATH: join(dataDirectory, 'redman.db'),
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const status = JSON.parse(result.stdout.trim());
  assert.equal(status.keyExists, true);
  assert.equal(status.keyPath, join(dataDirectory, '.ssh', 'id_ed25519'));
  assert.equal(readFileSync(sentinelPath, 'utf8'), 'developer-private-key-sentinel\n');
  assert.equal(readFileSync(join(dataDirectory, '.ssh', 'id_ed25519'), 'utf8'), 'redman-private-key\n');
  console.log('SSH manager storage: import uses RedMan data only and leaves process HOME untouched');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
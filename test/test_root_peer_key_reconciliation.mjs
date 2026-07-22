import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const require = createRequire(resolve(import.meta.dirname, '../app/package.json'));
const Database = require('better-sqlite3');
const fixture = mkdtempSync(resolve(tmpdir(), 'redman-root-keys-'));
const databasePath = resolve(fixture, 'redman.db');
const managedPath = resolve(fixture, 'managed');
const rootPath = resolve(fixture, 'root-authorized_keys');
const rollbackDir = resolve(fixture, 'rollback');
const script = resolve(import.meta.dirname, '..', 'scripts', 'reconcile-root-peer-keys.sh');
const peerKey = `ssh-ed25519 ${Buffer.from('peer-key').toString('base64')} peer@test`;
const otherKey = `ssh-ed25519 ${Buffer.from('other-key').toString('base64')} other@test`;

function run() {
  return spawnSync('bash', [script,
    '--database', databasePath,
    '--managed-keys', managedPath,
    '--root-keys', rootPath,
    '--rollback-dir', rollbackDir,
  ], { encoding: 'utf8' });
}

async function waitForFile(filePath) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (existsSync(filePath)) return;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 10));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

try {
  const database = new Database(databasePath);
  database.exec('CREATE TABLE authorized_peers (id INTEGER PRIMARY KEY, ssh_public_key TEXT, enabled INTEGER)');
  database.prepare('INSERT INTO authorized_peers VALUES (1, ?, 1)').run(peerKey);
  database.close();
  writeFileSync(managedPath, `restrict,command="rrsync /backup" ${peerKey}\n`, { mode: 0o600 });
  writeFileSync(rootPath, `${peerKey}\n${otherKey}\n`, { mode: 0o600 });

  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(rootPath, 'utf8'), `${otherKey}\n`);
  assert.equal(readdirSync(rollbackDir).length, 1);
  assert.match(readFileSync(resolve(rollbackDir, readdirSync(rollbackDir)[0]), 'utf8'), /peer@test/);
  assert.equal(chmodSync(rootPath, 0o600), undefined);

  const idempotent = run();
  assert.equal(idempotent.status, 0, idempotent.stderr);
  assert.equal(readdirSync(rollbackDir).length, 1);

  writeFileSync(managedPath, `${otherKey}\n`, { mode: 0o600 });
  writeFileSync(rootPath, `${peerKey}\n${otherKey}\n`, { mode: 0o600 });
  chmodSync(rootPath, 0o600);
  const blocked = run();
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /not reconciled/);
  assert.match(readFileSync(rootPath, 'utf8'), /peer@test/);

  const fakeBin = resolve(fixture, 'bin');
  const sqliteStarted = resolve(fixture, 'sqlite-started');
  const concurrentRoot = resolve(fixture, 'concurrent-authorized_keys');
  const concurrentRollback = resolve(fixture, 'concurrent-rollback');
  mkdirSync(fakeBin);
  writeFileSync(resolve(fakeBin, 'sqlite3'), `#!/bin/sh\ntouch '${sqliteStarted}'\nsleep 1\nprintf '%s\\n' '${peerKey}'\n`);
  chmodSync(resolve(fakeBin, 'sqlite3'), 0o700);
  writeFileSync(managedPath, `restrict,command="rrsync /backup" ${peerKey}\n`, { mode: 0o600 });
  writeFileSync(concurrentRoot, `${peerKey}\n${otherKey}\n`, { mode: 0o600 });
  const concurrent = spawn('bash', [script,
    '--database', databasePath,
    '--managed-keys', managedPath,
    '--root-keys', concurrentRoot,
    '--rollback-dir', concurrentRollback,
  ], { encoding: 'utf8', env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` } });
  let concurrentError = '';
  concurrent.stderr.on('data', chunk => { concurrentError += chunk; });
  await waitForFile(sqliteStarted);
  writeFileSync(concurrentRoot, `${peerKey}\n${otherKey}\n# concurrent change\n`, { mode: 0o600 });
  const concurrentStatus = await new Promise(resolvePromise => concurrent.once('close', resolvePromise));
  assert.notEqual(concurrentStatus, 0);
  assert.match(concurrentError, /changed during reconciliation/);
  assert.match(readFileSync(concurrentRoot, 'utf8'), /concurrent change/);
  assert.equal(readdirSync(concurrentRollback).length, 0);

  const realSha256 = spawnSync('sh', ['-c', 'command -v sha256sum'], { encoding: 'utf8' }).stdout.trim();
  const finalWindowBin = resolve(fixture, 'final-window-bin');
  const finalWindowCount = resolve(fixture, 'final-window-count');
  const finalWindowRoot = resolve(fixture, 'final-window-authorized_keys');
  const finalWindowRollback = resolve(fixture, 'final-window-rollback');
  mkdirSync(finalWindowBin);
  writeFileSync(resolve(finalWindowBin, 'sha256sum'), `#!/bin/sh
count=0
test ! -f '${finalWindowCount}' || count=$(cat '${finalWindowCount}')
count=$((count + 1))
printf '%s' "$count" > '${finalWindowCount}'
if test "$count" -eq 2; then printf '%s\n' '# final-window change' >> '${finalWindowRoot}'; fi
exec '${realSha256}' "$@"
`);
  chmodSync(resolve(finalWindowBin, 'sha256sum'), 0o700);
  writeFileSync(finalWindowRoot, `${peerKey}\n${otherKey}\n`, { mode: 0o600 });
  const finalWindow = spawnSync('bash', [script,
    '--database', databasePath,
    '--managed-keys', managedPath,
    '--root-keys', finalWindowRoot,
    '--rollback-dir', finalWindowRollback,
  ], { encoding: 'utf8', env: { ...process.env, PATH: `${finalWindowBin}:${process.env.PATH}` } });
  assert.notEqual(finalWindow.status, 0);
  assert.match(finalWindow.stderr, /changed during reconciliation/);
  assert.match(readFileSync(finalWindowRoot, 'utf8'), /final-window change/);
  assert.equal(readdirSync(finalWindowRollback).length, 0);
  console.log('Root peer-key reconciliation: exact removal, rollback, idempotence, and fail-closed checks passed');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
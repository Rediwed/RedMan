import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import net from 'node:net';

const root = resolve(import.meta.dirname, '..');
const fixture = mkdtempSync(join(tmpdir(), 'redman-upgrade-runtime-'));
const databasePath = join(fixture, 'redman.db');
const mainPort = 18170;
const peerPort = 18171;

function peerPortReachable() {
  return new Promise(resolvePromise => {
    const socket = net.createConnection({ host: '127.0.0.1', port: peerPort });
    socket.setTimeout(250);
    socket.on('connect', () => { socket.destroy(); resolvePromise(true); });
    socket.on('timeout', () => { socket.destroy(); resolvePromise(false); });
    socket.on('error', () => resolvePromise(false));
  });
}

const commonEnv = {
  ...process.env,
  DB_PATH: databasePath,
  PORT: String(mainPort),
  PEER_API_PORT: String(peerPort),
  PEER_HOST: '127.0.0.1',
};

const missingAdminAuthority = spawnSync(process.execPath, [
  '--input-type=module',
  '-e',
  `await import(${JSON.stringify(resolve(root, 'app/backend/src/middleware/auth.js'))})`,
], {
  env: {
    ...commonEnv,
    NODE_ENV: 'production',
    TRUSTED_PROXIES: '127.0.0.1/32',
    REDMAN_ADMIN_GROUP: '',
    REDMAN_ADMIN_ROLE: '',
  },
  encoding: 'utf8',
});
assert.notEqual(missingAdminAuthority.status, 0);
assert.match(missingAdminAuthority.stderr, /REDMAN_ADMIN_GROUP and\/or REDMAN_ADMIN_ROLE/);

const seeded = spawnSync(process.execPath, [resolve(root, 'app/backend/src/seed.js')], {
  env: { ...commonEnv, NODE_ENV: 'test' },
  encoding: 'utf8',
});
assert.equal(seeded.status, 0, `${seeded.stdout}\n${seeded.stderr}`);

const server = spawn(process.execPath, [resolve(root, 'app/backend/src/index.js')], {
  env: {
    ...commonEnv,
    NODE_ENV: 'production',
    REDMAN_UPGRADE_BRIDGE: 'true',
    TRUSTED_PROXIES: '127.0.0.1/32,::1/128',
    REDMAN_ADMIN_GROUP: 'upgrade-admins',
    REDMAN_ADMIN_ROLE: 'Admin',
    TZ: 'Europe/Amsterdam',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
server.stdout.on('data', chunk => { output += chunk; });
server.stderr.on('data', chunk => { output += chunk; });

const groupHeaders = {
  'Remote-User': 'bridge-admin',
  'Remote-Groups': 'upgrade-admins',
  'Content-Type': 'application/json',
};
const roleHeaders = {
  'Remote-User': 'badger-admin',
  'Remote-Role': 'Admin',
  'Content-Type': 'application/json',
};

try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${mainPort}/api/health`);
      if (response.ok) { ready = true; break; }
    } catch {}
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
  }
  assert.equal(ready, true, output);

  const health = await (await fetch(`http://127.0.0.1:${mainPort}/api/health`)).json();
  assert.equal(health.upgradeBridge, true);
  for (const field of ['hostname', 'platform', 'nodeVersion', 'memory', 'pid']) assert.equal(health[field], null);

  const missingIdentity = await fetch(`http://127.0.0.1:${mainPort}/api/upgrade-readiness`);
  assert.equal(missingIdentity.status, 401);

  const assessment = await fetch(`http://127.0.0.1:${mainPort}/api/upgrade-readiness`, { headers: roleHeaders });
  assert.equal(assessment.status, 200);
  const assessmentBody = await assessment.json();
  assert.equal(assessmentBody.suggestedTimezone, 'Europe/Amsterdam');
  assert.equal(assessmentBody.checks.find(item => item.id === 'application-backup').resolution.action.step, 1);

  const viewerRemediation = await fetch(`http://127.0.0.1:${mainPort}/api/upgrade-readiness/remediate`, {
    method: 'POST',
    headers: { ...roleHeaders, 'Remote-Role': 'Member' },
    body: JSON.stringify({ issueId: 'media-deletion' }),
  });
  assert.equal(viewerRemediation.status, 403);

  const unsupportedRemediation = await fetch(`http://127.0.0.1:${mainPort}/api/upgrade-readiness/remediate`, {
    method: 'POST', headers: roleHeaders, body: JSON.stringify({ issueId: 'legacy-peers' }),
  });
  assert.equal(unsupportedRemediation.status, 400);

  const adminRemediation = await fetch(`http://127.0.0.1:${mainPort}/api/upgrade-readiness/remediate`, {
    method: 'POST', headers: roleHeaders, body: JSON.stringify({ issueId: 'media-deletion' }),
  });
  assert.equal(adminRemediation.status, 200, await adminRemediation.text());

  const viewerBackup = await fetch(`http://127.0.0.1:${mainPort}/api/upgrade-readiness/backup`, {
    method: 'POST',
    headers: { ...roleHeaders, 'Remote-Role': 'Member' },
    body: '{}',
  });
  assert.equal(viewerBackup.status, 403);

  const adminBackup = await fetch(`http://127.0.0.1:${mainPort}/api/upgrade-readiness/backup`, {
    method: 'POST', headers: roleHeaders, body: '{}',
  });
  assert.equal(adminBackup.status, 200, await adminBackup.text());

  const groupAdminBackup = await fetch(`http://127.0.0.1:${mainPort}/api/upgrade-readiness/backup`, {
    method: 'POST', headers: groupHeaders, body: '{}',
  });
  assert.equal(groupAdminBackup.status, 200, await groupAdminBackup.text());

  const finalConfigurationInput = {
    authMode: 'proxy',
    publicOrigin: 'https://redman.example.com',
    trustedProxy: '127.0.0.1',
    peerHost: '192.168.50.20',
    dataPath: '/srv/redman',
    storagePath: '/srv/backups',
    mediaPath: '/media',
    timezone: 'Europe/Amsterdam',
    dockerMonitoring: true,
  };
  const viewerConfiguration = await fetch(`http://127.0.0.1:${mainPort}/api/upgrade-readiness/final-config`, {
    method: 'POST',
    headers: { ...roleHeaders, 'Remote-Role': 'Member' },
    body: JSON.stringify(finalConfigurationInput),
  });
  assert.equal(viewerConfiguration.status, 403);
  const adminConfiguration = await fetch(`http://127.0.0.1:${mainPort}/api/upgrade-readiness/final-config`, {
    method: 'POST', headers: roleHeaders, body: JSON.stringify(finalConfigurationInput),
  });
  assert.equal(adminConfiguration.status, 200, await adminConfiguration.text());
  const reassessment = await fetch(`http://127.0.0.1:${mainPort}/api/upgrade-readiness`, { headers: roleHeaders });
  assert.equal((await reassessment.json()).finalConfiguration.status, 'ready');

  const blockedMutation = await fetch(`http://127.0.0.1:${mainPort}/api/settings`, {
    method: 'PUT', headers: roleHeaders, body: '{}',
  });
  assert.equal(blockedMutation.status, 503);
  assert.equal(await peerPortReachable(), false);
  assert.match(output, /Maintenance mode active/);
  assert.match(output, /Peer API paused/);

  console.log('Upgrade bridge runtime: exact proxy auth, admin preparation, maintenance lock, redacted health, and paused peer API passed');
} finally {
  server.kill('SIGTERM');
  await new Promise(resolvePromise => server.once('exit', resolvePromise));
  rmSync(fixture, { recursive: true, force: true });
}

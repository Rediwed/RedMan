import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import {
  assessUpgradeReadiness,
  createFinalConfiguration,
  createHostPreparationPlan,
  createUpgradeBackup,
  UPGRADE_BACKUP_PAGES_PER_STEP,
} from '../app/backend/src/services/upgradeReadiness.js';

const require = createRequire(import.meta.url);
const Database = require('../app/node_modules/better-sqlite3');
const fixture = mkdtempSync(join(tmpdir(), 'redman-upgrade-readiness-'));
const databasePath = join(fixture, 'redman.db');
const database = new Database(databasePath);

database.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE backup_runs (id INTEGER PRIMARY KEY, status TEXT);
  CREATE TABLE hyper_backup_jobs (id INTEGER PRIMARY KEY, local_path TEXT, remote_path TEXT, ssh_user TEXT);
  CREATE TABLE authorized_peers (
    id INTEGER PRIMARY KEY,
    allowed_path_prefix TEXT,
    storage_limit_bytes INTEGER,
    enabled INTEGER,
    static_pubkey TEXT
  );
  CREATE TABLE media_drives (id INTEGER PRIMARY KEY, delete_after_import INTEGER);
  CREATE TABLE ssd_backup_configs (id INTEGER PRIMARY KEY, dest_path TEXT);
  INSERT INTO settings VALUES ('docker_socket', '/var/run/docker.sock');
  INSERT INTO hyper_backup_jobs VALUES (1, '/srv/source', '/srv/remote', 'root');
  INSERT INTO authorized_peers VALUES (1, '/', 0, 1, NULL);
  INSERT INTO media_drives VALUES (1, 1);
  INSERT INTO ssd_backup_configs VALUES (1, '/srv/backups');
`);

try {
  assert.equal(UPGRADE_BACKUP_PAGES_PER_STEP, 16_384);
  const hostHelperSource = readFileSync(join(import.meta.dirname, '../scripts/prepare-upgrade-host.sh'), 'utf8');
  assert.doesNotMatch(hostHelperSource, /update\(readFileSync\(backupPath\)\)/);
  assert.match(hostHelperSource, /sha256sum -c -/);

  let assessment = assessUpgradeReadiness(database, { dataDir: fixture });
  assert.equal(assessment.summary.blocked, 1);
  assert.equal(assessment.summary.warning, 5);
  assert.equal(assessment.summary.rootJobs, 1);
  assert.equal(assessment.summary.unsafePeers, 1);
  assert.deepEqual(assessment.pathCandidates, ['/srv/backups', '/srv/source']);

  const backup = await createUpgradeBackup(database, {
    dataDir: fixture,
    now: new Date('2026-07-18T08:00:00.000Z'),
  });
  assert.equal(backup.integrity, 'ok');
  assert.ok(backup.sizeBytes > 0);
  const backupReceipt = JSON.parse(readFileSync(join(fixture, 'upgrade-readiness/application-backup.json'), 'utf8'));
  assert.equal(backupReceipt.backupRelativePath, 'upgrade-readiness/backups/redman-pre-hardened-2026-07-18T08-00-00-000Z.db');
  assert.match(backupReceipt.sha256, /^[a-f0-9]{64}$/);

  assessment = assessUpgradeReadiness(database, { dataDir: fixture });
  assert.equal(assessment.applicationBackup.status, 'ready');
  assert.equal(assessment.summary.blocked, 0);

  const originalBackup = readFileSync(backup.backupPath);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(backup.backupPath, 'corrupt');
  assessment = assessUpgradeReadiness(database, { dataDir: fixture });
  assert.equal(assessment.applicationBackup.status, 'invalid');
  writeFileSync(backup.backupPath, originalBackup);

  database.prepare("INSERT INTO backup_runs VALUES (1, 'running')").run();
  await assert.rejects(
    createUpgradeBackup(database, { dataDir: fixture }),
    error => error.status === 409 && /active job/.test(error.message),
  );
  database.prepare('DELETE FROM backup_runs').run();

  const linuxPlan = createHostPreparationPlan({
    platform: 'linux',
    container: 'redman',
    dataDir: '/srv/redman',
    backupRoots: ['/srv/redman-backups', '/media/photos'],
  });
  assert.match(linuxPlan.command, /sudo bash/);
  assert.match(linuxPlan.command, /--backup-root.*redman-backups/);
  assert.match(linuxPlan.command, /raw\.githubusercontent\.com\/Rediwed\/RedMan\/v1\.1\.3\/scripts/);
  assert.match(linuxPlan.command, /sha256sum -c/);
  assert.match(linuxPlan.command, /mktemp -d/);
  assert.doesNotMatch(linuxPlan.command, /docker cp/);
  const unraidPlan = createHostPreparationPlan({
    platform: 'unraid',
    dataDir: '/mnt/user/appdata/redman',
    backupRoots: ['/mnt/user/backups'],
  });
  assert.doesNotMatch(unraidPlan.command, /sudo bash/);
  assert.throws(() => createHostPreparationPlan({
    platform: 'linux',
    dataDir: "/srv/redman'; touch /tmp/injected; #",
    backupRoots: ['/srv/backups'],
  }), /shell characters/);
  assert.throws(() => createHostPreparationPlan({
    platform: 'linux',
    dataDir: '/srv/redman',
    backupRoots: ['/srv/backups/../etc'],
  }), /traversal/);
  assert.throws(() => createHostPreparationPlan({
    platform: 'linux',
    dataDir: '/srv/redman',
    backupRoots: ['/srv/backup with space'],
  }), /shell characters/);

  const config = createFinalConfiguration({
    authMode: 'proxy',
    publicOrigin: 'https://redman.example.com',
    trustedProxy: '172.20.0.5',
    peerHost: '192.168.50.20',
    dataPath: '/srv/redman',
    storagePath: '/srv/redman-backups',
    mediaPath: '/media',
    dockerMonitoring: true,
  });
  assert.match(config.env, /TRUSTED_PROXIES=172\.20\.0\.5\/32/);
  assert.match(config.env, /DOCKER_CONTROL_HOST=http:\/\/docker-control-proxy:2375/);
  assert.doesNotMatch(config.env, /password|api.key/i);
  assert.throws(() => createFinalConfiguration({
    authMode: 'proxy',
    publicOrigin: 'http://redman.example.com',
  }), /HTTPS/);
  assert.throws(() => createFinalConfiguration({
    authMode: 'proxy', publicOrigin: 'https://redman.example.com',
    trustedProxy: '999.20.0.5', peerHost: '192.168.50.20',
    dataPath: '/srv/redman', storagePath: '/srv/backups', mediaPath: '/media',
  }), /exact IPv4 or IPv6/);
  assert.throws(() => createFinalConfiguration({
    authMode: 'proxy', publicOrigin: 'https://redman.example.com',
    trustedProxy: '172.20.0.5/24', peerHost: '192.168.50.20',
    dataPath: '/srv/redman', storagePath: '/srv/backups', mediaPath: '/media',
  }), /exact IPv4 or IPv6/);
  assert.throws(() => createFinalConfiguration({
    authMode: 'proxy', publicOrigin: 'https://redman.example.com',
    trustedProxy: '172.20.0.5', peerHost: '8.8.8.8',
    dataPath: '/srv/redman', storagePath: '/srv/backups', mediaPath: '/media',
  }), /private IP/);
  assert.throws(() => createFinalConfiguration({
    authMode: 'proxy', publicOrigin: 'https://redman.example.com',
    trustedProxy: '172.20.0.5', peerHost: '192.168.50.20',
    dataPath: '/mnt/user/appdata/redman', storagePath: '/mnt/user', mediaPath: '/mnt/disks',
  }), /explicit confirmation/);
  const broadConfig = createFinalConfiguration({
    authMode: 'proxy', publicOrigin: 'https://redman.example.com',
    trustedProxy: '172.20.0.5', peerHost: '192.168.50.20',
    dataPath: '/mnt/user/appdata/redman', storagePath: '/mnt/user', mediaPath: '/mnt/disks',
    allowBroadStorage: true,
  });
  assert.equal(broadConfig.broadStorageConfirmed, true);
  for (const equivalent of ['/mnt/user//', '/mnt//user', '/mnt/user/.']) {
    assert.throws(() => createFinalConfiguration({
      authMode: 'proxy', publicOrigin: 'https://redman.example.com',
      trustedProxy: '172.20.0.5', peerHost: '192.168.50.20',
      dataPath: '/mnt/user/appdata/redman', storagePath: equivalent, mediaPath: '/mnt/disks',
    }), /explicit confirmation/);
  }
  for (const field of ['dataPath', 'mediaPath']) {
    assert.throws(() => createFinalConfiguration({
      authMode: 'proxy', publicOrigin: 'https://redman.example.com',
      trustedProxy: '172.20.0.5', peerHost: '192.168.50.20',
      dataPath: '/mnt/user/appdata/redman', storagePath: '/mnt/user/backups', mediaPath: '/mnt/disks',
      [field]: '/mnt//user', allowBroadStorage: true,
    }), /may not authorize every Unraid user share/);
  }
  assert.throws(() => createFinalConfiguration({
    authMode: 'proxy', publicOrigin: '', trustedProxy: '172.20.0.5', peerHost: '192.168.50.20',
    dataPath: '/srv/redman', storagePath: '/srv/backups', mediaPath: '/media',
  }), /HTTPS/);

  console.log('Upgrade readiness: assessment, backup, host plan, injection rejection, and final config passed');
} finally {
  database.close();
  rmSync(fixture, { recursive: true, force: true });
}

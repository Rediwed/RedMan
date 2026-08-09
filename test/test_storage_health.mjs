// Whether a destination is safe to write to is the question this feature
// exists to answer. Getting it wrong in the reassuring direction is worse than
// not asking, so these fix the cases where that could happen.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'redman-storage-'));
process.env.DB_PATH = join(root, 'redman.db');

const { describeDestination, getStorageHealth, listPoolHealth, reportPath } =
  await import('../app/backend/src/services/storageHealth.js');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

const disk = (device, state, extra = {}) => ({
  device, state, model: 'TEST', reason: extra.reason || null, stale: false, ...extra,
});

// A fresh mtime each time, so the module's mtime-keyed cache never serves a
// previous scenario's report.
let tick = 0;
function writeReport(report) {
  const file = reportPath();
  writeFileSync(file, JSON.stringify({
    schema: 1,
    generatedAt: new Date().toISOString(),
    host: 'testhost',
    devices: [],
    pools: [],
    shares: [],
    ...report,
  }));
  tick += 1;
  const when = new Date(Date.now() + tick * 1000);
  utimesSync(file, when, when);
}

const MIRROR = {
  devices: [disk('/dev/sda', 'ok'), disk('/dev/sdb', 'ok')],
  pools: [{ mount: '/mnt/slow', dataProfile: 'RAID1', redundant: true, members: ['/dev/sda', '/dev/sdb'], state: 'ok' }],
  shares: [{ name: 'cross-site', path: '/mnt/user/cross-site', pool: '/mnt/slow', pinned: true, configured: true }],
};

check('a missing report is not a healthy destination', () => {
  rmSync(reportPath(), { force: true });
  const health = getStorageHealth();
  assert.equal(health.available, false);
  assert.match(health.reason, /has not reported/i);

  const destination = describeDestination('/mnt/user/cross-site');
  assert.equal(destination.state, 'unknown');
  assert.notEqual(destination.state, 'ok');
});

check('a union path is traced through its share to the pool that holds it', () => {
  writeReport(MIRROR);
  const destination = describeDestination('/mnt/user/cross-site/nightly');
  assert.equal(destination.pool, '/mnt/slow');
  assert.equal(destination.profile, 'RAID1');
  assert.equal(destination.redundant, true);
  assert.equal(destination.state, 'ok');
  assert.equal(destination.devices.length, 2);
});

check('a pool path resolves without needing a share at all', () => {
  writeReport(MIRROR);
  assert.equal(describeDestination('/mnt/slow/cross-site').pool, '/mnt/slow');
});

check('a failing disk under a mirror is survivable, and says so', () => {
  writeReport({
    ...MIRROR,
    devices: [disk('/dev/sda', 'fail', { reason: 'the drive reports its own SMART health as failed' }), disk('/dev/sdb', 'ok')],
    pools: [{ ...MIRROR.pools[0], state: 'warn' }],
  });
  const destination = describeDestination('/mnt/user/cross-site');
  assert.equal(destination.state, 'warn');
  assert.match(destination.reason, /second copy/i);
});

check('the same failing disk without redundancy is not safe to write to', () => {
  writeReport({
    devices: [disk('/dev/nvme0n1', 'fail')],
    pools: [{ mount: '/mnt/fast', dataProfile: 'single', redundant: false, members: ['/dev/nvme0n1'], state: 'fail' }],
    shares: [{ name: 'ssd-backup', path: '/mnt/user/ssd-backup', pool: '/mnt/fast', pinned: true, configured: true }],
  });
  const destination = describeDestination('/mnt/user/ssd-backup');
  assert.equal(destination.state, 'fail');
  assert.match(destination.reason, /no redundancy/i);
});

check('a destination nothing pins is a warning even while every disk is fine', () => {
  writeReport({
    ...MIRROR,
    shares: [{ name: 'new-share', path: '/mnt/user/new-share', pool: '/mnt/slow', pinned: false, configured: false }],
  });
  const destination = describeDestination('/mnt/user/new-share');
  assert.equal(destination.state, 'warn');
  assert.match(destination.spill, /less protected/i);
});

check('a reading old enough to have been overtaken stops counting as current', () => {
  writeReport({
    ...MIRROR,
    generatedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
  });
  const health = getStorageHealth();
  assert.equal(health.stale, true);
  assert.equal(describeDestination('/mnt/user/cross-site').state, 'unknown');
});

check('a destination that traces to no pool is unknown rather than assumed fine', () => {
  writeReport(MIRROR);
  const destination = describeDestination('/somewhere/else');
  assert.equal(destination.state, 'unknown');
  assert.match(destination.reason, /could not be traced/i);
});

check('a corrupt report is refused instead of half-read', () => {
  writeFileSync(reportPath(), '{ this is not json');
  const when = new Date(Date.now() + 60_000);
  utimesSync(reportPath(), when, when);
  const health = getStorageHealth();
  assert.equal(health.available, false);
  assert.match(health.reason, /could not be read/i);
  assert.equal(describeDestination('/mnt/user/cross-site').state, 'unknown');
});

check('pools are listed worst first, so the one needing you is on top', () => {
  writeReport({
    devices: [disk('/dev/sda', 'ok'), disk('/dev/sdb', 'fail')],
    pools: [
      { mount: '/mnt/healthy', dataProfile: 'RAID1', redundant: true, members: ['/dev/sda'], state: 'ok' },
      { mount: '/mnt/broken', dataProfile: 'single', redundant: false, members: ['/dev/sdb'], state: 'fail' },
    ],
  });
  const listed = listPoolHealth();
  assert.equal(listed.available, true);
  assert.deepEqual(listed.pools.map(p => p.mount), ['/mnt/broken', '/mnt/healthy']);
});

check('a host without the collector reports nothing rather than a false alarm', () => {
  rmSync(reportPath(), { force: true });
  const listed = listPoolHealth();
  assert.equal(listed.available, false);
  assert.deepEqual(listed.pools, []);
});

rmSync(root, { recursive: true, force: true });
console.log(`\n${passed} storage health checks passed`);

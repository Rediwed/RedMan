// Refusing a backup is itself a risk, so the line between refusing and
// allowing has to be exactly where it was argued to be: on evidence of an
// unsafe destination, never on the absence of evidence.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'redman-enforce-'));
process.env.DB_PATH = join(root, 'redman.db');

const db = (await import('../app/backend/src/db.js')).default;
const { describeDestination, reportPath } =
  await import('../app/backend/src/services/storageHealth.js');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

let tick = 0;
function writeReport(report) {
  writeFileSync(reportPath(), JSON.stringify({
    schema: 1,
    generatedAt: new Date().toISOString(),
    host: 'peer',
    devices: [],
    pools: [],
    shares: [],
    ...report,
  }));
  tick += 1;
  const when = new Date(Date.now() + tick * 1000);
  utimesSync(reportPath(), when, when);
}

// Mirrors the decision the peer makes in /peer/backup/prepare, so the rule can
// be asserted without standing up an authenticated peer API.
function decide(destinationPath) {
  const destination = describeDestination(destinationPath);
  const enforcement = db.prepare('SELECT value FROM settings WHERE key = ?')
    .get('destination_health_enforcement')?.value;
  if (destination.state === 'fail' && enforcement !== 'warn') {
    return { accepted: false, reason: destination.reason };
  }
  return { accepted: true, state: destination.state, reason: destination.reason };
}

function setEnforcement(value) {
  db.prepare(`INSERT INTO settings (key, value) VALUES ('destination_health_enforcement', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(value);
}

const FAILING_SINGLE = {
  devices: [{ device: '/dev/nvme0n1', state: 'fail', model: 'T', reason: 'the drive reports its own SMART health as failed', stale: false }],
  pools: [{ mount: '/mnt/fast', dataProfile: 'single', redundant: false, members: ['/dev/nvme0n1'], state: 'fail' }],
  shares: [{ name: 'cross-site', path: '/mnt/user/cross-site', pool: '/mnt/fast', pinned: true, configured: true }],
};

const FAILING_MIRROR = {
  devices: [
    { device: '/dev/sda', state: 'fail', model: 'T', reason: 'failed', stale: false },
    { device: '/dev/sdb', state: 'ok', model: 'T', reason: null, stale: false },
  ],
  pools: [{ mount: '/mnt/slow', dataProfile: 'RAID1', redundant: true, members: ['/dev/sda', '/dev/sdb'], state: 'warn' }],
  shares: [{ name: 'cross-site', path: '/mnt/user/cross-site', pool: '/mnt/slow', pinned: true, configured: true }],
};

check('a dying destination without redundancy is refused', () => {
  setEnforcement('refuse');
  writeReport(FAILING_SINGLE);
  const decision = decide('/mnt/user/cross-site');
  assert.equal(decision.accepted, false);
  assert.match(decision.reason, /no redundancy/i);
});

check('the same disk under a mirror is accepted, because the copy survives', () => {
  setEnforcement('refuse');
  writeReport(FAILING_MIRROR);
  const decision = decide('/mnt/user/cross-site');
  assert.equal(decision.accepted, true);
  assert.equal(decision.state, 'warn');
});

check('a host that never installed the collector keeps working exactly as before', () => {
  setEnforcement('refuse');
  rmSync(reportPath(), { force: true });
  const decision = decide('/mnt/user/cross-site');
  assert.equal(decision.accepted, true, 'no report must never mean no backup');
  assert.equal(decision.state, 'unknown');
});

check('a destination that cannot be traced to a pool is still accepted', () => {
  setEnforcement('refuse');
  writeReport(FAILING_MIRROR);
  const decision = decide('/somewhere/unmapped');
  assert.equal(decision.accepted, true);
  assert.equal(decision.state, 'unknown');
});

check('a reading that was already bad stays bad when it goes stale, and says so', () => {
  setEnforcement('refuse');
  writeReport({ ...FAILING_SINGLE, generatedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString() });
  const decision = decide('/mnt/user/cross-site');
  assert.equal(decision.accepted, false, 'a failing disk does not heal by being unobserved');
  assert.match(decision.reason, /not reported since|not reported recently/i);
});

check('a healthy reading that goes stale is no longer treated as current', () => {
  setEnforcement('refuse');
  writeReport({
    devices: [{ device: '/dev/sda', state: 'ok', model: 'T', reason: null, stale: false }],
    pools: [{ mount: '/mnt/slow', dataProfile: 'RAID1', redundant: true, members: ['/dev/sda'], state: 'ok' }],
    shares: [{ name: 'cross-site', path: '/mnt/user/cross-site', pool: '/mnt/slow', pinned: true, configured: true }],
    generatedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
  });
  const decision = decide('/mnt/user/cross-site');
  assert.equal(decision.accepted, true);
  assert.equal(decision.state, 'unknown', 'an old all-clear is not an all-clear');
});

check('the refusal can be turned down to a warning without touching the checks', () => {
  setEnforcement('warn');
  writeReport(FAILING_SINGLE);
  const decision = decide('/mnt/user/cross-site');
  assert.equal(decision.accepted, true);
  assert.equal(decision.state, 'fail', 'still reported as failing, just no longer enforced');
});

check('refusing is the default when nothing was configured', () => {
  db.prepare("DELETE FROM settings WHERE key = 'destination_health_enforcement'").run();
  writeReport(FAILING_SINGLE);
  assert.equal(decide('/mnt/user/cross-site').accepted, false);
});

const { validateSettingsUpdates } = await import('../app/backend/src/services/settingsPolicy.js');

check('anything other than an explicit warn is normalised to refusing', () => {
  assert.equal(validateSettingsUpdates({ destination_health_enforcement: 'warn' }).destination_health_enforcement, 'warn');
  for (const attempt of ['refuse', 'off', 'no', '', 'true', 'disabled']) {
    assert.equal(
      validateSettingsUpdates({ destination_health_enforcement: attempt }).destination_health_enforcement,
      'refuse',
      `"${attempt}" must not silently switch enforcement off`,
    );
  }
});

rmSync(root, { recursive: true, force: true });
console.log(`\n${passed} destination enforcement checks passed`);

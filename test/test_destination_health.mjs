// The asking side. A destination that says nothing must never read as a
// destination that is fine, because that is precisely the case this exists to
// catch: the peer is gone, or too old to answer, and the backup keeps running.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'redman-dest-'));
process.env.DB_PATH = join(root, 'redman.db');
process.env.PEER_SECRET_KEY = 'a'.repeat(64);

const db = (await import('../app/backend/src/db.js')).default;
const { encryptPeerApiKey } = await import('../app/backend/src/services/peerSecrets.js');
const { getDestinationHealth, clearDestinationHealthCache } =
  await import('../app/backend/src/services/destinationHealth.js');

let passed = 0;
// Awaited: a check that reports success before it asserts is worse than no test.
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

function addDestination(url, name) {
  db.prepare(`
    INSERT INTO pairing_requests (direction, status, token, remote_url, remote_instance, api_key_encrypted, created_at, updated_at)
    VALUES ('outgoing', 'accepted', ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(`token-${url}`, url, name, encryptPeerApiKey('test-key'));
}

const realFetch = globalThis.fetch;
function respondWith(handler) {
  globalThis.fetch = async (url, options) => handler(String(url), options);
}

addDestination('http://10.10.0.9:8091', 'Elsewhere');

await check('a destination that has not been asked yet is unknown, not healthy', () => {
  clearDestinationHealthCache();
  respondWith(async () => { throw new Error('should not be awaited synchronously'); });
  const [destination] = getDestinationHealth();
  assert.equal(destination.state, 'unknown');
  assert.match(destination.reason, /not been asked yet/i);
});

await check('the answer is remembered once the peer has given one', async () => {
  clearDestinationHealthCache();
  respondWith(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      prefix: '/mnt/user/cross-site',
      usedBytes: 1024,
      limitBytes: 0,
      destination: {
        state: 'ok',
        reason: 'all disks healthy, and RAID1 survives losing one',
        profile: 'RAID1',
        redundant: true,
        diskCount: 2,
        disksNeedingAttention: 0,
        measuredAt: new Date().toISOString(),
        stale: false,
      },
    }),
  }));

  getDestinationHealth();
  await new Promise(resolve => setTimeout(resolve, 50));
  const [destination] = getDestinationHealth();
  assert.equal(destination.state, 'ok');
  assert.equal(destination.profile, 'RAID1');
  assert.equal(destination.redundant, true);
});

await check('a peer too old to know about disks is unknown, never a failure of its disks', async () => {
  clearDestinationHealthCache();
  respondWith(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ prefix: '/mnt/user/cross-site', usedBytes: 0, limitBytes: 0 }),
  }));

  getDestinationHealth();
  await new Promise(resolve => setTimeout(resolve, 50));
  const [destination] = getDestinationHealth();
  assert.equal(destination.state, 'unknown');
  assert.match(destination.reason, /does not report disk health yet/i);
  assert.notEqual(destination.state, 'fail');
});

await check('a destination that cannot be reached is unknown rather than assumed fine', async () => {
  clearDestinationHealthCache();
  respondWith(async () => { throw new Error('ECONNREFUSED'); });

  getDestinationHealth();
  await new Promise(resolve => setTimeout(resolve, 50));
  const [destination] = getDestinationHealth();
  assert.equal(destination.state, 'unknown');
  assert.match(destination.reason, /could not be reached/i);
});

await check('a rejected credential does not read as a disk problem', async () => {
  clearDestinationHealthCache();
  respondWith(async () => ({ ok: false, status: 401, json: async () => ({}) }));

  getDestinationHealth();
  await new Promise(resolve => setTimeout(resolve, 50));
  const [destination] = getDestinationHealth();
  assert.equal(destination.state, 'unknown');
  assert.match(destination.reason, /HTTP 401/);
});

await check('a failing destination is passed through exactly as the peer stated it', async () => {
  clearDestinationHealthCache();
  respondWith(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      prefix: '/mnt/user/ssd-backup',
      destination: {
        state: 'fail',
        reason: 'the only disk behind this destination is failing, and it has no redundancy to fall back on',
        profile: 'single',
        redundant: false,
        diskCount: 1,
        disksNeedingAttention: 1,
        stale: false,
      },
    }),
  }));

  getDestinationHealth();
  await new Promise(resolve => setTimeout(resolve, 50));
  const [destination] = getDestinationHealth();
  assert.equal(destination.state, 'fail');
  assert.equal(destination.redundant, false);
  assert.match(destination.reason, /no redundancy/i);
});

await check('asking does not happen on every call, so a board poll cannot flood a peer', async () => {
  clearDestinationHealthCache();
  let asked = 0;
  respondWith(async () => {
    asked += 1;
    return { ok: true, status: 200, json: async () => ({ destination: { state: 'ok', reason: 'fine' } }) };
  });

  getDestinationHealth();
  await new Promise(resolve => setTimeout(resolve, 50));
  for (let i = 0; i < 20; i += 1) getDestinationHealth();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(asked, 1, `expected one request, made ${asked}`);
});

await check('an answer already in the air when pairing changes does not land afterwards', async () => {
  clearDestinationHealthCache();
  let release;
  const held = new Promise(resolve => { release = resolve; });
  respondWith(async () => {
    await held;
    return {
      ok: true,
      status: 200,
      json: async () => ({ destination: { state: 'ok', reason: 'from before the change', diskCount: 2 } }),
    };
  });

  getDestinationHealth();
  // The pairing changed while that request was still outstanding.
  clearDestinationHealthCache();
  release();
  await new Promise(resolve => setTimeout(resolve, 50));

  respondWith(async () => { throw new Error('not asked again in this test'); });
  const [destination] = getDestinationHealth();
  assert.notEqual(destination.reason, 'from before the change');
  assert.equal(destination.state, 'unknown');
});

await check('reporting status survives the database closing under it', () => {
  db.close();
  const destinations = getDestinationHealth();
  assert.deepEqual(destinations, []);
});

globalThis.fetch = realFetch;
rmSync(root, { recursive: true, force: true });
console.log(`\n${passed} destination health checks passed`);

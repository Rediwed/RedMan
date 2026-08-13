// A retry is only correct for failures that mean "ask again later". A refused
// backup — quota exceeded, a destination known to be dying, a rejected key — is
// a decision, and asking again wastes the peer's time and buries the reason.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'redman-retry-'));
process.env.DB_PATH = join(root, 'redman.db');
process.env.PEER_SECRET_KEY = 'a'.repeat(64);

const { callPeerApiForTests } = await import('../app/backend/src/services/hyperBackup.js');

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

const realFetch = globalThis.fetch;
const PEER = 'http://10.10.0.9:8091';

// Every attempt is counted, so a test cannot pass by never calling at all.
function respondWith(handlers) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const handler = handlers[calls.length] ?? handlers[handlers.length - 1];
    calls.push({ url: String(url), method: options?.method });
    if (typeof handler === 'function') return handler();
    return handler;
  };
  return calls;
}

const ok = body => ({ ok: true, status: 200, json: async () => body });
const httpError = (status, error) => ({ ok: false, status, json: async () => ({ error }) });
const networkFailure = code => () => {
  const err = new Error(`fetch failed`);
  err.cause = { code };
  throw err;
};

// Attempts are spaced out in production; here they must not be, or the suite
// would spend a minute proving something that takes milliseconds.
const FAST = { attempts: 3, backoffMs: 1 };

await check('a timeout is tried again and the second attempt is believed', async () => {
  const calls = respondWith([networkFailure('UND_ERR_CONNECT_TIMEOUT'), ok({ ok: true, path: '/mnt/x' })]);
  const result = await callPeerApiForTests(PEER, 'key', 'POST', '/peer/backup/prepare', {}, FAST);
  assert.equal(result.path, '/mnt/x');
  assert.equal(calls.length, 2, 'it should have asked twice');
});

await check('a peer that never answers gives up rather than retrying forever', async () => {
  const calls = respondWith([networkFailure('ECONNREFUSED')]);
  await assert.rejects(
    () => callPeerApiForTests(PEER, 'key', 'POST', '/peer/backup/prepare', {}, FAST),
    /connection refused/i,
  );
  assert.equal(calls.length, 3, 'exactly the configured number of attempts');
});

await check('a refused destination is not asked a second time', async () => {
  const calls = respondWith([httpError(409, 'Refusing to write here: the only disk behind this destination is failing')]);
  await assert.rejects(
    () => callPeerApiForTests(PEER, 'key', 'POST', '/peer/backup/prepare', {}, FAST),
    /Refusing to write here/,
  );
  assert.equal(calls.length, 1, 'a decision does not change by asking again');
});

await check('an exceeded quota is not asked a second time', async () => {
  const calls = respondWith([httpError(507, 'Storage quota exceeded: using 900 GB of 900 GB allowed')]);
  await assert.rejects(
    () => callPeerApiForTests(PEER, 'key', 'POST', '/peer/backup/prepare', {}, FAST),
    /quota exceeded/i,
  );
  assert.equal(calls.length, 1);
});

await check('a rejected key is not hammered', async () => {
  const calls = respondWith([httpError(401, 'nope')]);
  await assert.rejects(
    () => callPeerApiForTests(PEER, 'key', 'POST', '/peer/backup/prepare', {}, FAST),
    /Authentication failed/,
  );
  assert.equal(calls.length, 1, 'retrying a rejected credential locks accounts, it does not fix them');
});

await check('a peer that is restarting behind a gateway is tried again', async () => {
  const calls = respondWith([httpError(503, 'unavailable'), ok({ ok: true })]);
  const result = await callPeerApiForTests(PEER, 'key', 'POST', '/peer/backup/prepare', {}, FAST);
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
});

await check('the caller is told about every retry, so recovery is not silent', async () => {
  const seen = [];
  respondWith([networkFailure('ECONNRESET'), networkFailure('ECONNRESET'), ok({ ok: true })]);
  await callPeerApiForTests(PEER, 'key', 'POST', '/peer/backup/prepare', {}, {
    ...FAST,
    onRetry: info => seen.push(info),
  });
  assert.equal(seen.length, 2);
  assert.deepEqual(seen.map(s => s.attempt), [1, 2]);
  assert.match(seen[0].message, /was reset/i);
});

await check('waiting longer each time, so a struggling peer is not stampeded', async () => {
  const waits = [];
  respondWith([networkFailure('ETIMEDOUT'), networkFailure('ETIMEDOUT'), ok({ ok: true })]);
  await callPeerApiForTests(PEER, 'key', 'POST', '/peer/backup/prepare', {}, {
    attempts: 3,
    backoffMs: 10,
    onRetry: info => waits.push(info.waitMs),
  });
  assert.deepEqual(waits, [10, 30], 'each wait is three times the last');
});

await check('retrying can be switched off where waiting would be wrong', async () => {
  const calls = respondWith([networkFailure('ECONNREFUSED')]);
  await assert.rejects(
    () => callPeerApiForTests(PEER, 'key', 'POST', '/peer/shutdown', {}, { attempts: 1 }),
    /connection refused/i,
  );
  assert.equal(calls.length, 1, 'shutdown must not wait on a peer going down with us');
});

globalThis.fetch = realFetch;
rmSync(root, { recursive: true, force: true });
console.log(`\n${passed} peer retry checks passed`);

import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { getQuotaUsage, invalidateQuotaUsage, markQuotaUsageStale } from '../app/backend/src/services/quotaUsage.js';

const fixture = resolve(import.meta.dirname, 'data', `quota-usage-${process.pid}`);
mkdirSync(fixture, { recursive: true });
writeFileSync(resolve(fixture, 'payload.bin'), Buffer.alloc(4096));

try {
  const first = await getQuotaUsage(fixture);
  assert.equal(first.cached, false);
  assert.ok(first.usedBytes >= 4096);

  writeFileSync(resolve(fixture, 'payload.bin'), Buffer.alloc(16384));
  const cached = await getQuotaUsage(fixture);
  assert.equal(cached.cached, true);
  assert.equal(cached.usedBytes, first.usedBytes);

  invalidateQuotaUsage(fixture);
  const refreshed = await getQuotaUsage(fixture);
  assert.equal(refreshed.cached, false);
  assert.ok(refreshed.usedBytes > first.usedBytes);
  console.log('Quota usage cache: reuse and invalidation passed');

  // ── A caller is never made to wait for a slow scan ──
  // A real fixture is measured in milliseconds, which would leave the slow path
  // untested, so du is replaced with one that deliberately takes its time.
  const shim = resolve(fixture, 'bin');
  mkdirSync(shim, { recursive: true });
  writeFileSync(resolve(shim, 'du'), '#!/bin/sh\nsleep 2\necho "8192\t$2"\n');
  chmodSync(resolve(shim, 'du'), 0o755);
  const realPath = process.env.PATH;
  process.env.PATH = `${shim}:${realPath}`;
  try {
    invalidateQuotaUsage(fixture);
    const started = Date.now();
    const impatient = await getQuotaUsage(fixture, { firstWaitMs: 100, timeoutMs: 60_000 });
    const waited = Date.now() - started;
    assert.ok(waited < 1_500, `caller waited ${waited} ms for a 2 s scan despite a 100 ms budget`);
    assert.equal(impatient.usedBytes, null);
    assert.match(impatient.unavailableReason, /still running/);

    // The scan was not killed along with the caller: it keeps going and fills
    // the cache. Killing it at the caller's deadline, as this used to do, meant
    // a directory slower than that deadline could never be measured at all.
    await setTimeout(2_500);
    const afterwards = await getQuotaUsage(fixture, { firstWaitMs: 100 });
    assert.equal(afterwards.cached, true, 'the abandoned scan never populated the cache');
    assert.equal(afterwards.usedBytes, 8192 * 1024);
  } finally {
    process.env.PATH = realPath;
    invalidateQuotaUsage(fixture);
  }

  // ── An old figure is served at once, and refreshed behind the caller ──
  // The lower bound on maxAgeMs is one second, so the entry has to genuinely
  // age rather than be declared stale by passing a tiny number.
  invalidateQuotaUsage(fixture);
  await getQuotaUsage(fixture);
  writeFileSync(resolve(fixture, 'payload.bin'), Buffer.alloc(65536));
  await setTimeout(1_200);
  const stale = await getQuotaUsage(fixture, { maxAgeMs: 1_000 });
  assert.equal(stale.cached, true);
  assert.equal(stale.stale, true, 'an expired figure was not reported as stale');
  assert.ok(stale.usedBytes !== null, 'an expired figure was discarded instead of served');
  assert.ok(stale.ageMs >= 1_000, `ageMs was ${stale.ageMs}`);

  // The refresh it triggered lands without anyone waiting for it.
  await setTimeout(1_500);
  const settled = await getQuotaUsage(fixture);
  assert.ok(settled.usedBytes > stale.usedBytes, 'the background refresh never landed');
  console.log('Quota usage: a slow scan never blocks a caller, and a stale figure is still served');

  // ── A finished backup may force a re-measure, but not erase the evidence ──
  // The peer that reports its backup finished is the same party the quota is
  // meant to restrain. If that report could forget the measurement, the peer
  // would arrive at every quota check with nothing on record and walk straight
  // through the fail-open path.
  invalidateQuotaUsage(fixture);
  const measured = await getQuotaUsage(fixture);
  assert.ok(measured.usedBytes > 0);
  markQuotaUsageStale(fixture);
  const afterComplete = await getQuotaUsage(fixture);
  assert.ok(
    afterComplete.usedBytes !== null,
    'reporting a finished backup erased the figure the quota is enforced from',
  );
  assert.equal(afterComplete.stale, true, 'the entry was not marked for re-measurement');

  // ── A blank environment variable means unset, not zero ──
  // Number('') is 0, which clamps to the lowest allowed wait. With a scan that
  // takes longer than that floor the usage would look unknown, so a
  // declared-but-empty variable in a compose file must not quietly select the
  // most permissive behaviour. The scan has to outlast the floor for this to
  // measure anything, hence the deliberate delay.
  //
  // This uses a path of its own: a refresh started by an earlier assertion can
  // still be in flight, and a second caller joins that running scan rather than
  // starting one, which would answer quickly no matter what the wait was set to
  // and quietly prove nothing.
  const blankDir = `${fixture}-blank`;
  const slowShim = resolve(blankDir, 'bin');
  mkdirSync(slowShim, { recursive: true });
  writeFileSync(resolve(slowShim, 'du'), '#!/bin/sh\nsleep 0.6\necho "4096\t$2"\n');
  chmodSync(resolve(slowShim, 'du'), 0o755);
  const previousWait = process.env.PEER_QUOTA_FIRST_WAIT_MS;
  const pathBefore = process.env.PATH;
  process.env.PATH = `${slowShim}:${pathBefore}`;
  process.env.PEER_QUOTA_FIRST_WAIT_MS = '';
  try {
    const blank = await getQuotaUsage(blankDir);
    assert.equal(
      blank.usedBytes,
      4096 * 1024,
      'an empty wait variable was read as zero and clamped to the shortest wait',
    );
  } finally {
    process.env.PATH = pathBefore;
    if (previousWait === undefined) delete process.env.PEER_QUOTA_FIRST_WAIT_MS;
    else process.env.PEER_QUOTA_FIRST_WAIT_MS = previousWait;
    invalidateQuotaUsage(blankDir);
    rmSync(blankDir, { recursive: true, force: true });
  }
  console.log('Quota usage: a finished backup cannot erase the figure, and a blank setting is not zero');
} finally {
  invalidateQuotaUsage();
  rmSync(fixture, { recursive: true, force: true });
}
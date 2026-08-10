import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The host writes what it measured; this reads it. RedMan cannot take the
// measurement itself without privileges that would cost more than the answer
// is worth, so the only job here is to read honestly and never overstate.

const REPORT_NAME = 'host-storage-health.json';

// A report older than this is still shown, but no longer presented as current.
// The collector is expected to run hourly; a whole day of silence means the
// collector itself has stopped, which is a different problem from a bad disk.
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

const SEVERITY = { fail: 3, warn: 2, unknown: 1, unsupported: 1, ok: 0 };

let cache = null;

function dataDirectory() {
  if (process.env.DB_PATH) return dirname(resolve(process.env.DB_PATH));
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
}

export function reportPath() {
  return join(dataDirectory(), REPORT_NAME);
}

/**
 * Reads the host's storage report.
 *
 * Never throws and never invents: a missing report means the collector has not
 * run, which is reported as exactly that rather than as healthy storage. The
 * file is re-read only when its modification time changes, so a status board
 * polling every few seconds does not re-parse it every time.
 */
export function getStorageHealth() {
  const file = reportPath();
  let stat;
  try {
    stat = statSync(file);
  } catch {
    cache = null;
    return {
      available: false,
      reason: 'the host has not reported its disk health yet',
      report: null,
      ageMs: null,
      stale: false,
    };
  }

  if (!cache || cache.mtimeMs !== stat.mtimeMs) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.pools)) {
        throw new Error('report has no pools');
      }
      cache = { mtimeMs: stat.mtimeMs, report: parsed };
    } catch (err) {
      cache = null;
      return {
        available: false,
        reason: `the host's disk health report could not be read: ${err.message}`,
        report: null,
        ageMs: null,
        stale: false,
      };
    }
  }

  const generatedAt = Date.parse(cache.report.generatedAt);
  const ageMs = Number.isFinite(generatedAt) ? Date.now() - generatedAt : null;
  return {
    available: true,
    reason: null,
    report: cache.report,
    ageMs,
    stale: ageMs !== null && ageMs > STALE_AFTER_MS,
  };
}

function poolFor(report, poolMount) {
  return report.pools.find(p => p.mount === poolMount) || null;
}

// Longest match wins, so /mnt/slow/cross-site resolves to /mnt/slow and not to
// some shorter mount that happens to be a prefix of it.
function poolContaining(report, path) {
  return report.pools
    .filter(p => path === p.mount || path.startsWith(`${p.mount}/`))
    .sort((a, b) => b.mount.length - a.mount.length)[0] || null;
}

function shareFor(report, path) {
  const shares = Array.isArray(report.shares) ? report.shares : [];
  return shares
    .filter(s => path === s.path || path.startsWith(`${s.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0] || null;
}

function worse(a, b) {
  return (SEVERITY[b] ?? 1) > (SEVERITY[a] ?? 1) ? b : a;
}

/**
 * Judges whether a destination is fit to be written to.
 *
 * Disk health alone does not answer that. The same failing drive is survivable
 * under a mirror and is data loss without one, so the verdict combines what the
 * drives report with how the pool is laid out. A destination whose health
 * cannot be established is reported as unknown, never as safe, and a health
 * that could not be measured is never the reason to refuse a backup.
 */
export function describeDestination(destinationPath) {
  const health = getStorageHealth();
  if (!health.available) {
    return { state: 'unknown', reason: health.reason, pool: null, devices: [], measuredAt: null, stale: false };
  }

  const { report } = health;
  const share = shareFor(report, destinationPath);
  const pool = share?.pool ? poolFor(report, share.pool) : poolContaining(report, destinationPath);

  if (!pool) {
    return {
      state: 'unknown',
      reason: 'this destination could not be traced back to a pool of disks',
      pool: null,
      devices: [],
      measuredAt: report.generatedAt,
      stale: health.stale,
    };
  }

  const devices = (report.devices || []).filter(d => (pool.members || []).includes(d.device));
  let state = pool.state || 'unknown';
  let reason;

  const failing = devices.filter(d => d.state === 'fail');
  const warning = devices.filter(d => d.state === 'warn');
  const unreadable = devices.filter(d => d.state === 'unknown' || d.state === 'unsupported');

  if (failing.length && !pool.redundant) {
    reason = `${failing.length === 1 ? 'the only disk' : 'a disk'} behind this destination is failing, and it has no redundancy to fall back on`;
  } else if (failing.length) {
    reason = `a disk behind this destination is failing, but ${pool.dataProfile} keeps a second copy`;
  } else if (warning.length) {
    reason = 'a disk behind this destination is showing early signs of wear';
  } else if (unreadable.length) {
    reason = 'the health of a disk behind this destination cannot be read';
  } else if (state === 'ok') {
    reason = pool.redundant
      ? `all disks healthy, and ${pool.dataProfile} survives losing one`
      : 'all disks healthy, but this destination has no redundancy';
  } else {
    reason = 'the health of this destination could not be established';
  }

  // A destination that nothing pins can move to a pool with less protection
  // than the one it is measured on, which the disks themselves cannot show.
  let spill = null;
  if (share && !share.pinned) {
    spill = 'nothing pins this destination to a pool, so new data can land somewhere less protected';
    state = worse(state, 'warn');
  }

  // A reading old enough to have been overtaken is not a reading to act on --
  // except when it was already bad, because disks do not recover on their own.
  // Saying how old it is keeps that judgement visible instead of implied.
  if (health.stale) {
    state = worse(state, 'unknown');
    const hours = health.ageMs ? Math.round(health.ageMs / 3_600_000) : null;
    reason = hours
      ? `${reason} (last measured ${hours} hours ago; the host has not reported since)`
      : `${reason} (the host has not reported recently)`;
  }

  return {
    state,
    reason,
    spill,
    pool: pool.mount,
    profile: pool.dataProfile,
    redundant: Boolean(pool.redundant),
    pinned: share ? share.pinned : null,
    devices: devices.map(d => ({
      device: d.device,
      model: d.model || null,
      state: d.state,
      reason: d.reason || null,
      stale: Boolean(d.stale),
    })),
    measuredAt: report.generatedAt,
    stale: health.stale,
    ageMs: health.ageMs,
  };
}

/** Every pool the host reported, worst first, for the status board. */export function listPoolHealth() {
  const health = getStorageHealth();
  if (!health.available) return { available: false, reason: health.reason, pools: [] };

  const { report } = health;
  const pools = report.pools.map(pool => {
    const devices = (report.devices || []).filter(d => (pool.members || []).includes(d.device));
    return {
      mount: pool.mount,
      profile: pool.dataProfile,
      redundant: Boolean(pool.redundant),
      state: health.stale ? worse(pool.state, 'unknown') : pool.state,
      devices,
    };
  });
  pools.sort((a, b) => (SEVERITY[b.state] ?? 1) - (SEVERITY[a.state] ?? 1));
  return { available: true, reason: null, pools, measuredAt: report.generatedAt, stale: health.stale };
}

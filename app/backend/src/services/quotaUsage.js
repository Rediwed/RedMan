import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const usageCache = new Map();
const pendingUsage = new Map();

function boundedNumber(value, fallback, minimum, maximum) {
  // An empty string is a declared-but-unset variable, not a zero. Reading it as
  // a number would clamp to the minimum and silently pick the most permissive
  // behaviour available, which is the opposite of what an operator who left the
  // value blank intended.
  if (value === '' || value === null || value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

/**
 * Starts a scan for a path, or joins the one already running. The promise
 * resolves with the result and never rejects, so a caller that walked away
 * cannot leave an unhandled rejection behind.
 */
function startScan(dirPath, timeoutMs) {
  const existing = pendingUsage.get(dirPath);
  if (existing) return existing;

  const scan = execFileAsync('du', ['-sk', dirPath], {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 1024,
  }).then(({ stdout }) => {
    const kilobytes = Number.parseInt(stdout.split(/\s+/)[0], 10);
    if (!Number.isFinite(kilobytes)) throw new Error('du returned an invalid size');
    const result = { usedBytes: kilobytes * 1024, unavailableReason: null };
    // Only when it was measured is recorded. Whether that is recent enough is
    // for the reader to decide, so a caller asking for a tighter age is not
    // answered from an entry that was written under a looser one.
    usageCache.set(dirPath, { result, measuredAt: Date.now() });
    return result;
  }).catch(err => ({
    usedBytes: null,
    unavailableReason: err.killed ? `usage scan exceeded ${timeoutMs} ms` : 'usage scan failed',
  })).finally(() => {
    pendingUsage.delete(dirPath);
  });

  pendingUsage.set(dirPath, scan);
  return scan;
}

/**
 * Reports how much space a directory occupies.
 *
 * Walking a backup target costs seconds and grows with the data, while the
 * answer it produces changes slowly. Two things follow from that, and together
 * they are why this is not a plain await around du.
 *
 * How long a caller waits is separate from how long the scan may run. A caller
 * with no figure at all waits only firstWaitMs and is then told the usage is
 * unavailable, but the scan keeps going and fills the cache, so the next caller
 * is served at once. Killing the scan at the caller's deadline, as this used to
 * do, meant a directory slower than that deadline could never be measured at
 * all: every request paid the full wait and none of them ever learned the
 * answer.
 *
 * A figure that is merely old is still worth having. Once the cache is warm the
 * caller is answered from it immediately and a refresh runs behind them, so a
 * scan is never again on the critical path of a backup. Staleness is reported
 * rather than hidden, so what to do with an old number stays the caller's
 * decision.
 */
export async function getQuotaUsage(dirPath, options = {}) {
  const maxAgeMs = boundedNumber(options.maxAgeMs, 600_000, 1_000, 86_400_000);
  const timeoutMs = boundedNumber(
    options.timeoutMs ?? process.env.PEER_QUOTA_DU_TIMEOUT_MS,
    120_000,
    1_000,
    600_000,
  );
  const firstWaitMs = boundedNumber(
    options.firstWaitMs ?? process.env.PEER_QUOTA_FIRST_WAIT_MS,
    5_000,
    100,
    60_000,
  );
  const now = Date.now();
  const cached = usageCache.get(dirPath);
  const ageMs = cached ? now - cached.measuredAt : null;

  if (cached && ageMs < maxAgeMs) {
    return { ...cached.result, cached: true, stale: false, ageMs };
  }

  if (cached) {
    // Refresh behind the caller: an old figure still answers the quota question
    // well enough, and waiting would only make a backup late.
    startScan(dirPath, timeoutMs);
    return { ...cached.result, cached: true, stale: true, ageMs };
  }

  // Nothing known yet, so there is no choice but to wait, but only briefly.
  const scan = startScan(dirPath, timeoutMs);
  let settled = null;
  let waitTimer = null;
  const finished = await Promise.race([
    scan.then(result => { settled = result; return result; }),
    new Promise(resolve => { waitTimer = setTimeout(() => resolve(null), firstWaitMs); }),
  ]);
  clearTimeout(waitTimer);

  if (finished && settled) {
    return { ...finished, cached: false, stale: false, ageMs: 0 };
  }

  return {
    usedBytes: null,
    unavailableReason: `usage scan still running after ${firstWaitMs} ms`,
    cached: false,
    stale: false,
    ageMs: null,
  };
}

export function invalidateQuotaUsage(dirPath = null) {
  if (dirPath) usageCache.delete(dirPath);
  else usageCache.clear();
}

/**
 * Marks a path as due for re-measurement while keeping the figure already
 * known.
 *
 * This exists because forgetting a measurement is not a safe thing to do on
 * request. The peer being measured is the same party that reports its backup
 * finished, so a plain invalidation there hands it a way to arrive at every
 * quota check with nothing on record. Keeping the last successful figure means
 * a quota is still enforced from it while the fresh scan runs, and a directory
 * that has grown too large to measure quickly cannot use that slowness to erase
 * the evidence of its own size.
 */
export function markQuotaUsageStale(dirPath = null) {
  if (dirPath) {
    const entry = usageCache.get(dirPath);
    if (entry) entry.measuredAt = 0;
    return;
  }
  for (const entry of usageCache.values()) entry.measuredAt = 0;
}
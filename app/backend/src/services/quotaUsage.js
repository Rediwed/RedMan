import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const usageCache = new Map();
const pendingUsage = new Map();

function boundedNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

export async function getQuotaUsage(dirPath, options = {}) {
  const now = Date.now();
  const cached = usageCache.get(dirPath);
  if (cached && cached.expiresAt > now) return { ...cached.result, cached: true };

  const pending = pendingUsage.get(dirPath);
  if (pending) return { ...await pending, cached: true };

  const maxAgeMs = boundedNumber(options.maxAgeMs, 30_000, 1_000, 300_000);
  const timeoutMs = boundedNumber(
    options.timeoutMs ?? process.env.PEER_QUOTA_DU_TIMEOUT_MS,
    5_000,
    1_000,
    30_000,
  );
  const request = execFileAsync('du', ['-sk', dirPath], {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 1024,
  }).then(({ stdout }) => {
    const kilobytes = Number.parseInt(stdout.split(/\s+/)[0], 10);
    if (!Number.isFinite(kilobytes)) throw new Error('du returned an invalid size');
    const result = { usedBytes: kilobytes * 1024, unavailableReason: null };
    usageCache.set(dirPath, { result, expiresAt: Date.now() + maxAgeMs });
    return result;
  }).catch(err => ({
    usedBytes: null,
    unavailableReason: err.killed ? `usage scan exceeded ${timeoutMs} ms` : 'usage scan failed',
  })).finally(() => {
    pendingUsage.delete(dirPath);
  });

  pendingUsage.set(dirPath, request);
  return { ...await request, cached: false };
}

export function invalidateQuotaUsage(dirPath = null) {
  if (dirPath) usageCache.delete(dirPath);
  else usageCache.clear();
}
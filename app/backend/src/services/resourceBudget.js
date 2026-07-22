import { readFileSync } from 'node:fs';
import os from 'node:os';

const DEFAULT_CGROUP_ROOT = '/sys/fs/cgroup';
const SAFE_MAX_DELTA_CONCURRENCY = 4;
const BYTES_PER_DELTA_WORKER = 512 * 1024 * 1024;

function readText(path, readFile = readFileSync) {
  try {
    return readFile(path, 'utf8').trim();
  } catch {
    return null;
  }
}

function finiteLimit(value) {
  if (!value || value === 'max') return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function currentUsage(value) {
  if (value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function cpuQuota(value) {
  if (!value) return null;
  const [quotaValue, periodValue] = value.split(/\s+/);
  if (quotaValue === 'max') return null;
  const quota = Number(quotaValue);
  const period = Number(periodValue);
  if (!Number.isFinite(quota) || !Number.isFinite(period) || quota <= 0 || period <= 0) return null;
  return Math.max(1, Math.floor(quota / period));
}

export function getRuntimeResourceBudget(options = {}) {
  const root = options.cgroupRoot || DEFAULT_CGROUP_ROOT;
  const readFile = options.readFile || readFileSync;
  const availableCpu = Math.max(1, Number(options.availableCpu || os.availableParallelism?.() || os.cpus().length || 1));
  const memoryMax = finiteLimit(readText(`${root}/memory.max`, readFile));
  const memoryCurrent = currentUsage(readText(`${root}/memory.current`, readFile));
  const pidsMax = finiteLimit(readText(`${root}/pids.max`, readFile));
  const pidsCurrent = currentUsage(readText(`${root}/pids.current`, readFile));
  const quotaCpu = cpuQuota(readText(`${root}/cpu.max`, readFile));
  const effectiveCpu = Math.max(1, Math.min(availableCpu, quotaCpu || availableCpu));
  const memoryHeadroom = memoryMax === null || memoryCurrent === null ? null : Math.max(0, memoryMax - memoryCurrent);
  const memoryWorkers = memoryMax !== null && memoryCurrent === null
    ? 1
    : memoryHeadroom === null ? 2 : Math.max(1, Math.floor(memoryHeadroom / BYTES_PER_DELTA_WORKER));
  const pidHeadroom = pidsMax === null || pidsCurrent === null ? null : Math.max(0, pidsMax - pidsCurrent);
  const pidWorkers = pidsMax !== null && pidsCurrent === null
    ? 1
    : pidHeadroom === null ? SAFE_MAX_DELTA_CONCURRENCY : Math.max(1, Math.floor(pidHeadroom / 8));
  const deltaConcurrency = Math.max(1, Math.min(
    SAFE_MAX_DELTA_CONCURRENCY,
    effectiveCpu,
    memoryWorkers,
    pidWorkers,
  ));

  return {
    cgroupVersion: readText(`${root}/cgroup.controllers`, readFile) === null ? 'unknown' : 2,
    memoryMax,
    memoryCurrent,
    memoryHeadroom,
    cpuQuota: quotaCpu,
    availableCpu,
    effectiveCpu,
    pidsMax,
    pidsCurrent,
    pidHeadroom,
    deltaConcurrency,
  };
}
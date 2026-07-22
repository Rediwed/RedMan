import assert from 'node:assert/strict';
import { getRuntimeResourceBudget } from '../app/backend/src/services/resourceBudget.js';

function fixture(values) {
  return getRuntimeResourceBudget({
    cgroupRoot: '/cg',
    availableCpu: 8,
    readFile(path) {
      const name = path.slice('/cg/'.length);
      if (!(name in values)) throw new Error('missing');
      return values[name];
    },
  });
}

const limited = fixture({
  'cgroup.controllers': 'cpu memory pids',
  'memory.max': String(1536 * 1024 * 1024),
  'memory.current': String(256 * 1024 * 1024),
  'cpu.max': '200000 100000',
  'pids.max': '256',
  'pids.current': '16',
});
assert.equal(limited.cgroupVersion, 2);
assert.equal(limited.effectiveCpu, 2);
assert.equal(limited.deltaConcurrency, 2);

const tightMemory = fixture({
  'cgroup.controllers': 'cpu memory pids',
  'memory.max': String(768 * 1024 * 1024),
  'memory.current': String(512 * 1024 * 1024),
  'cpu.max': '400000 100000',
  'pids.max': '128',
  'pids.current': '16',
});
assert.equal(tightMemory.deltaConcurrency, 1);

const unlimited = fixture({
  'cgroup.controllers': 'cpu memory pids',
  'memory.max': 'max',
  'memory.current': '1234',
  'cpu.max': 'max 100000',
  'pids.max': 'max',
  'pids.current': '10',
});
assert.equal(unlimited.memoryMax, null);
assert.equal(unlimited.deltaConcurrency, 2);

const unavailable = getRuntimeResourceBudget({ cgroupRoot: '/missing', availableCpu: 16, readFile() { throw new Error('missing'); } });
assert.equal(unavailable.cgroupVersion, 'unknown');
assert.equal(unavailable.deltaConcurrency, 2);

const partialMemory = fixture({
  'cgroup.controllers': 'cpu memory pids',
  'memory.max': String(4 * 1024 * 1024 * 1024),
  'cpu.max': '400000 100000',
  'pids.max': '512',
  'pids.current': '20',
});
assert.equal(partialMemory.memoryCurrent, null);
assert.equal(partialMemory.deltaConcurrency, 1);

const partialPids = fixture({
  'cgroup.controllers': 'cpu memory pids',
  'memory.max': String(4 * 1024 * 1024 * 1024),
  'memory.current': String(256 * 1024 * 1024),
  'cpu.max': '400000 100000',
  'pids.max': '512',
});
assert.equal(partialPids.pidsCurrent, null);
assert.equal(partialPids.deltaConcurrency, 1);

console.log('Runtime resource budget: cgroup limits and conservative fallbacks passed');
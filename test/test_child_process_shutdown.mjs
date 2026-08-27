import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { terminateChildProcesses } from '../app/backend/src/services/childProcessShutdown.js';

class FakeChild extends EventEmitter {
  constructor(closeOnTerm = true) {
    super();
    this.exitCode = null;
    this.signalCode = null;
    this.closeOnTerm = closeOnTerm;
    this.signals = [];
  }
  kill(signal) {
    this.signals.push(signal);
    if (signal === 'SIGTERM' && this.closeOnTerm) {
      this.signalCode = signal;
      queueMicrotask(() => this.emit('close', null, signal));
    }
    if (signal === 'SIGKILL') {
      this.signalCode = signal;
      queueMicrotask(() => this.emit('close', null, signal));
    }
    return true;
  }
}

const graceful = new FakeChild(true);
const forced = new FakeChild(false);
const result = await terminateChildProcesses([graceful, forced], 10);
assert.deepEqual(result, { terminated: 2, forced: 1, remaining: 0 });
assert.deepEqual(graceful.signals, ['SIGTERM']);
assert.deepEqual(forced.signals, ['SIGTERM', 'SIGKILL']);
assert.deepEqual(await terminateChildProcesses([], 10), { terminated: 0, forced: 0, remaining: 0 });

const stubborn = new FakeChild(false);
stubborn.kill = function kill(signal) {
  this.signals.push(signal);
  return true;
};
assert.deepEqual(
  await terminateChildProcesses([stubborn], 5, 5),
  { terminated: 0, forced: 1, remaining: 1 },
);
assert.deepEqual(stubborn.signals, ['SIGTERM', 'SIGKILL']);

console.log('Bounded child process shutdown: 6 cases passed');
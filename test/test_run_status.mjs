import assert from 'node:assert/strict';
import { isCancelledRun } from '../app/backend/src/services/runStatus.js';

assert.equal(isCancelledRun('cancelled', 1), true);
assert.equal(isCancelledRun('running', null), true);
assert.equal(isCancelledRun('running', 143), true);
assert.equal(isCancelledRun('running', -15), true);
assert.equal(isCancelledRun('running', 0), false);
assert.equal(isCancelledRun('running', 23), false);

console.log('Run cancellation status: 6 cases passed');
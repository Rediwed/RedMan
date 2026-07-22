import assert from 'node:assert/strict';
import { isTerminalRunStatus } from '../app/frontend/src/utils/runStatus.js';

for (const status of ['completed', 'partial', 'failed', 'cancelled']) {
  assert.equal(isTerminalRunStatus(status), true, `${status} should be terminal`);
}

for (const status of ['running', 'preparing', 'transferring', undefined]) {
  assert.equal(isTerminalRunStatus(status), false, `${status} should remain active`);
}

console.log('Frontend terminal run statuses: 8 cases passed');
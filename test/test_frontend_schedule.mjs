import assert from 'node:assert/strict';
import { describeCron, parseCron } from '../app/frontend/src/utils/schedule.js';

assert.equal(parseCron('15 */8 * * *').frequency, '8h');
assert.equal(parseCron('30 2 * * 1').minute, 30);
assert.equal(describeCron('15 */8 * * *'), 'Runs every 8 hours at :15');
assert.equal(describeCron('30 2 * * 1'), 'Runs every Monday at 02:30');
assert.equal(describeCron('45 4 1 * *'), 'Runs on the 1st of each month at 04:45');

console.log('Frontend schedule parsing and descriptions: 5 cases passed');
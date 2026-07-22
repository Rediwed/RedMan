import assert from 'node:assert/strict';
import {
  nextCronOccurrence,
  validateCronExpression,
} from '../app/backend/src/services/schedulePolicy.js';

assert.equal(validateCronExpression('30 2 * * 1'), true);
assert.equal(validateCronExpression('not a cron'), false);
assert.equal(validateCronExpression('0 2 * * * extra'), false);
assert.equal(
  nextCronOccurrence('30 2 * * 1', {
    currentDate: new Date('2026-07-14T10:00:00Z'),
    timezone: 'UTC',
  }),
  '2026-07-20T02:30:00.000Z',
);
assert.equal(
  nextCronOccurrence('15 4 1 * *', {
    currentDate: new Date('2026-07-14T10:00:00Z'),
    timezone: 'UTC',
  }),
  '2026-08-01T04:15:00.000Z',
);

console.log('Cron validation and exact next occurrence: 5 cases passed');
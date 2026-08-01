import assert from 'node:assert/strict';
import {
  formatDateShort,
  formatDateTime,
  formatTimeOnly,
  parseDbDate,
} from '../app/frontend/src/utils/dateFormat.js';

// SQLite writes datetime('now') in UTC with no zone suffix. Reading that with
// bare new Date() gives local time, shifting every displayed timestamp by the
// viewer's offset.
assert.equal(parseDbDate('2026-08-01 03:03:41').toISOString(), '2026-08-01T03:03:41.000Z');
assert.equal(parseDbDate('2026-08-01T03:03:41').toISOString(), '2026-08-01T03:03:41.000Z');
// Values that already carry a zone are left alone rather than double-suffixed.
assert.equal(parseDbDate('2026-08-01T03:03:41Z').toISOString(), '2026-08-01T03:03:41.000Z');
assert.equal(parseDbDate('2026-08-01T05:03:41+02:00').toISOString(), '2026-08-01T03:03:41.000Z');
// Unusable input fails closed instead of producing a plausible wrong date.
for (const bad of ['', '   ', 'not a date', '2026-13-45 99:99:99', null, undefined, 0, 42, {}, new Date()]) {
  assert.equal(parseDbDate(bad), null, `expected null for ${JSON.stringify(bad)}`);
}

// An explicit timezone makes these assertions independent of the host's.
const settings = { timezone: 'Europe/Amsterdam', time_format: '24h', date_format: 'DD/MM/YYYY' };
// 03:03 UTC is 05:03 in Amsterdam; the bug rendered it as 03:03.
assert.equal(formatTimeOnly('2026-08-01 03:03:41', settings), '05:03');
assert.match(formatDateTime('2026-08-01 03:03:41', settings), /\b05:03\b/);
// Just before midnight UTC the local date is already the next day. Assert the
// whole string: a substring like /02/ would also match the year.
assert.equal(formatDateShort('2026-08-01 23:30:00', settings), '02 Aug 2026');

assert.equal(formatTimeOnly('', settings), '');
assert.equal(formatDateTime('', settings), '—');

// The peer "last seen" label reads the same column and must use the parser too.
const { readFileSync } = await import('node:fs');
const { resolve } = await import('node:path');
const connectionStatus = readFileSync(
  resolve(import.meta.dirname, '../app/frontend/src/components/ConnectionStatus.jsx'), 'utf8');
assert.match(connectionStatus, /parseDbDate\(iso\)/);
assert.doesNotMatch(connectionStatus, /new Date\(iso\)/);

console.log('Date formatting: UTC parsing, zoned input, invalid input, and peer last-seen passed');

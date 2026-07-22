import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { formatBytes } from '../app/frontend/src/utils/formatBytes.js';

assert.equal(formatBytes(0), '0 B');
assert.equal(formatBytes(0, { zero: '—' }), '—');
assert.equal(formatBytes(1536), '1.5 KB');
assert.equal(formatBytes(undefined), '—');
assert.equal(formatBytes(-1), '—');

const frontend = resolve(import.meta.dirname, '../app/frontend/src');
for (const file of [
  'components/ConnectionStatus.jsx',
  'components/JobProgress.jsx',
  'pages/OverviewPage.jsx',
  'pages/HyperBackupPage.jsx',
  'pages/RclonePage.jsx',
  'pages/SsdBackupPage.jsx',
]) {
  const source = readFileSync(resolve(frontend, file), 'utf8');
  assert.doesNotMatch(source, /function formatBytes\(/, `${file} still defines formatBytes`);
  assert.match(source, /utils\/formatBytes\.js/);
}
console.log('Shared byte formatter: values, fallback, and six consumers passed');
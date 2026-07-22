import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const component = readFileSync(resolve(import.meta.dirname, '../app/frontend/src/components/BackupHealth.jsx'), 'utf8');
const ssd = readFileSync(resolve(import.meta.dirname, '../app/frontend/src/pages/SsdBackupPage.jsx'), 'utf8');
const hyper = readFileSync(resolve(import.meta.dirname, '../app/frontend/src/pages/HyperBackupPage.jsx'), 'utf8');
const rclone = readFileSync(resolve(import.meta.dirname, '../app/frontend/src/pages/RclonePage.jsx'), 'utf8');

for (const label of ['Last success', 'Last issue', 'Verified restore', 'Next run']) {
  assert.match(component, new RegExp(label));
}
assert.match(component, /Expected backup is overdue/);
assert.match(ssd, /restoreSupported/);
assert.match(ssd, /Verify restored bytes with SHA-256/);
assert.match(ssd, /onOpenRestore/);
assert.match(hyper, /<BackupHealth health=\{j\.health\}/);
assert.match(rclone, /<BackupHealth health=\{j\.health\}/);
console.log('Backup health UI: success, issue, staleness, next run, and verified restore passed');
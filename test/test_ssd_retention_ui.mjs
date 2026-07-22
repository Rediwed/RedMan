import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(import.meta.dirname, '../app/frontend/src/pages/SsdBackupPage.jsx'), 'utf8');
assert.match(source, /\{form\.versioning_enabled && \(/);
assert.match(source, /\{form\.delta_versioning && <div className="form-subsection">/);
assert.match(source, /loadRuns\(1, configId\)/);
assert.match(source, /Existing destination files and snapshots are not deleted/);
console.log('SSD retention UI: plain versioning, immediate filter, and deletion consequence passed');
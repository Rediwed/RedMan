import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(import.meta.dirname, '../app/frontend/src/pages/HyperBackupPage.jsx'), 'utf8');
assert.doesNotMatch(source, /showAdvanced/);
assert.match(source, /manualDestination/);
assert.match(source, /Remote API key/);
assert.match(source, /required=\{!editId\}/);
assert.match(source, /Send to peer/);
assert.match(source, /Receive from peer/);
assert.match(source, /Host override/);
assert.match(source, /Choose paired peer/);
console.log('Hyper manual setup: URL, credential, direction, and validated SSH controls passed');
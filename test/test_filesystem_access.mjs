import assert from 'node:assert/strict';
import { mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveAllowedBrowsePath } from '../app/backend/src/services/filesystemAccess.js';

const fixture = resolve(import.meta.dirname, 'data', `filesystem-access-${process.pid}`);
const allowed = resolve(fixture, 'allowed');
const sensitive = resolve(allowed, 'sensitive');
const outside = resolve(fixture, 'outside');
mkdirSync(sensitive, { recursive: true });
mkdirSync(outside, { recursive: true });
symlinkSync(outside, resolve(allowed, 'escape'));
const roots = [{ name: 'Allowed', path: allowed }];

try {
  assert.equal(resolveAllowedBrowsePath(allowed, roots).path, allowed);
  assert.throws(() => resolveAllowedBrowsePath(sensitive, roots, [sensitive]), /sensitive/);
  assert.throws(() => resolveAllowedBrowsePath(outside, roots), /outside allowed roots/);
  assert.throws(() => resolveAllowedBrowsePath(resolve(allowed, 'escape'), roots), /outside allowed roots/);
  assert.equal(roots.some(root => root.path === '/'), false);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

console.log('Filesystem browser access: 5 cases passed');
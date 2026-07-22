import assert from 'node:assert/strict';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ensureDirectoryWithinPrefix,
  resolveExistingPathWithinPrefix,
} from '../app/backend/src/services/pathConfinement.js';

const fixture = resolve(import.meta.dirname, 'data', `path-confinement-${process.pid}`);
const prefix = resolve(fixture, 'allowed');
const outside = resolve(fixture, 'outside');
mkdirSync(prefix, { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(resolve(outside, 'secret.txt'), 'secret');
symlinkSync(outside, resolve(prefix, 'escape'));

try {
  assert.throws(() => resolveExistingPathWithinPrefix(resolve(prefix, 'escape'), prefix), /outside/);
  assert.throws(() => ensureDirectoryWithinPrefix(resolve(prefix, 'escape', 'new'), prefix), /symbolic links/);
  const created = ensureDirectoryWithinPrefix(resolve(prefix, 'safe', 'nested'), prefix);
  assert.equal(created.path, resolve(prefix, 'safe', 'nested'));
  assert.equal(resolveExistingPathWithinPrefix(created.path, prefix).path, created.path);
  assert.throws(() => resolveExistingPathWithinPrefix(outside, prefix), /outside/);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

console.log('Peer path confinement: 5 cases passed');
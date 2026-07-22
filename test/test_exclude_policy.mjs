import assert from 'node:assert/strict';
import { listExcludePatterns, normalizeExcludePatterns } from '../app/backend/src/services/excludePolicy.js';

assert.equal(normalizeExcludePatterns(' cache/\n*.tmp,cache/ '), 'cache/\n*.tmp');
assert.deepEqual(listExcludePatterns('a\nb'), ['a', 'b']);
assert.equal(normalizeExcludePatterns(''), null);
assert.throws(() => normalizeExcludePatterns(Array.from({ length: 101 }, (_, index) => `p${index}`).join('\n')), /at most 100/);
assert.throws(() => normalizeExcludePatterns('x'.repeat(257)), /256 characters/);
console.log('Exclude policy: normalization, deduplication, and bounds passed');
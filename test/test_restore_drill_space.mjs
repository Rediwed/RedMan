import assert from 'node:assert/strict';

const { availableBytes } = await import('../app/backend/src/services/restoreDrill.js');

// Unraid's shfs reports zeroes for user shares. Reading that as "full" would
// block every drill on the platform RedMan is built for.
assert.equal(availableBytes({ bavail: 0, bsize: 0 }), null);
assert.equal(availableBytes({ bavail: 1000, bsize: 0 }), null);
assert.equal(availableBytes({ bavail: 0, bsize: 4096 }), null);
assert.equal(availableBytes(undefined), null);
assert.equal(availableBytes({}), null);

// A filesystem that does report gets a real number, so the guard still bites.
assert.equal(availableBytes({ bavail: 10, bsize: 4096 }), 40960);
assert.equal(availableBytes({ bavail: 166201076n, bsize: 4096n }), 680759607296);

console.log('Restore drill free space: unreportable filesystems read as unknown, not as full');

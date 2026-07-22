import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const fixture = resolve(import.meta.dirname, 'data', `rclone-output-${process.pid}`);
mkdirSync(fixture, { recursive: true });
process.env.DB_PATH = resolve(fixture, 'redman.db');
const { createRcloneLogProcessor } = await import('../app/backend/src/services/rclone.js');
const { default: db } = await import('../app/backend/src/db.js');

const entries = [];
const processor = createRcloneLogProcessor({ onFileEntry: entry => entries.push(entry) });
processor.processLine('INFO  : photos/a.jpg: Copied (new)');
processor.processLine('INFO  : photos/old.jpg: Deleted');
processor.processLine('ERROR : photos/b.jpg: permission denied');
processor.processLine('Transferred: 9.215 MiB / 10 MiB, 92%, 2 MiB/s, ETA 1s (xfr#2/3)');
assert.deepEqual(entries, [
  { path: 'photos/a.jpg', action: 'copied', size: 0 },
  { path: 'photos/old.jpg', action: 'deleted', size: 0 },
  { path: 'photos/b.jpg', action: 'error', size: 0, error: 'permission denied' },
]);
assert.equal(processor.stats.filesCopied, 2);
assert.equal(processor.stats.filesTotal, 3);
assert.equal(processor.stats.filesFailed, 1);
assert.equal(processor.stats.bytesTransferred, Math.round(9.215 * 1024 * 1024));

for (let index = 0; index < 5000; index++) processor.processLine(`INFO  : file-${index}: Copied`);
assert.equal(entries.length, 5003);
assert.equal('files' in processor.stats, false);

console.log('Rclone output: streaming file events and aggregate stats passed without retained log arrays');
db.close();
rmSync(fixture, { recursive: true, force: true });
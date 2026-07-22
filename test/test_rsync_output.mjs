import assert from 'node:assert/strict';
import {
  MAX_CAPTURED_OUTPUT_BYTES,
  createRsyncOutputProcessor,
  parseItemizeAction,
} from '../app/backend/src/services/rsyncOutput.js';

assert.equal(parseItemizeAction('>f+++++++++'), 'created');
assert.equal(parseItemizeAction('>f.st......'), 'transferred');
assert.equal(parseItemizeAction('cd+++++++++'), 'directory');
assert.equal(parseItemizeAction('.f...p.....'), 'unchanged');

const entries = [];
const processor = createRsyncOutputProcessor({
  platform: 'linux',
  onFileEntry: entry => entries.push(entry),
});

processor.writeStdout('>f++++');
processor.writeStdout('+++++ 42 photos/new.jpg\n*delet');
processor.writeStdout('ing   12 photos/old.jpg\r1,024  50%  2.00MB/s  0:00:04  (xfr#1, to-chk=1/2)\n');
processor.writeStderr('rsy');
processor.writeStderr('nc: link_stat failed\nrsync error: partial transfer\n');
processor.flush();

assert.deepEqual(entries, [
  { path: 'photos/new.jpg', action: 'created', size: 42 },
  { path: 'photos/old.jpg', action: 'deleted', size: 12 },
]);
assert.equal(processor.progress.filesTotal, 2);
assert.equal(processor.progress.filesCopied, 1);
assert.equal(processor.progress.filesRemaining, 1);
assert.equal(processor.progress.bytesTransferred, 1024);
assert.equal(processor.progress.percent, 50);
assert.equal(processor.progress.filesFailed, 1);

processor.writeStdout('x'.repeat(MAX_CAPTURED_OUTPUT_BYTES * 2));
processor.writeStderr('y'.repeat(MAX_CAPTURED_OUTPUT_BYTES * 2));
const output = processor.output();
assert.ok(Buffer.byteLength(output.stdout) <= MAX_CAPTURED_OUTPUT_BYTES);
assert.ok(Buffer.byteLength(output.stderr) <= MAX_CAPTURED_OUTPUT_BYTES);

console.log('Rsync output: shared parsing, chunk boundaries, deletion, errors, and bounded tails passed');
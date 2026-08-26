import assert from 'node:assert/strict';
import {
  MAX_CAPTURED_OUTPUT_BYTES,
  createRsyncOutputProcessor,
  parseItemizeAction,
  parseRsyncByteCount,
} from '../app/backend/src/services/rsyncOutput.js';

assert.equal(parseItemizeAction('>f+++++++++'), 'created');
assert.equal(parseItemizeAction('>f.st......'), 'transferred');
assert.equal(parseItemizeAction('cd+++++++++'), 'directory');
assert.equal(parseItemizeAction('.f...p.....'), 'unchanged');
assert.equal(parseRsyncByteCount('1,024'), 1024);
assert.equal(parseRsyncByteCount('842.50M'), 842_500_000);
assert.equal(parseRsyncByteCount('1.23G'), 1_230_000_000);
assert.equal(parseRsyncByteCount('.'), null);
assert.equal(parseRsyncByteCount('1.2.3G'), null);
assert.equal(parseRsyncByteCount('1,2,3G'), null);
assert.equal(parseRsyncByteCount('9007199T'), null);

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

const humanProgress = createRsyncOutputProcessor({ platform: 'linux' });
humanProgress.writeStdout('1.23G  42%  38.20MB/s  0:00:19  (xfr#430, to-chk=11570/12000)\r');
humanProgress.flush();
assert.equal(humanProgress.progress.bytesTransferred, 1_230_000_000);
assert.equal(humanProgress.progress.percent, 42);
assert.equal(humanProgress.progress.filesCopied, 430);
assert.equal(humanProgress.progress.filesRemaining, 11570);
assert.equal(humanProgress.progress.filesTotal, 12000);

const malformedProgress = createRsyncOutputProcessor({ platform: 'linux' });
malformedProgress.progress.bytesTransferred = 1_234_567_890;
let malformedUpdates = 0;
const guardedMalformedProgress = createRsyncOutputProcessor({
  platform: 'linux',
  progress: malformedProgress.progress,
  onProgress: () => { malformedUpdates++; },
});
for (const line of [
  '.  42%  38.20MB/s  0:00:19  (xfr#430, to-chk=11570/12000)',
  '1.2.3G  42%  38.20MB/s  0:00:19  (xfr#430, to-chk=11570/12000)',
  '1,2,3G  42%  38.20MB/s  0:00:19  (xfr#430, to-chk=11570/12000)',
  '9007199T  42%  38.20MB/s  0:00:19  (xfr#430, to-chk=11570/12000)',
  '1.23G  142%  38.20MB/s  0:00:19  (xfr#430, to-chk=11570/12000)',
]) {
  guardedMalformedProgress.writeStdout(`${line}\n`);
  assert.equal(guardedMalformedProgress.progress.bytesTransferred, 1_234_567_890);
  assert.equal(guardedMalformedProgress.progress.percent, null);
  assert.equal(malformedUpdates, 0);
}
guardedMalformedProgress.writeStdout('1.23G  42%  38.20MB/s  0:00:19  (xfr#430, to-chk=11570/12000)\n');
guardedMalformedProgress.flush();
assert.equal(malformedProgress.progress.bytesTransferred, 1_234_567_890);
assert.equal(malformedProgress.progress.percent, 42);
assert.equal(Number.isFinite(malformedProgress.progress.bytesTransferred), true);
assert.equal(malformedUpdates, 1);

processor.writeStdout('x'.repeat(MAX_CAPTURED_OUTPUT_BYTES * 2));
processor.writeStderr('y'.repeat(MAX_CAPTURED_OUTPUT_BYTES * 2));
const output = processor.output();
assert.ok(Buffer.byteLength(output.stdout) <= MAX_CAPTURED_OUTPUT_BYTES);
assert.ok(Buffer.byteLength(output.stderr) <= MAX_CAPTURED_OUTPUT_BYTES);

console.log('Rsync output: shared parsing, chunk boundaries, deletion, errors, and bounded tails passed');
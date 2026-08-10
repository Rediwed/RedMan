// A status line only helps if a person can read it. These assertions pin the
// wording that replaced raw exit codes and JSON, because a regression here is
// invisible: the UI keeps rendering, it just stops meaning anything.

import assert from 'node:assert/strict';
import {
  describeExitCode,
  describeFailure,
  describeDetail,
  splitBody,
  formatDuration,
} from '../app/frontend/src/utils/describe.js';

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

check('a code with a defined meaning is stated in words', () => {
  assert.match(describeExitCode(127).headline, /could not be found/i);
  assert.match(describeExitCode(126).headline, /execute permission/i);
  assert.equal(describeExitCode(0).headline, 'Finished successfully');
});

check('a signal is named as being stopped, not as a number', () => {
  assert.match(describeExitCode(137).headline, /killed outright|out of memory/i);
  assert.match(describeExitCode(143).headline, /asked to stop/i);
  assert.match(describeExitCode(130).headline, /interrupted/i);
});

check('a tool that documents its own codes is taken at its word', () => {
  assert.match(describeExitCode(23, { source: 'rsync' }).headline, /some files could not be transferred/i);
  assert.match(describeExitCode(24, { source: 'rsync' }).headline, /disappeared/i);
  assert.match(describeExitCode(7, { source: 'rclone' }).headline, /destination was full/i);
});

check('the same code means different things to different tools', () => {
  assert.notEqual(
    describeExitCode(1, { source: 'rsync' }).headline,
    describeExitCode(1, { source: 'rclone' }).headline,
  );
});

check('a code nobody defines is not given an invented meaning', () => {
  const generic = describeExitCode(1);
  assert.equal(generic.known, false);
  assert.match(generic.headline, /reported a failure/i);

  const unheard = describeExitCode(66);
  assert.equal(unheard.known, false);
  assert.match(unheard.headline, /exit code 66/);
});

check('a missing code says so instead of showing a question mark', () => {
  assert.match(describeExitCode(null).headline, /without reporting why/i);
  assert.match(describeExitCode(undefined).headline, /without reporting why/i);
});

check('the job\'s own message outranks the code it exited with', () => {
  const failure = describeFailure({ exitCode: 1, message: 'the peer refused the connection' });
  assert.equal(failure.headline, 'the peer refused the connection');
  assert.equal(failure.code, 1);
});

check('without a message the code carries the explanation', () => {
  const failure = describeFailure({ exitCode: 127 });
  assert.match(failure.headline, /could not be found/i);
});

check('detail becomes readable values rather than JSON', () => {
  const entries = describeDetail({
    feature: 'Rclone Sync',
    filesCopied: 2,
    filesFailed: 145,
    bytesTransferred: 33389,
    duration: 412.781,
  });
  const byKey = Object.fromEntries(entries.map(e => [e.key, e]));

  assert.equal(byKey.filesCopied.label, 'Files copied');
  assert.equal(byKey.bytesTransferred.value, '32.6 KB');
  assert.match(byKey.duration.value, /6 min 53 s/);
  assert.equal(byKey.feature, undefined, 'a key the card already shows is not repeated');
});

check('a count of failures is marked as bad so colour carries the meaning', () => {
  const entries = describeDetail({ filesFailed: 145, filesCopied: 2 });
  assert.equal(entries.find(e => e.key === 'filesFailed').tone, 'bad');
  assert.equal(entries.find(e => e.key === 'filesCopied').tone, undefined);
});

check('durations read as time rather than as a float', () => {
  assert.equal(formatDuration(0.4), 'less than a second');
  assert.equal(formatDuration(45), '45 s');
  assert.equal(formatDuration(412.781), '6 min 53 s');
  assert.equal(formatDuration(3600), '1 h 0 min');
});

check('a body that is a table written as prose is split back into values', () => {
  const { lead, stats } = splitBody(
    'Status: partial\nFiles transferred: 2\nFiles failed: 145\nTransferred: 32.6 KB\nDuration: 6m 53s',
  );
  assert.equal(lead, '');
  assert.equal(stats.length, 5);
  assert.deepEqual(stats[0], { label: 'Status', value: 'partial' });
  assert.deepEqual(stats[2], { label: 'Files failed', value: '145' });
});

check('a real sentence in the body is kept as a sentence', () => {
  const { lead, stats } = splitBody('The remote peer refused the connection. Duration: 3s');
  assert.match(lead, /^The remote peer refused/);
  assert.equal(stats.length, 0, 'a sentence that merely contains a colon is not a stat line');
});

check('an empty body produces nothing to render', () => {
  assert.deepEqual(splitBody(''), { lead: '', stats: [] });
  assert.deepEqual(splitBody(null), { lead: '', stats: [] });
});

console.log(`\n${passed} description checks passed`);

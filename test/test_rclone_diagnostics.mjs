// The point of a diagnosis is that it is right. A wrong explanation sends the
// operator after the wrong thing, which is worse than "146 file(s) failed".
// These strings are taken verbatim from real rclone output.

import assert from 'node:assert/strict';

import {
  classifyRcloneError,
  summariseRcloneFailures,
  describeRcloneFailures,
  fingerprintFailures,
  compareFailureSummaries,
  MAX_FILENAME_BYTES,
} from '../app/backend/src/services/rcloneDiagnostics.js';

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

// Error shapes taken from a real OneDrive run; the path itself is synthetic,
// but keeps the spaces, brackets, truncation and .partial suffix that matter.
const REAL = {
  nameTooLong: 'Failed to copy: open /mnt/user/Backup/Archive/Mail/2024-01-18 1540 [x@example.org] FW_ onderwerp van een doorgestuurd bericht - FW_ nogmaals doorgestuurd met een titel die veel te lang is voor het bes.9a103518.partial: file name too long',
  lockedVault: "error reading source directory: couldn't list files: invalidRequest: invalidResourceId: ObjectHandle is Invalid",
  heldBackFiles: 'not deleting files as there were IO errors',
  heldBackDirs: 'not deleting directories as there were IO errors',
  tooSlow: ': upload chunks may be taking too long - try reducing --onedrive-chunk-size or decreasing --transfers',
};

check('the filesystem limit is stated, not guessed', () => {
  assert.equal(MAX_FILENAME_BYTES, 255);
});

check('a name-too-long failure is recognised and explains the limit', () => {
  const cls = classifyRcloneError(REAL.nameTooLong);
  assert.equal(cls.code, 'name-too-long');
  assert.match(cls.explain, /255 bytes/);
  assert.ok(cls.remedy.length > 0);
});

check('a locked Personal Vault is recognised', () => {
  const cls = classifyRcloneError(REAL.lockedVault);
  assert.equal(cls.code, 'locked-or-missing-item');
  assert.match(cls.remedy, /vault/i);
});

check('held-back deletions are named as a consequence, not a cause', () => {
  for (const raw of [REAL.heldBackFiles, REAL.heldBackDirs]) {
    const cls = classifyRcloneError(raw);
    assert.equal(cls.code, 'blocked-by-earlier-errors');
    assert.match(cls.explain, /safety/i);
  }
});

check('a throughput timeout is separated from a per-file failure', () => {
  const cls = classifyRcloneError(REAL.tooSlow);
  assert.equal(cls.code, 'transfer-too-slow');
  // It moves around between runs, so it must not read as a broken file.
  assert.match(cls.explain, /throughput/i);
  assert.match(cls.remedy, /chunk size|transfers/i);
});

check('an unfamiliar error is reported as unrecognised, never guessed', () => {
  assert.equal(classifyRcloneError('some entirely new failure from a future rclone'), null);
  assert.equal(classifyRcloneError(''), null);
  assert.equal(classifyRcloneError(null), null);
});

check('the real run is grouped the way it actually broke', () => {
  // 142 long names, one unreadable directory, two held-back deletions,
  // one unclassified — the shape of a real failing run.
  const failures = [
    ...Array.from({ length: 142 }, (_, i) => ({ path: `Archive/Mail/long-${i}.pdf`, error: REAL.nameTooLong })),
    { path: 'Personal Vault', error: REAL.lockedVault },
    { path: '', error: REAL.heldBackFiles },
    { path: '', error: REAL.heldBackDirs },
    { path: 'odd.txt', error: 'something rclone has not said before' },
  ];

  const summary = summariseRcloneFailures(failures);
  assert.equal(summary.total, 146);
  // Biggest group first: that is the one worth acting on.
  assert.equal(summary.groups[0].code, 'name-too-long');
  assert.equal(summary.groups[0].count, 142);
  assert.equal(summary.groups[0].examples.length, 3);

  const codes = summary.groups.map(g => g.code);
  assert.ok(codes.includes('locked-or-missing-item'));
  assert.ok(codes.includes('blocked-by-earlier-errors'));
  assert.ok(codes.includes('unrecognised'));
  assert.equal(summary.groups.find(g => g.code === 'blocked-by-earlier-errors').count, 2);
});

check('the one-line summary names the causes instead of only counting', () => {
  const line = describeRcloneFailures([
    { path: 'a', error: REAL.nameTooLong },
    { path: 'b', error: REAL.nameTooLong },
    { path: 'Personal Vault', error: REAL.lockedVault },
  ]);
  assert.match(line, /^3 file\(s\) failed —/);
  assert.match(line, /2 name longer than the filesystem allows/);
  assert.match(line, /1 the remote refused to open an item/);
});

check('a clean run produces no message at all', () => {
  assert.equal(describeRcloneFailures([]), null);
  assert.equal(describeRcloneFailures(), null);
});

check('examples are capped so one bad run cannot bloat the response', () => {
  const many = Array.from({ length: 500 }, (_, i) => ({ path: `f${i}`, error: REAL.nameTooLong }));
  const summary = summariseRcloneFailures(many);
  assert.equal(summary.groups[0].count, 500);
  assert.equal(summary.groups[0].examples.length, 3);
});

// ── Telling a chronic failure from a new one ───────────────────────

check('pre-aggregated rows count the same as one entry per file', () => {
  const perFile = summariseRcloneFailures(
    Array.from({ length: 5 }, () => ({ error: REAL.nameTooLong })),
  );
  const aggregated = summariseRcloneFailures([{ error: REAL.nameTooLong, count: 5 }]);
  assert.equal(perFile.total, aggregated.total);
  assert.equal(fingerprintFailures(perFile), fingerprintFailures(aggregated));
});

check('the same failure two nights running has the same fingerprint', () => {
  const night = () => summariseRcloneFailures([
    { error: REAL.nameTooLong, count: 142 },
    { error: REAL.lockedVault, count: 1 },
  ]);
  assert.equal(fingerprintFailures(night()), fingerprintFailures(night()));
  assert.equal(compareFailureSummaries(night(), night()).unchanged, true);
});

check('a changed count is not mistaken for unchanged', () => {
  const before = summariseRcloneFailures([{ error: REAL.nameTooLong, count: 142 }]);
  const after = summariseRcloneFailures([{ error: REAL.nameTooLong, count: 143 }]);
  const cmp = compareFailureSummaries(after, before);
  assert.equal(cmp.unchanged, false);
  assert.deepEqual(cmp.changedCodes, [{ code: 'name-too-long', from: 142, to: 143 }]);
});

check('a new cause hiding among chronic ones is surfaced', () => {
  // The case this exists for: 142 known failures every night, and tonight one
  // permission error appears among them.
  const before = summariseRcloneFailures([{ error: REAL.nameTooLong, count: 142 }]);
  const after = summariseRcloneFailures([
    { error: REAL.nameTooLong, count: 142 },
    { error: 'Failed to copy: permission denied', count: 1 },
  ]);
  const cmp = compareFailureSummaries(after, before);
  assert.equal(cmp.unchanged, false);
  assert.deepEqual(cmp.newCodes, ['permission-denied']);
});

check('a cause that stopped occurring is reported as resolved', () => {
  const before = summariseRcloneFailures([
    { error: REAL.nameTooLong, count: 142 },
    { error: REAL.tooSlow, count: 1 },
  ]);
  const after = summariseRcloneFailures([{ error: REAL.nameTooLong, count: 142 }]);
  const cmp = compareFailureSummaries(after, before);
  assert.deepEqual(cmp.resolvedCodes, ['transfer-too-slow']);
});

check('the first failing run is marked as such, not as unchanged', () => {
  const cmp = compareFailureSummaries(summariseRcloneFailures([{ error: REAL.nameTooLong }]), null);
  assert.equal(cmp.firstSeen, true);
  assert.equal(cmp.unchanged, false);
});

check('the summary line says whether anything changed', () => {
  const before = summariseRcloneFailures([{ error: REAL.nameTooLong, count: 142 }]);
  const failures = [{ error: REAL.nameTooLong, count: 142 }];

  const same = describeRcloneFailures(failures, compareFailureSummaries(summariseRcloneFailures(failures), before));
  assert.match(same, /Unchanged from the previous run/);

  const worse = [...failures, { error: 'Failed to copy: permission denied', count: 1 }];
  const changed = describeRcloneFailures(worse, compareFailureSummaries(summariseRcloneFailures(worse), before));
  assert.match(changed, /NEW since the previous run: not allowed to read or write/);
  // The chronic failures stay in the line: they have not gone away.
  assert.match(changed, /142 name longer than the filesystem allows/);
});

check('a clean run has a fingerprint of its own', () => {
  assert.equal(fingerprintFailures(summariseRcloneFailures([])), 'clean');
});

console.log(`\n${passed} rclone diagnosis checks passed`);

// Turns rclone's per-file errors into something an operator can act on.
//
// "146 file(s) failed" is true and useless: it does not say whether one remote
// went down or a hundred individual files each hit their own wall, and it looks
// identical every night whether or not anything changed. A job stuck on the same
// count for weeks is indistinguishable from one that broke last night, so the
// summary has to name the cause.
//
// Only causes actually observed in the wild are classified. An unrecognised
// error is reported as unrecognised rather than folded into a neighbouring
// bucket — a wrong explanation is worse than none.

// Longest name a POSIX filesystem accepts in a single path component. rclone
// also needs room for its `.<hash>.partial` suffix while the file is in flight.
export const MAX_FILENAME_BYTES = 255;

const CLASSES = [
  {
    code: 'name-too-long',
    match: /file name too long|ENAMETOOLONG/i,
    title: 'Name longer than the filesystem allows',
    explain: `The destination filesystem accepts at most ${MAX_FILENAME_BYTES} bytes per path component, and rclone needs a few more for the temporary name it writes during the transfer.`,
    remedy: 'Shorten the names at the source, or exclude them deliberately so a genuinely new failure is still visible. Files like this are commonly mail exports that use the whole subject line as the filename.',
  },
  {
    code: 'locked-or-missing-item',
    match: /invalidResourceId|ObjectHandle is Invalid|itemNotFound/i,
    title: 'The remote refused to open an item',
    explain: 'The remote reports the item exists but will not return its contents. On OneDrive this is what a locked Personal Vault looks like; it can also mean an item was removed while the listing was in progress.',
    remedy: 'Unlock the vault, or exclude the path if it is not meant to be backed up. A Personal Vault cannot be read by a background job at all.',
  },
  {
    code: 'permission-denied',
    match: /permission denied|EACCES|access is denied/i,
    title: 'Not allowed to read or write',
    explain: 'The account running the transfer lacks permission on the file or its directory.',
    remedy: 'Check ownership and mode on the destination, and the remote account\'s access to the source.',
  },
  {
    code: 'no-space',
    match: /no space left|ENOSPC|quota exceeded/i,
    title: 'Out of space or over quota',
    explain: 'The destination could not accept more data.',
    remedy: 'Free space on the destination, or raise the quota.',
  },
  {
    code: 'transfer-too-slow',
    match: /chunks may be taking too long|deadline exceeded|context deadline/i,
    title: 'Transfer too slow for the remote to accept',
    explain: 'The remote closed the transfer because a chunk took longer than it allows. This is about throughput, not about the file itself, so it moves around between runs instead of failing on the same items.',
    remedy: 'Lower the chunk size or the number of parallel transfers for this remote. rclone suggests --onedrive-chunk-size and --transfers.',
  },
  {
    code: 'blocked-by-earlier-errors',
    // rclone's own safety net: it refuses to delete when it could not read
    // everything, so this is a consequence of the errors above, not a cause.
    match: /not deleting (files|directories) as there were IO errors/i,
    title: 'Deletions held back',
    explain: 'rclone refused to delete anything because the run had read errors. This is a safety measure, not a separate failure: an incomplete listing must never be read as "these files are gone".',
    remedy: 'Resolve the errors above; the deletions apply on the next clean run.',
  },
];

/**
 * Classify one raw rclone error string. Returns null when nothing matches, so
 * callers can count unrecognised failures rather than mislabel them.
 */
export function classifyRcloneError(error) {
  if (typeof error !== 'string' || !error.trim()) return null;
  return CLASSES.find(entry => entry.match.test(error)) || null;
}

/**
 * Group failed entries by cause.
 *
 * @param {Array<{path?: string, error?: string}>} failures
 * @returns {{total: number, groups: Array<{code, title, explain, remedy, count, examples}>}}
 */
export function summariseRcloneFailures(failures = []) {
  const groups = new Map();

  for (const failure of failures) {
    const cls = classifyRcloneError(failure?.error);
    const code = cls?.code ?? 'unrecognised';
    if (!groups.has(code)) {
      groups.set(code, {
        code,
        title: cls?.title ?? 'Not recognised',
        explain: cls?.explain ?? 'RedMan has no explanation for this error; the raw message from rclone is kept with each file.',
        remedy: cls?.remedy ?? 'Read the per-file messages in the run report.',
        count: 0,
        examples: [],
      });
    }
    const group = groups.get(code);
    group.count += 1;
    if (group.examples.length < 3 && failure?.path) group.examples.push(failure.path);
  }

  return {
    total: failures.length,
    // Largest group first: that is the one worth acting on.
    groups: [...groups.values()].sort((a, b) => b.count - a.count),
  };
}

/**
 * One line for `backup_runs.error_message`, naming the causes rather than only
 * counting them.
 */
export function describeRcloneFailures(failures = []) {
  const summary = summariseRcloneFailures(failures);
  if (summary.total === 0) return null;

  const parts = summary.groups.map(group => `${group.count} ${group.title.toLowerCase()}`);
  return `${summary.total} file(s) failed — ${parts.join('; ')}`;
}

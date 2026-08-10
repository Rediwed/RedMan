import { formatBytes } from './formatBytes.js';

// An exit code is the only thing a failing job always leaves behind, and on its
// own it tells a reader nothing. Where a code has a defined meaning we say it;
// where it does not, we say that too rather than inventing one.

const SIGNALS = {
  1: 'Stopped when its terminal went away',
  2: 'Was interrupted',
  9: 'Was killed, usually after running out of memory',
  11: 'Crashed',
  15: 'Was asked to stop, and did',
};

const UNIVERSAL = {
  0: 'Finished successfully',
  1: 'Reported a failure',
  2: 'Was asked to do something it did not understand',
  126: 'Could not be run, usually a missing execute permission',
  127: 'Could not be found on the machine that tried to run it',
  255: 'Could not connect, or stopped before it could report a reason',
};

// Documented per-tool tables. Only codes whose meaning the tool actually defines
// belong here; anything else falls through to the universal reading.
const BY_SOURCE = {
  rsync: {
    1: 'Was used incorrectly, so nothing was transferred',
    2: 'Could not agree with the other side on how to talk',
    5: 'Could not start the transfer on the other machine',
    10: 'Lost the network connection',
    11: 'Could not read or write a file it needed',
    12: 'Lost the connection part-way through',
    23: 'Copied most things, but some files could not be transferred',
    24: 'Finished, but some files disappeared while it was running',
    30: 'Gave up waiting for the other side',
    35: 'Timed out while waiting to connect',
  },
  rclone: {
    1: 'Ran into an error it could not recover from',
    3: 'Was given a directory it could not use',
    5: 'Hit a temporary problem and gave up after retrying',
    7: 'Stopped because the destination was full',
    8: 'Stopped because a transfer limit was reached',
    9: 'Finished, but had nothing to transfer',
  },
  ssh: {
    255: 'Could not reach the other machine, or was refused when it got there',
  },
};

export function describeExitCode(code, { source } = {}) {
  if (code === null || code === undefined || code === '') {
    return { headline: 'Failed without reporting why', known: false };
  }
  const value = Number(code);
  if (!Number.isInteger(value)) return { headline: `Failed with status ${code}`, known: false };

  const specific = source ? BY_SOURCE[source]?.[value] : undefined;
  if (specific) return { headline: specific, known: true, code: value };

  if (value > 128 && value < 160) {
    const signal = SIGNALS[value - 128];
    if (signal) return { headline: signal, known: true, code: value };
    return { headline: `Was stopped by the system (signal ${value - 128})`, known: true, code: value };
  }

  const universal = UNIVERSAL[value];
  if (universal) return { headline: universal, known: value !== 1, code: value };

  return { headline: `Failed with exit code ${value}`, known: false, code: value };
}

// The message a job sends is the real reason; the code is only a fallback.
export function describeFailure({ exitCode, message, source } = {}) {
  const trimmed = typeof message === 'string' ? message.trim() : '';
  const fromCode = describeExitCode(exitCode, { source });
  if (trimmed) return { headline: trimmed, note: fromCode.known ? fromCode.headline : null, code: fromCode.code };
  return { headline: fromCode.headline, note: null, code: fromCode.code };
}

const LABELS = {
  feature: 'Feature',
  filesCopied: 'Files copied',
  filesFailed: 'Files failed',
  filesTransferred: 'Files transferred',
  filesDeleted: 'Files deleted',
  bytesTransferred: 'Transferred',
  bytesCopied: 'Copied',
  totalBytes: 'Total size',
  freeBytes: 'Free space',
  usedBytes: 'Used',
  duration: 'Duration',
  durationMs: 'Duration',
  elapsed: 'Duration',
  status: 'Outcome',
  exitCode: 'Exit code',
  error: 'Error',
  errors: 'Errors',
  host: 'Host',
  jobName: 'Job',
  destination: 'Destination',
  source: 'Source',
  runId: 'Run',
  startedAt: 'Started',
  finishedAt: 'Finished',
};

// Keys that only repeat what the surrounding card already says, or that identify
// a row rather than describe it.
const HIDDEN = new Set(['id', 'runId', 'jobId', 'configId', 'feature', 'type', 'category', 'severity']);

const BYTE_KEY = /bytes|size$/i;
const COUNT_KEY = /^(files|items|records|count)|count$|failed$|copied$|transferred$|deleted$/i;
const SECONDS_KEY = /^(duration|elapsed)$/i;
const MS_KEY = /(durationms|elapsedms)$/i;

export function formatDuration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return null;
  if (value < 1) return 'less than a second';
  if (value < 60) return `${Math.round(value)} s`;
  const minutes = Math.floor(value / 60);
  const rest = Math.round(value % 60);
  if (minutes < 60) return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}

function humaniseKey(key) {
  if (LABELS[key]) return LABELS[key];
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

function formatValue(key, value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return { text: value ? 'Yes' : 'No' };
  if (typeof value === 'number') {
    if (MS_KEY.test(key)) return { text: formatDuration(value / 1000), numeric: true };
    if (SECONDS_KEY.test(key)) return { text: formatDuration(value), numeric: true };
    if (BYTE_KEY.test(key)) return { text: formatBytes(value), numeric: true };
    return { text: value.toLocaleString('nl-NL'), numeric: true, tone: COUNT_KEY.test(key) && value > 0 && /fail|error/i.test(key) ? 'bad' : undefined };
  }
  if (typeof value === 'string') return { text: value };
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    if (value.every(v => typeof v !== 'object')) return { text: value.join(', ') };
    return { text: `${value.length} item${value.length === 1 ? '' : 's'}`, nested: value };
  }
  if (typeof value === 'object') return { text: null, nested: value };
  return { text: String(value) };
}

// Turns an event's structured detail into something a person can read at a
// glance, instead of the JSON dump it used to be.
export function describeDetail(detail) {
  if (!detail || typeof detail !== 'object') return [];
  return Object.entries(detail)
    .filter(([key]) => !HIDDEN.has(key))
    .map(([key, value]) => {
      const formatted = formatValue(key, value);
      if (!formatted) return null;
      return {
        key,
        label: humaniseKey(key),
        value: formatted.text,
        numeric: Boolean(formatted.numeric),
        tone: formatted.tone || (/fail|error/i.test(key) && Number(value) > 0 ? 'bad' : undefined),
        nested: formatted.nested,
      };
    })
    .filter(Boolean);
}

const STAT_LINE = /^\s*[A-Z][A-Za-z ]{1,30}:\s*\S/;

// A body that is really a list of "Label: value" lines is a table written as
// prose. Those lines are shown as values instead, so nothing is lost and the
// sentence that actually says something stops being buried.
export function splitBody(body) {
  if (typeof body !== 'string' || body.trim() === '') return { lead: '', stats: [] };
  const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
  const lead = [];
  const stats = [];
  for (const line of lines) {
    if (STAT_LINE.test(line)) {
      const [label, ...rest] = line.split(':');
      stats.push({ label: label.trim(), value: rest.join(':').trim() });
    } else {
      lead.push(line);
    }
  }
  return { lead: lead.join(' '), stats };
}


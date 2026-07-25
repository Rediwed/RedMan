import assert from 'node:assert/strict';
import { summarizeImmichGoFailure } from '../app/backend/src/services/immichFailureSummary.js';

// No output at all — immich-go crashed without writing to stderr.
assert.match(summarizeImmichGoFailure(null), /no output/i);
assert.match(summarizeImmichGoFailure(''), /no output/i);

// Real-world reproduction: Immich upgraded and changed the `duration` field
// from a string to a number, breaking the pinned immich-go build's decoder.
// immich-go always appends its full CLI usage block after a top-level error —
// the summary must surface the real cause and drop that boilerplate.
const apiMismatchOutput = [
  'Error: GetAllAssets, POST, http://192.168.1.20:2283/api/search/metadata, 200 OK',
  "can't decode JSON response: json: cannot unmarshal number into Go struct field Asset.Assets.items.duration of type string",
  '',
  'Usage:',
  '  immich-go upload from-folder [flags] <path>...',
  '',
  'Flags:',
  '      --album-path-joiner string   Specify a string to use when joining multiple folder names',
].join('\n');

const mismatchSummary = summarizeImmichGoFailure(apiMismatchOutput);
assert.match(mismatchSummary, /Immich API mismatch/);
assert.match(mismatchSummary, /version bump/i);
assert.match(mismatchSummary, /cannot unmarshal number into Go struct field Asset\.Assets\.items\.duration/);
assert.equal(mismatchSummary.includes('Usage:'), false, 'must not leak immich-go\'s CLI usage block');
assert.equal(mismatchSummary.includes('--album-path-joiner'), false, 'must not leak flag help text');

// Auth failures get a distinct, actionable message.
const authOutput = 'Error: 401 Unauthorized: invalid api key\n\nUsage:\n  immich-go upload from-folder [flags] <path>...';
assert.match(summarizeImmichGoFailure(authOutput), /rejected the API key/i);
assert.equal(summarizeImmichGoFailure(authOutput).includes('Usage:'), false);

// Network failures get a distinct, actionable message.
const networkOutput = 'Error: dial tcp 192.168.1.20:2283: connect: connection refused\n\nUsage:\n  immich-go upload from-folder [flags] <path>...';
assert.match(summarizeImmichGoFailure(networkOutput), /Could not reach the Immich server/i);

// Summaries are pushed to an external ntfy server, so the Immich host and any
// long opaque token must never survive into the message.
assert.equal(summarizeImmichGoFailure(networkOutput).includes('192.168.1.20'), false);
assert.match(summarizeImmichGoFailure(networkOutput), /<immich-host>/);
assert.equal(mismatchSummary.includes('192.168.1.20'), false, 'must not leak the Immich host');
assert.match(mismatchSummary, /http:\/\/<immich-host>\/api\/search\/metadata/);
assert.match(
  summarizeImmichGoFailure('Error: 401 Unauthorized: key aBcDeF0123456789aBcDeF0123456789xyz'),
  /<redacted>/,
);

// A DNS name or IPv6 literal must be masked too — Go reports those without a
// URL scheme, so the host would otherwise survive into an external push.
const dnsFailure = summarizeImmichGoFailure('Error: dial tcp: lookup immich.example-nas.lan: no such host');
assert.equal(dnsFailure.includes('immich.example-nas.lan'), false, 'must not leak a DNS hostname');
assert.match(dnsFailure, /<immich-host>/);
const ipv6Failure = summarizeImmichGoFailure('Error: dial tcp [fd7a:115c:a1e0::1]:2283: connect: connection refused');
assert.equal(ipv6Failure.includes('fd7a'), false, 'must not leak an IPv6 literal');
assert.match(ipv6Failure, /<immich-host>/);

// Filesystem paths stay readable — they are diagnostics, not secrets.
const pathFailure = summarizeImmichGoFailure('Error: cannot open /mnt/user/disks/CANON_SD_CARD/DCIM/100CANON/IMG_0042.JPG');
assert.match(pathFailure, /100CANON\/IMG_0042\.JPG/);

// Unrecognized failures fall back to a short, boilerplate-free first line
// rather than the raw multi-KB CLI usage dump.
const unknownOutput = 'Error: something unexpected happened\n\nUsage:\n  immich-go upload from-folder [flags] <path>...\n\nFlags:\n  --help';
const unknownSummary = summarizeImmichGoFailure(unknownOutput);
assert.equal(unknownSummary, 'Error: something unexpected happened');

// Very long unrecognized causes (no Usage: marker at all) are truncated so a
// notification never balloons into a multi-KB message.
const longCause = 'Error: '.padEnd(400, 'x');
const longSummary = summarizeImmichGoFailure(longCause);
assert.ok(longSummary.length <= 301, `expected truncation, got length ${longSummary.length}`);
assert.ok(longSummary.endsWith('…'));

console.log('immich-go failure summaries: API mismatch, auth, and network causes are surfaced clearly; CLI usage boilerplate and oversized output are never leaked');

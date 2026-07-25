// immich-go always appends its full CLI usage/help text after a top-level
// error, which buries the actual cause under boilerplate. This module
// recognizes known failure classes — especially an Immich API/schema mismatch
// (e.g. after an Immich upgrade changes a response field's type) — and
// produces a short, actionable message instead of dumping the raw usage
// block into notifications and run history.

const USAGE_BLOCK_MARKER = /\n\s*Usage:\s*\n\s*immich-go\b/;

// Summaries are pushed to a configured ntfy server, which is frequently the
// public ntfy.sh. immich-go echoes the Immich endpoint in most of its errors,
// so the host is stripped before the text ever leaves the network. The API key
// is passed via environment and never appears on argv, but long opaque tokens
// are masked as well in case a future immich-go build echoes one.
const URL_HOST = /\b(https?:\/\/)[^\s/]+/gi;
// Go's net package reports unreachable targets as `dial tcp <host:port>` and
// `lookup <host>`, which is how a DNS name or IPv6 literal would otherwise
// reach a notification even though no URL is present.
const GO_DIAL_TARGET = /\b(dial\s+\w+\s+|lookup\s+)\S+/gi;
const IPV6_LITERAL = /\[[0-9A-Fa-f:]+\](?::\d+)?/g;
const BARE_HOST_PORT = /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g;
// Requires both a digit and a letter so repeated filler in ordinary error prose
// is left alone. `/` is deliberately excluded so filesystem paths stay readable.
// Only ever applied to the already-truncated detail, which keeps the lookaheads
// linear on a bounded input.
const OPAQUE_TOKEN = /\b(?=[A-Za-z0-9+=_-]*\d)(?=[A-Za-z0-9+=_-]*[A-Za-z])[A-Za-z0-9+=_-]{32,}\b/g;
const MAX_DETAIL_CHARS = 300;

function redactSensitive(text) {
  return text
    .replace(URL_HOST, '$1<immich-host>')
    .replace(GO_DIAL_TARGET, '$1<immich-host>')
    .replace(IPV6_LITERAL, '<immich-host>')
    .replace(BARE_HOST_PORT, '<immich-host>')
    .replace(OPAQUE_TOKEN, '<redacted>');
}

export function summarizeImmichGoFailure(errorOutput) {
  if (!errorOutput) return 'immich-go exited with an error but produced no output.';

  const trimmed = errorOutput.trim();
  // Everything before immich-go's own "Usage:" help block is the real error.
  const usageIndex = trimmed.search(USAGE_BLOCK_MARKER);
  const cause = (usageIndex >= 0 ? trimmed.slice(0, usageIndex) : trimmed).trim();
  const rawDetail = cause.split('\n').map(l => l.trim()).filter(Boolean).join(' ');
  const detail = redactSensitive(
    rawDetail.length > MAX_DETAIL_CHARS ? `${rawDetail.slice(0, MAX_DETAIL_CHARS)}…` : rawDetail,
  );

  if (/can't decode JSON response|cannot unmarshal|json:\s/i.test(cause)) {
    return `Immich API mismatch — immich-go could not parse a response from the Immich server. ` +
      `This usually means Immich was upgraded and changed its API schema, and the bundled ` +
      `immich-go build needs a version bump (see RedMan's Dockerfile). Details: ${detail}`;
  }

  if (/401|unauthorized|invalid api key/i.test(cause)) {
    return `Immich rejected the API key (unauthorized). Check the Immich server URL/API key in Settings. Details: ${detail}`;
  }

  if (/connection refused|no such host|ECONNREFUSED|dial tcp|context deadline exceeded/i.test(cause)) {
    return `Could not reach the Immich server. Check the server URL and network path. Details: ${detail}`;
  }

  // Generic fallback — keep it short and free of the CLI usage boilerplate.
  return detail;
}

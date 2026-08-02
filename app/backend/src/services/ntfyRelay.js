// ntfy relay — collects heartbeats from hosts that cannot reach RedMan.
//
// The Azure VM sits outside the home network and nothing there can open a
// connection inwards, so its schedules have no way to report in. Rather than
// punching a hole for them, they leave a signed line on the ntfy topic RedMan
// already talks to, and RedMan picks it up on its own outbound polls. The
// direction of every connection stays exactly as it was.
//
// Collection is deliberately stateless. Each poll re-reads an overlapping
// window and relies on the heartbeat's source reference for de-duplication, so
// a missed poll, a restart, or a slow message heals itself on the next round
// instead of leaving a permanent gap.

import db from '../db.js';
import { fetchWithoutRedirect } from './httpPolicy.js';
import { recordRelayedHeartbeat } from './externalJobs.js';

export const RELAY_PREFIX = 'redman-hb1';

const DEFAULT_POLL_SECONDS = 60;
const LOOKBACK_MINUTES = 15;
const REQUEST_TIMEOUT_MS = 20_000;
// Anyone who knows the topic can publish to it, and a poll asks for the whole
// backlog. A timeout bounds how long the transfer may take, not how large it
// may be, so the size needs its own ceiling.
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const START_DELAY_MS = 15_000;
const FAILURE_BACKOFF_MS = 5 * 60 * 1000;

let timer = null;
let stopped = true;
let polling = false;

const state = {
  lastPollAt: null,
  lastSuccessAt: null,
  lastError: null,
  lastRecorded: 0,
  lastRejected: 0,
  consecutiveFailures: 0,
};

function readSettings() {
  const rows = db.prepare(`
    SELECT key, value FROM settings
    WHERE key IN (
      'ntfy_bridge_enabled', 'ntfy_bridge_topic', 'ntfy_bridge_poll_seconds',
      'ntfy_server', 'ntfy_auth_type', 'ntfy_auth_token', 'ntfy_username', 'ntfy_password'
    )
  `).all();
  const settings = {};
  for (const row of rows) settings[row.key] = row.value;
  return settings;
}

export function isRelayConfigured(settings) {
  return settings.ntfy_bridge_enabled === 'true'
    && Boolean(settings.ntfy_server)
    && Boolean(settings.ntfy_bridge_topic);
}

function authHeader(settings) {
  const type = settings.ntfy_auth_type || 'none';
  if (type === 'token' && settings.ntfy_auth_token) {
    return `Bearer ${settings.ntfy_auth_token}`;
  }
  if (type === 'basic' && settings.ntfy_username && settings.ntfy_password) {
    return `Basic ${Buffer.from(`${settings.ntfy_username}:${settings.ntfy_password}`).toString('base64')}`;
  }
  return null;
}

/**
 * Parse one relayed line.
 *
 * Wire format, single spaces between the fixed fields:
 *   redman-hb1 <slug> <unix-ts> <exit|-> <duration|-> <signature> <message...>
 *
 * The message runs to the end of the line so it needs no escaping, which keeps
 * the sending side a plain `printf` in a shell script.
 */
export function parseRelayMessage(text) {
  if (typeof text !== 'string') return null;
  const line = text.trim();
  if (!line.startsWith(`${RELAY_PREFIX} `)) return null;

  const parts = line.split(' ');
  if (parts.length < 6) return null;
  const [, slug, ts, exitField, durationField, signature] = parts;
  const message = parts.slice(6).join(' ');

  const optional = field => (field === '-' || field === '' ? null : Number(field));
  const exitCode = optional(exitField);
  const duration = optional(durationField);
  if (exitCode !== null && !Number.isFinite(exitCode)) return null;
  if (duration !== null && !Number.isFinite(duration)) return null;

  return { slug, ts: Number(ts), exitCode, duration, signature, message };
}

/**
 * Read a response body, refusing anything past the ceiling.
 *
 * Returns null when the limit is exceeded, so a flooded topic costs one poll
 * rather than the process.
 */
async function readCapped(res, maxBytes) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!res.body) return null;

  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Read the topic once and record whatever verifies.
 *
 * Never throws: a relay that cannot reach the broker must not take down the
 * caller, and the failure is visible through the bridge's own status.
 */
export async function pollRelayOnce({ now = new Date() } = {}) {
  const settings = readSettings();
  if (!isRelayConfigured(settings)) {
    return { skipped: true, reason: 'not-configured' };
  }

  const url = `${settings.ntfy_server}/${encodeURIComponent(settings.ntfy_bridge_topic)}/json`
    + `?poll=1&since=${LOOKBACK_MINUTES}m`;
  const headers = {};
  const auth = authHeader(settings);
  if (auth) headers.Authorization = auth;

  const controller = new AbortController();
  const abort = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let body;
  try {
    const res = await fetchWithoutRedirect(url, { headers, signal: controller.signal });
    if (!res.ok) {
      return { ok: false, error: `ntfy returned ${res.status}` };
    }
    body = await readCapped(res, MAX_RESPONSE_BYTES);
    if (body === null) {
      return { ok: false, error: `response exceeded ${MAX_RESPONSE_BYTES} bytes` };
    }
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'request timed out' : err.message };
  } finally {
    clearTimeout(abort);
  }

  let seen = 0;
  let recorded = 0;
  let duplicate = 0;
  const rejected = [];

  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    let envelope;
    try {
      envelope = JSON.parse(line);
    } catch {
      continue;
    }
    if (envelope.event !== 'message') continue;

    const fields = parseRelayMessage(envelope.message);
    if (!fields) continue;
    seen += 1;

    const result = recordRelayedHeartbeat(db, fields, { now });
    if (!result.ok) {
      rejected.push({ slug: result.slug, reason: result.reason });
    } else if (result.duplicate) {
      duplicate += 1;
    } else {
      recorded += 1;
    }
  }

  return { ok: true, seen, recorded, duplicate, rejected };
}

function schedule(delayMs) {
  if (stopped) return null;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    runCycle().catch(err => {
      console.error('[ntfy-relay] Cycle failed:', err.message);
      if (!stopped) schedule(FAILURE_BACKOFF_MS);
    });
  }, delayMs);
  timer.unref?.();
  return timer;
}

function pollIntervalMs(settings) {
  const configured = Number(settings.ntfy_bridge_poll_seconds);
  const seconds = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_POLL_SECONDS;
  return Math.min(Math.max(seconds, 15), 3600) * 1000;
}

async function runCycle() {
  if (stopped || polling) return;
  polling = true;
  try {
    const settings = readSettings();
    const result = await pollRelayOnce();
    state.lastPollAt = new Date().toISOString();

    if (result.skipped) {
      state.lastError = null;
    } else if (result.ok) {
      state.lastSuccessAt = state.lastPollAt;
      state.lastError = null;
      state.consecutiveFailures = 0;
      state.lastRecorded = result.recorded;
      state.lastRejected = result.rejected.length;
      if (result.recorded > 0 || result.rejected.length > 0) {
        console.log(`[ntfy-relay] ${result.recorded} recorded, ${result.duplicate} already seen, ${result.rejected.length} rejected`);
      }
      for (const bad of result.rejected) {
        console.warn(`[ntfy-relay] Rejected heartbeat for ${bad.slug || 'unknown'}: ${bad.reason}`);
      }
    } else {
      state.consecutiveFailures += 1;
      state.lastError = result.error;
      console.warn(`[ntfy-relay] Poll failed (${state.consecutiveFailures}): ${result.error}`);
    }

    // A broker that is down should not be polled at the normal rate; the
    // schedules being relayed will surface as overdue on their own.
    schedule(result.ok === false ? FAILURE_BACKOFF_MS : pollIntervalMs(settings));
  } finally {
    polling = false;
  }
}

export function getRelayStatus() {
  const settings = readSettings();
  return {
    configured: isRelayConfigured(settings),
    topic: settings.ntfy_bridge_topic || null,
    running: !stopped,
    ...state,
  };
}

export function startNtfyRelay() {
  stopNtfyRelay();
  stopped = false;
  const settings = readSettings();
  if (!isRelayConfigured(settings)) {
    console.log('[ntfy-relay] Not configured; no heartbeats will be collected.');
    return null;
  }
  console.log(`[ntfy-relay] Polling ${settings.ntfy_bridge_topic} every ${pollIntervalMs(settings) / 1000}s`);
  return schedule(START_DELAY_MS);
}

export function stopNtfyRelay() {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
}

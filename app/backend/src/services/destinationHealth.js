import db from '../db.js';
import { validatePrivatePeerBaseUrl } from './peerUrlPolicy.js';
import { fetchWithoutRedirect } from './httpPolicy.js';
import { decryptPeerApiKey } from './peerSecrets.js';

// Asks each destination whether it is still fit to be written to.
//
// The peer answers this alongside its quota, but nothing used to ask on a
// schedule, so the answer only existed during a manual pairing sync. Kept apart
// from peerConnectivity: that probes an unauthenticated endpoint every few
// seconds, while this one is authenticated, writes an audit entry on the peer,
// and describes something that changes about as often as a disk degrades.

const PROBE_TIMEOUT_MS = 8_000;
const REFRESH_INTERVAL_MS = 30 * 60 * 1000;
// Past this the last answer is no longer evidence of anything current.
const EXPIRE_AFTER_MS = 6 * 60 * 60 * 1000;

const lastKnown = new Map();
let inFlight = null;
let lastRefreshAt = 0;
// Bumped whenever what we know is discarded, so an answer that was already in
// the air when that happened cannot land afterwards and be taken as current.
let generation = 0;

function listDestinations() {
  // Reporting status must not be able to fail: during shutdown the database is
  // already closed while a refresh may still be in flight.
  try {
    return db.prepare(`
      SELECT p1.id, p1.remote_instance AS name, p1.remote_url, p1.api_key_encrypted
      FROM pairing_requests p1
      INNER JOIN (
        SELECT COALESCE(remote_static_pubkey, remote_url) AS peer_key, MAX(id) AS max_id
        FROM pairing_requests
        WHERE direction = 'outgoing' AND status = 'accepted' AND api_key_encrypted IS NOT NULL
        GROUP BY COALESCE(remote_static_pubkey, remote_url)
      ) p2 ON p1.id = p2.max_id
    `).all();
  } catch {
    return [];
  }
}

async function askPeer(peer) {
  const base = { id: peer.id, name: peer.name, url: peer.remote_url };
  let url;
  try {
    url = `${validatePrivatePeerBaseUrl(peer.remote_url)}/peer/storage`;
  } catch {
    return { ...base, state: 'unknown', reason: 'this destination has no usable address' };
  }

  let apiKey;
  try {
    apiKey = decryptPeerApiKey(peer.api_key_encrypted);
  } catch {
    return { ...base, state: 'unknown', reason: 'the stored credential for this destination could not be read' };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const response = await fetchWithoutRedirect(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) {
      return { ...base, state: 'unknown', reason: `this destination answered HTTP ${response.status}` };
    }

    const data = await response.json();
    // A peer that has not been upgraded answers without this block. That is not
    // a fault of its disks, and must not read as one.
    if (!data.destination) {
      return { ...base, state: 'unknown', reason: 'this destination does not report disk health yet', prefix: data.prefix ?? null };
    }

    const d = data.destination;
    return {
      ...base,
      state: d.state || 'unknown',
      reason: d.reason || null,
      spill: d.spill || null,
      profile: d.profile ?? null,
      redundant: d.redundant ?? null,
      diskCount: d.diskCount ?? null,
      disksNeedingAttention: d.disksNeedingAttention ?? null,
      measuredAt: d.measuredAt ?? null,
      remoteStale: Boolean(d.stale),
      prefix: data.prefix ?? null,
      usedBytes: data.usedBytes ?? null,
      limitBytes: data.limitBytes ?? null,
    };
  } catch {
    return { ...base, state: 'unknown', reason: 'this destination could not be reached' };
  }
}

async function refresh() {
  const startedAt = generation;
  const answers = await Promise.all(listDestinations().map(askPeer));
  if (startedAt !== generation) return [];
  const now = Date.now();
  for (const answer of answers) lastKnown.set(answer.id, { answer, at: now });
  lastRefreshAt = now;
  return answers;
}

/**
 * Reports what each destination last said about itself.
 *
 * Answers from memory and refreshes behind the caller, so a status board never
 * waits on a remote host and a peer that has gone away cannot slow down the
 * page that would tell you it has. An answer old enough to have been overtaken
 * is dropped rather than shown, because a reassuring figure from this morning
 * is worse than admitting nothing is known.
 */
export function getDestinationHealth({ refreshIntervalMs = REFRESH_INTERVAL_MS } = {}) {
  const now = Date.now();

  if (!inFlight && now - lastRefreshAt > refreshIntervalMs) {
    inFlight = refresh()
      .catch(() => [])
      .finally(() => { inFlight = null; });
  }

  const destinations = [];
  for (const peer of listDestinations()) {
    const remembered = lastKnown.get(peer.id);
    if (!remembered || now - remembered.at > EXPIRE_AFTER_MS) {
      destinations.push({
        id: peer.id,
        name: peer.name,
        url: peer.remote_url,
        state: 'unknown',
        reason: remembered
          ? 'this destination has not answered recently enough to go on'
          : 'this destination has not been asked yet',
        ageMs: remembered ? now - remembered.at : null,
      });
      continue;
    }
    destinations.push({ ...remembered.answer, ageMs: now - remembered.at });
  }
  return destinations;
}

/** Forces the next call to ask again; used after pairing changes. */
export function clearDestinationHealthCache() {
  generation += 1;
  lastKnown.clear();
  lastRefreshAt = 0;
  inFlight = null;
}

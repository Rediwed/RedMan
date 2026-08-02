// Peer connectivity probing, shared by the peers route and the status board.
//
// Each call performs live HTTP probes, so results are cached briefly: the
// navbar polls this, and the status board polls it too. Without a cache the
// probe rate scales with the number of open tabs rather than with need.

import db from '../db.js';
import { validatePrivatePeerBaseUrl } from './peerUrlPolicy.js';
import { fetchWithoutRedirect } from './httpPolicy.js';

const PROBE_TIMEOUT_MS = 3_000;
const DEFAULT_MAX_AGE_MS = 15_000;

let cache = { at: 0, results: null, inFlight: null };

function listOutgoingPeers() {
  return db.prepare(`
    SELECT p1.id, p1.remote_instance as name, p1.remote_url, p1.updated_at,
           p1.handshake_version, p1.remote_fingerprint, p1.remote_static_pubkey
    FROM pairing_requests p1
    INNER JOIN (
      SELECT COALESCE(remote_static_pubkey, remote_url) AS peer_key, MAX(id) as max_id
      FROM pairing_requests
      WHERE direction = 'outgoing' AND status = 'accepted'
      GROUP BY COALESCE(remote_static_pubkey, remote_url)
    ) p2 ON p1.id = p2.max_id
    ORDER BY p1.created_at DESC
  `).all();
}

async function probePeer(peer) {
  const base = { id: peer.id, name: peer.name, url: peer.remote_url, last_seen_at: peer.updated_at };
  let discoverUrl;
  try {
    discoverUrl = `${validatePrivatePeerBaseUrl(peer.remote_url)}/peer/discover`;
  } catch {
    return { ...base, status: 'unknown' };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const response = await fetchWithoutRedirect(discoverUrl, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    clearTimeout(timer);
    if (!response.ok) return { ...base, status: 'unreachable' };

    const data = await response.json();
    if (data.service !== 'redman') return { ...base, status: 'unreachable' };
    return {
      ...base,
      status: 'online',
      instance: data.instance,
      version: data.version,
      hostname: data.hostname,
      handshake_version: peer.handshake_version || 1,
      fingerprint: peer.remote_fingerprint || null,
    };
  } catch {
    return { ...base, status: 'unreachable' };
  }
}

/**
 * Probe every accepted outgoing peer. Concurrent callers share one round of
 * probes rather than each starting their own.
 */
export async function getPeerConnectivity({ maxAgeMs = DEFAULT_MAX_AGE_MS, force = false } = {}) {
  if (!force && cache.results && Date.now() - cache.at < maxAgeMs) return cache.results;
  if (cache.inFlight) return cache.inFlight;

  cache.inFlight = (async () => {
    try {
      const results = await Promise.all(listOutgoingPeers().map(probePeer));
      cache = { at: Date.now(), results, inFlight: null };
      return results;
    } catch (err) {
      cache.inFlight = null;
      throw err;
    }
  })();

  return cache.inFlight;
}

export function clearPeerConnectivityCache() {
  cache = { at: 0, results: null, inFlight: null };
}

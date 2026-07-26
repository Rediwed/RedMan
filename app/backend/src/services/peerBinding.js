// Peer binding — resolves a Hyper Backup job's live destination.
//
// A job is bound to the peer's stable static identity (peer_static_pubkey), not
// to a snapshot of its address and API key. Re-pairing derives a brand new ECDH
// API key and may hand out a different address, so both are looked up at run
// time from the newest accepted outgoing pairing for that identity. Jobs that
// were configured manually (no pairing record) keep using the credential stored
// on the job itself.

const PAIRING_COLUMNS = 'id, remote_instance, remote_url, remote_static_pubkey, api_key_encrypted';

const ACCEPTED_OUTGOING = `
  FROM pairing_requests
  WHERE direction = 'outgoing' AND status = 'accepted'
    AND api_key_encrypted IS NOT NULL
`;

export function findPairingByStaticKey(db, staticPublicKey) {
  if (!staticPublicKey) return null;
  return db.prepare(`
    SELECT ${PAIRING_COLUMNS} ${ACCEPTED_OUTGOING}
      AND remote_static_pubkey = ?
    ORDER BY id DESC LIMIT 1
  `).get(staticPublicKey) || null;
}

export function findPairingByUrl(db, remoteUrl) {
  if (!remoteUrl) return null;
  return db.prepare(`
    SELECT ${PAIRING_COLUMNS} ${ACCEPTED_OUTGOING}
      AND remote_url = ?
    ORDER BY id DESC LIMIT 1
  `).get(remoteUrl) || null;
}

/**
 * Resolve the address and credential a job should use right now.
 *
 * Resolution order:
 *   1. identity — the newest accepted pairing for the job's static pubkey
 *   2. url      — only for jobs with no static identity yet (legacy/manual)
 *   3. job      — the credential stored on the job itself
 *
 * A job that carries a static identity never falls back to a URL match: another
 * instance answering on the same address is a different peer, and silently
 * trusting it would defeat the identity binding.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ id?: number, remote_url?: string, peer_static_pubkey?: string|null, remote_api_key_encrypted?: string|null }} job
 * @returns {{ source: 'identity'|'url'|'job', remoteUrl: string, apiKeyEncrypted: string, peerName: string|null, staticPublicKey: string|null, pairingId: number|null }}
 */
export function resolvePeerBinding(db, job) {
  const pairing = job.peer_static_pubkey
    ? findPairingByStaticKey(db, job.peer_static_pubkey)
    : findPairingByUrl(db, job.remote_url);

  if (pairing) {
    return {
      source: job.peer_static_pubkey ? 'identity' : 'url',
      remoteUrl: pairing.remote_url,
      apiKeyEncrypted: pairing.api_key_encrypted,
      peerName: pairing.remote_instance || null,
      staticPublicKey: pairing.remote_static_pubkey || null,
      pairingId: pairing.id,
    };
  }

  if (job.remote_api_key_encrypted) {
    return {
      source: 'job',
      remoteUrl: job.remote_url,
      apiKeyEncrypted: job.remote_api_key_encrypted,
      peerName: null,
      staticPublicKey: job.peer_static_pubkey || null,
      pairingId: null,
    };
  }

  throw new Error(job.peer_static_pubkey
    ? 'This peer is no longer paired — re-pair it in Settings, then re-select the destination on this job'
    : 'Hyper Backup peer credential is unavailable');
}

/**
 * Keep the cached address on a job in step with the pairing record so the UI and
 * SSH host fallback follow a peer that moved to a new address.
 *
 * @returns {boolean} whether the cached address changed
 */
export function syncJobRemoteUrl(db, job, resolvedUrl) {
  if (!job.id || !resolvedUrl || resolvedUrl === job.remote_url) return false;
  db.prepare(`UPDATE hyper_backup_jobs SET remote_url = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(resolvedUrl, job.id);
  job.remote_url = resolvedUrl;
  return true;
}

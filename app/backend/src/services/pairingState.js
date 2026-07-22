export function isPairingExpired(expiresAt, now = new Date()) {
  if (!expiresAt) return true;
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/.test(expiresAt) ? expiresAt : `${expiresAt}Z`;
  return new Date(normalized) < now;
}

export function findExistingPeer(db, staticPublicKey, displayName) {
  if (staticPublicKey) {
    const matched = db.prepare('SELECT id FROM authorized_peers WHERE static_pubkey = ?').get(staticPublicKey);
    if (matched) return matched;
  }

  return db.prepare(`
    SELECT id FROM authorized_peers
    WHERE name = ? AND static_pubkey IS NULL
    ORDER BY id DESC LIMIT 1
  `).get(displayName) || null;
}

function normalizeFingerprint(value) {
  return String(value || '').replace(/[^a-f0-9]/gi, '').toUpperCase();
}

export function assertFingerprintConfirmed(expectedFingerprint, confirmedFingerprint) {
  const expected = normalizeFingerprint(expectedFingerprint);
  const confirmed = normalizeFingerprint(confirmedFingerprint);
  if (!expected || !confirmed || expected !== confirmed) {
    throw new Error('Peer fingerprint confirmation does not match');
  }
  return true;
}
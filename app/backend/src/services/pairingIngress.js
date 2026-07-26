export const MAX_ACTIVE_INCOMING_PAIRINGS = 20;
export const MAX_INCOMING_PAIRING_ROWS = 500;

export function storeIncomingPairingRequest(database, request) {
  const store = database.transaction(() => {
    const duplicate = database.prepare('SELECT id FROM pairing_requests WHERE token = ?').get(request.token);
    if (duplicate) return { error: 'Duplicate pairing token', status: 409 };

    const active = database.prepare(`
      SELECT COUNT(*) AS count FROM pairing_requests
      WHERE direction = 'incoming'
        AND status IN ('pending', 'accepting')
        AND expires_at >= datetime('now')
    `).get().count;
    if (active >= MAX_ACTIVE_INCOMING_PAIRINGS) {
      return { error: 'Pairing request capacity reached; retry after pending requests expire', status: 429 };
    }

    const total = database.prepare(`
      SELECT COUNT(*) AS count FROM pairing_requests WHERE direction = 'incoming'
    `).get().count;
    if (total >= MAX_INCOMING_PAIRING_ROWS) {
      return { error: 'Pairing request history capacity reached; retry after cleanup', status: 503 };
    }

    const result = database.prepare(`
      INSERT INTO pairing_requests (direction, token, remote_instance, remote_url, remote_ssh_pubkey,
        status, handshake_version, remote_ephemeral_pubkey, remote_static_pubkey, remote_fingerprint,
        reciprocal_path, reciprocal_limit_bytes)
      VALUES ('incoming', ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
    `).run(
      request.token,
      request.instance,
      request.callbackUrl,
      request.sshPublicKey,
      request.handshakeVersion,
      request.ephemeralPublicKey,
      request.staticPublicKey,
      request.fingerprint,
      request.reciprocalPath || null,
      request.reciprocalLimitBytes || null,
    );
    return { ok: true, id: Number(result.lastInsertRowid) };
  });
  return store.immediate();
}
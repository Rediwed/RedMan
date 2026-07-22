import { replaceKeyAuthorization, revokeKey } from './sshManager.js';

export function reconcilePeerSshAuthorization(peer, nextAccess, actions = {}) {
  if (!peer?.ssh_public_key) {
    if (nextAccess.enabled && peer?.static_pubkey) {
      throw new Error('Paired peer has no SSH public key on record; re-pair before enabling it');
    }
    return { managed: false, external: true };
  }
  const replace = actions.replaceKeyAuthorization || replaceKeyAuthorization;
  const revoke = actions.revokeKey || revokeKey;

  if (!nextAccess.enabled) {
    return { managed: true, ...revoke(peer.ssh_public_key) };
  }

  const result = replace(peer.ssh_public_key, peer.ssh_public_key, {
    allowedPathPrefix: nextAccess.allowedPathPrefix,
    sourceIp: nextAccess.sourceIp || null,
  });
  return { managed: true, ...result };
}

export function reconcilePeerSshAuthorizationsAtStartup(database, actions = {}) {
  const peers = database.prepare(`
    SELECT id, static_pubkey, ssh_public_key, allowed_path_prefix,
      storage_limit_bytes, last_seen_ip, enabled
    FROM authorized_peers
    WHERE enabled = 1
    ORDER BY id
    LIMIT 101
  `).all();
  if (peers.length > 100) {
    database.prepare(`
      UPDATE authorized_peers SET enabled = 0, updated_at = datetime('now')
      WHERE enabled = 1 AND id NOT IN (
        SELECT id FROM authorized_peers WHERE enabled = 1 ORDER BY id LIMIT 100
      )
    `).run();
  }

  let managed = 0;
  let disabled = Math.max(0, peers.length - 100);
  const disable = database.prepare(`
    UPDATE authorized_peers SET enabled = 0, updated_at = datetime('now') WHERE id = ?
  `);
  for (const peer of peers.slice(0, 100)) {
    if (!peer.ssh_public_key) {
      if (peer.static_pubkey) {
        disable.run(peer.id);
        disabled += 1;
      }
      continue;
    }
    if (!peer.allowed_path_prefix || peer.allowed_path_prefix === '/' || peer.storage_limit_bytes <= 0) {
      disable.run(peer.id);
      disabled += 1;
      continue;
    }
    try {
      reconcilePeerSshAuthorization(peer, {
        enabled: true,
        allowedPathPrefix: peer.allowed_path_prefix,
        sourceIp: peer.last_seen_ip,
      }, actions);
      managed += 1;
    } catch (err) {
      disable.run(peer.id);
      disabled += 1;
      actions.onError?.(peer, err);
    }
  }
  return { scanned: Math.min(peers.length, 100), managed, disabled };
}
// Authelia forward auth header extraction (main API)
// and Bearer token validation (peer API)

const AUTH_DISABLED = process.env.AUTH_DISABLED === 'true';

// Main API: extract Authelia headers injected by Traefik forward auth
export function autheliaAuth(req, res, next) {
  if (AUTH_DISABLED) {
    req.user = { name: 'dev', email: 'dev@localhost', groups: [] };
    return next();
  }

  const remoteUser = req.headers['remote-user'];
  const remoteName = req.headers['remote-name'];
  const remoteEmail = req.headers['remote-email'];
  const remoteGroups = req.headers['remote-groups'];

  if (!remoteUser) {
    return res.status(401).json({ error: 'Unauthorized — Authelia headers missing' });
  }

  req.user = {
    name: remoteName || remoteUser,
    email: remoteEmail || '',
    groups: remoteGroups ? remoteGroups.split(',') : [],
  };
  next();
}

// Peer API: validate Bearer token against per-peer API keys in authorized_peers table
export function peerAuth(db) {
  const logAudit = db.prepare(`
    INSERT INTO peer_audit_log (peer_id, peer_name, action, details, ip_address)
    VALUES (?, ?, ?, ?, ?)
  `);

  return (req, res, next) => {
    const authHeader = req.headers.authorization;
    const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      logAudit.run(null, null, 'auth_failure', JSON.stringify({ reason: 'missing_token' }), ip);
      return res.status(401).json({ error: 'Unauthorized — Bearer token required' });
    }

    const token = authHeader.slice(7);
    const peer = db.prepare('SELECT * FROM authorized_peers WHERE api_key = ?').get(token);

    if (!peer) {
      logAudit.run(null, null, 'auth_failure', JSON.stringify({ reason: 'unknown_key' }), ip);
      return res.status(401).json({ error: 'Invalid API key' });
    }

    if (!peer.enabled) {
      logAudit.run(peer.id, peer.name, 'auth_failure', JSON.stringify({ reason: 'peer_disabled' }), ip);
      return res.status(403).json({ error: 'Peer is disabled' });
    }

    // Update last_seen_at
    db.prepare('UPDATE authorized_peers SET last_seen_at = datetime(\'now\') WHERE id = ?').run(peer.id);

    // Attach peer info to request for downstream use
    req.peer = {
      id: peer.id,
      name: peer.name,
      allowed_path_prefix: peer.allowed_path_prefix,
    };
    req.peerIp = ip;

    logAudit.run(peer.id, peer.name, 'auth_success', null, ip);
    next();
  };
}

// Authelia forward auth header extraction (main API)
// and Bearer token validation (peer API)

import { isIP } from 'node:net';

const AUTH_DISABLED = process.env.AUTH_DISABLED === 'true';
const ADMIN_GROUP = process.env.REDMAN_ADMIN_GROUP?.trim() || null;
const ADMIN_ROLE = process.env.REDMAN_ADMIN_ROLE?.trim() || null;
const DEVELOPMENT_AUTH_BYPASS = AUTH_DISABLED && process.env.NODE_ENV !== 'production';

if (process.env.NODE_ENV === 'production' && !ADMIN_GROUP && !ADMIN_ROLE) {
  throw new Error('Set REDMAN_ADMIN_GROUP and/or REDMAN_ADMIN_ROLE explicitly in production');
}

function normalizeIp(value) {
  return String(value || '').trim().replace(/^::ffff:/i, '').replace(/^\[|\]$/g, '');
}

function trustedProxyHosts() {
  const entries = String(process.env.TRUSTED_PROXIES || '')
    .split(',').map(entry => entry.trim()).filter(Boolean);
  if (process.env.NODE_ENV === 'production' && entries.length === 0) {
    throw new Error('TRUSTED_PROXIES must list the exact reverse-proxy source host in production');
  }
  return entries.map(entry => {
    const [address, prefix] = entry.split('/');
    const normalized = normalizeIp(address);
    const version = isIP(normalized);
    if (!version || (prefix && prefix !== (version === 4 ? '32' : '128'))) {
      throw new Error(`TRUSTED_PROXIES must contain only exact /32 or /128 hosts: ${entry}`);
    }
    return normalized;
  });
}

const TRUSTED_PROXY_HOSTS = trustedProxyHosts();

if (AUTH_DISABLED && process.env.NODE_ENV === 'production') {
  console.warn('[SECURITY] AUTH_DISABLED is set in production — ignoring, auth will be enforced.');
}

// Main API: extract Authelia headers injected by Traefik forward auth
export function autheliaAuth(req, res, next) {
  if (DEVELOPMENT_AUTH_BYPASS) {
    req.user = {
      name: 'dev',
      email: 'dev@localhost',
      groups: ADMIN_GROUP ? [ADMIN_GROUP] : [],
      role: ADMIN_ROLE,
      bridgeAdmin: true,
    };
    return next();
  }

  const sourceIp = normalizeIp(req.socket?.remoteAddress);
  if (!TRUSTED_PROXY_HOSTS.includes(sourceIp)) {
    return res.status(401).json({ error: 'Unauthorized — request did not originate from a trusted proxy' });
  }

  const remoteUser = req.headers['remote-user'];
  const remoteName = req.headers['remote-name'];
  const remoteEmail = req.headers['remote-email'];
  const remoteGroups = req.headers['remote-groups'];
  const remoteRole = req.headers['remote-role'];

  if (!remoteUser) {
    return res.status(401).json({ error: 'Unauthorized — Authelia headers missing' });
  }

  req.user = {
    name: remoteName || remoteUser,
    email: remoteEmail || '',
    groups: remoteGroups ? remoteGroups.split(',') : [],
    role: remoteRole || null,
  };
  next();
}

export function requireBridgeAdmin(req, res, next) {
  const hasAdminGroup = Boolean(ADMIN_GROUP && req.user?.groups?.map(group => group.trim()).includes(ADMIN_GROUP));
  const hasAdminRole = Boolean(ADMIN_ROLE && req.user?.role === ADMIN_ROLE);
  const hasDevelopmentAdmin = DEVELOPMENT_AUTH_BYPASS && req.user?.bridgeAdmin === true;
  if (!hasAdminGroup && !hasAdminRole && !hasDevelopmentAdmin) {
    const requirement = [ADMIN_GROUP, ADMIN_ROLE && `role ${ADMIN_ROLE}`].filter(Boolean).join(' or ')
      || 'a configured administrator authority';
    return res.status(403).json({ error: `Upgrade preparation requires membership in ${requirement}` });
  }
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

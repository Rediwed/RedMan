// Authelia forward auth header extraction (main API)
// and Bearer token validation (peer API)

import { safeIp } from '../utils/logRedact.js';

// Auth can only be disabled when BOTH flags are set AND NODE_ENV is not production.
// This double-gate prevents accidental exposure if a prod container is ever started
// with AUTH_DISABLED=true (e.g. a copy-pasted compose override).
const AUTH_DISABLED =
  process.env.AUTH_DISABLED === 'true' &&
  process.env.REDMAN_LOCAL_DEV === '1' &&
  process.env.NODE_ENV !== 'production';

if (process.env.AUTH_DISABLED === 'true' && !AUTH_DISABLED) {
  console.warn('[SECURITY] AUTH_DISABLED is set but ignored — auth enforced. Set REDMAN_LOCAL_DEV=1 and NODE_ENV!=production to bypass (local dev only).');
}

// Trusted proxy CIDRs/IPs that are allowed to inject Authelia forward-auth headers.
// Defaults to RFC1918 + loopback (homelab Traefik); override with TRUSTED_PROXIES env
// (comma-separated list of IPs or CIDRs). Empty string = trust all (NOT recommended).
const DEFAULT_TRUSTED_PROXIES = '127.0.0.1/8,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fc00::/7';
const TRUSTED_PROXIES = (process.env.TRUSTED_PROXIES ?? DEFAULT_TRUSTED_PROXIES)
  .split(',').map(s => s.trim()).filter(Boolean);

function ipToBytes(ip) {
  // IPv4
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    const parts = ip.split('.').map(Number);
    if (parts.some(p => p > 255)) return null;
    return Uint8Array.from([0,0,0,0,0,0,0,0,0,0,0xff,0xff, ...parts]);
  }
  // IPv6 (basic; handles :: shorthand)
  if (ip.includes(':')) {
    const cleaned = ip.replace(/^::ffff:/i, '').toLowerCase();
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(cleaned)) return ipToBytes(cleaned);
    const sides = ip.split('::');
    if (sides.length > 2) return null;
    const left = sides[0] ? sides[0].split(':') : [];
    const right = sides[1] ? sides[1].split(':') : [];
    const fillN = 8 - left.length - right.length;
    if (fillN < 0) return null;
    const groups = [...left, ...new Array(fillN).fill('0'), ...right];
    if (groups.length !== 8) return null;
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 8; i++) {
      const g = parseInt(groups[i] || '0', 16);
      if (Number.isNaN(g) || g < 0 || g > 0xffff) return null;
      bytes[i*2] = (g >> 8) & 0xff;
      bytes[i*2 + 1] = g & 0xff;
    }
    return bytes;
  }
  return null;
}

function inCidr(ip, cidr) {
  const [addr, bitsStr] = cidr.includes('/') ? cidr.split('/') : [cidr, cidr.includes(':') ? '128' : '32'];
  const ipBytes = ipToBytes(ip);
  const netBytes = ipToBytes(addr);
  if (!ipBytes || !netBytes) return false;
  let bits = parseInt(bitsStr, 10);
  if (Number.isNaN(bits)) return false;
  // Normalise IPv4 CIDR bits to the v4-mapped IPv6 representation
  if (!addr.includes(':') && bits <= 32) bits += 96;
  for (let i = 0; i < 16; i++) {
    if (bits >= 8) {
      if (ipBytes[i] !== netBytes[i]) return false;
      bits -= 8;
    } else if (bits > 0) {
      const mask = (0xff << (8 - bits)) & 0xff;
      if ((ipBytes[i] & mask) !== (netBytes[i] & mask)) return false;
      bits = 0;
    } else {
      return true;
    }
  }
  return true;
}

function isTrustedProxy(ip) {
  if (TRUSTED_PROXIES.length === 0) return true; // explicitly disabled
  if (!ip) return false;
  const cleaned = ip.replace(/^::ffff:/i, '');
  return TRUSTED_PROXIES.some(cidr => inCidr(cleaned, cidr));
}

// Main API: extract Authelia headers injected by Traefik forward auth
export function autheliaAuth(req, res, next) {
  if (AUTH_DISABLED) {
    req.user = { name: 'dev', email: 'dev@localhost', groups: [] };
    return next();
  }

  // Reject Authelia headers from untrusted sources to prevent spoofing if
  // :8090 is ever exposed without Traefik in front.
  const socketIp = req.socket?.remoteAddress;
  const hasAutheliaHeaders = !!(req.headers['remote-user'] || req.headers['remote-groups'] || req.headers['remote-email'] || req.headers['remote-name']);
  if (hasAutheliaHeaders && !isTrustedProxy(socketIp)) {
    console.warn(`[SECURITY] Rejected Authelia headers from untrusted source ${safeIp(socketIp)}`);
    return res.status(401).json({ error: 'Unauthorized — Authelia headers from untrusted source' });
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
    // Prefer socket address; fall back to XFF only when behind a trusted proxy.
    const rawIp = isTrustedProxy(req.socket?.remoteAddress)
      ? (req.headers['x-forwarded-for'] || req.socket?.remoteAddress)
      : req.socket?.remoteAddress;
    const ip = safeIp(rawIp);

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

    // Update last_seen_at and last_seen_ip
    db.prepare('UPDATE authorized_peers SET last_seen_at = datetime(\'now\'), last_seen_ip = ? WHERE id = ?').run(ip, peer.id);

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

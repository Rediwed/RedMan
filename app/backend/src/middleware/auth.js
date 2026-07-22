// Forward-auth header extraction (main API) and Bearer token validation (peer API).
// Native local sessions are handled separately by mainAuth.js.

import { safeIp } from '../utils/logRedact.js';
import { hashPeerApiKey } from '../services/peerSecrets.js';

const ADMIN_GROUP = process.env.REDMAN_ADMIN_GROUP?.trim() || null;
const ADMIN_ROLE = process.env.REDMAN_ADMIN_ROLE?.trim() || null;
const UPGRADE_BRIDGE_MODE = process.env.REDMAN_UPGRADE_BRIDGE === 'true';

if (process.env.NODE_ENV === 'production' && UPGRADE_BRIDGE_MODE && !ADMIN_GROUP && !ADMIN_ROLE) {
  throw new Error('Set REDMAN_ADMIN_GROUP and/or REDMAN_ADMIN_ROLE explicitly in production upgrade-bridge mode');
}

// Production startup validates TRUSTED_PROXIES as exact host addresses. The
// loopback fallback and explicit wildcard are available only outside production.
const DEFAULT_TRUSTED_PROXIES = '127.0.0.1/8,::1/128';
const TRUST_ALL = process.env.TRUSTED_PROXIES === '*';
const TRUSTED_PROXIES = TRUST_ALL
  ? []
  : (process.env.TRUSTED_PROXIES ?? DEFAULT_TRUSTED_PROXIES)
    .split(',').map(s => s.trim()).filter(Boolean);

if (TRUST_ALL) {
  console.warn('[SECURITY] TRUSTED_PROXIES=* — every source is trusted to supply forward-auth headers. Do not expose this port publicly.');
}

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

export function isTrustedProxy(ip) {
  if (TRUST_ALL) return true;
  if (TRUSTED_PROXIES.length === 0) return false; // empty allowlist = trust none
  if (!ip) return false;
  const cleaned = ip.replace(/^::ffff:/i, '');
  return TRUSTED_PROXIES.some(cidr => inCidr(cleaned, cidr));
}

export function getAuthClientIp(req) {
  const socketIp = req.socket?.remoteAddress;
  if (!isTrustedProxy(socketIp)) return safeIp(socketIp);
  const forwarded = String(req.headers['x-forwarded-for'] || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  for (let index = forwarded.length - 1; index >= 0; index--) {
    if (!isTrustedProxy(forwarded[index])) return safeIp(forwarded[index]);
  }
  return safeIp(socketIp);
}

// Main API: extract identity headers injected by the forward-auth proxy.
export function proxyHeaderAuth(req, res, next) {
  // Reject identity headers from untrusted sources to prevent spoofing if
  // :8090 is ever exposed without Traefik in front.
  const socketIp = req.socket?.remoteAddress;
  const hasForwardAuthHeaders = !!(req.headers['remote-user'] || req.headers['remote-groups'] || req.headers['remote-email'] || req.headers['remote-name'] || req.headers['remote-role']);
  if (hasForwardAuthHeaders && !isTrustedProxy(socketIp)) {
    console.warn(`[SECURITY] Rejected forward-auth headers from untrusted source ${safeIp(socketIp)}`);
    return res.status(401).json({ error: 'Unauthorized — forward-auth headers from untrusted source' });
  }

  const remoteUser = req.headers['remote-user'];
  const remoteName = req.headers['remote-name'];
  const remoteEmail = req.headers['remote-email'];
  const remoteGroups = req.headers['remote-groups'];
  const remoteRole = req.headers['remote-role'];

  if (!remoteUser) {
    return res.status(401).json({ error: 'Unauthorized — forward-auth headers missing' });
  }

  req.proxyIdentity = {
    subject: remoteUser,
    displayName: remoteName || remoteUser,
    email: remoteEmail || '',
    groups: remoteGroups ? remoteGroups.split(',') : [],
    role: remoteRole || null,
  };
  req.user = req.proxyIdentity;
  next();
}

// Backward-compatible export for existing integrations; new code uses the
// provider-neutral mainApiAuth boundary and proxyHeaderAuth provider.
export const autheliaAuth = proxyHeaderAuth;

export function requireBridgeAdmin(req, res, next) {
  const identities = req.proxyIdentity ? [req.proxyIdentity] : [req.user].filter(Boolean);
  const requiredRole = ADMIN_ROLE?.toLowerCase();
  const hasAdminGroup = Boolean(ADMIN_GROUP && identities.some(identity =>
    identity.groups?.map(group => group.trim()).includes(ADMIN_GROUP)));
  const hasAdminRole = Boolean(requiredRole && identities.some(identity =>
    String(identity.role || '').toLowerCase() === requiredRole));
  const hasNativeAdmin = !req.proxyIdentity
    && identities.some(identity => String(identity.role || '').toLowerCase() === 'admin');
  if (!hasAdminGroup && !hasAdminRole && !hasNativeAdmin) {
    const requirement = [ADMIN_GROUP, ADMIN_ROLE && `role ${ADMIN_ROLE}`].filter(Boolean).join(' or ')
      || 'an administrator account';
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
  const touchPeer = db.prepare(`
    UPDATE authorized_peers SET last_seen_at = datetime('now'), last_seen_ip = ?
    WHERE id = ? AND (
      last_seen_at IS NULL OR last_seen_at < datetime('now', '-60 seconds')
      OR COALESCE(last_seen_ip, '') != ?
    )
  `);
  const successfulAuthAuditAt = new Map();

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
    const peer = db.prepare('SELECT * FROM authorized_peers WHERE api_key_hash = ?').get(hashPeerApiKey(token));

    if (!peer) {
      logAudit.run(null, null, 'auth_failure', JSON.stringify({ reason: 'unknown_key' }), ip);
      return res.status(401).json({ error: 'Invalid API key' });
    }

    if (!peer.enabled) {
      logAudit.run(peer.id, peer.name, 'auth_failure', JSON.stringify({ reason: 'peer_disabled' }), ip);
      return res.status(403).json({ error: 'Peer is disabled' });
    }

    // Keep presence fresh without turning every authenticated request into a write.
    touchPeer.run(ip, peer.id, ip);

    // Attach peer info to request for downstream use
    req.peer = {
      id: peer.id,
      name: peer.name,
      allowed_path_prefix: peer.allowed_path_prefix,
      storage_limit_bytes: peer.storage_limit_bytes,
      static_pubkey: peer.static_pubkey,
    };
    req.peerIp = ip;

    const now = Date.now();
    if (now - (successfulAuthAuditAt.get(peer.id) || 0) >= 5 * 60 * 1000) {
      logAudit.run(peer.id, peer.name, 'auth_success', null, ip);
      successfulAuthAuditAt.set(peer.id, now);
    }
    next();
  };
}

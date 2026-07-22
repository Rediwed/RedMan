import { proxyHeaderAuth } from './auth.js';
import { resolveProxyAccount, findActiveSession, verifySessionCsrf } from '../services/authService.js';
import { getCsrfCookie, getSessionCookie } from '../services/sessionCookies.js';
import { safeIp } from '../utils/logRedact.js';

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function hasAllowedOrigin(req, config) {
  let origin = req.headers.origin;
  if (!origin && req.headers.referer) {
    try { origin = new URL(req.headers.referer).origin; } catch { return false; }
  }
  return Boolean(origin && config.allowedCredentialOrigins?.has(origin));
}

function unauthorized(res, message = 'Authentication required') {
  return res.status(401).json({ error: message });
}

export function createMainApiAuth(db, config) {
  return (req, res, next) => {
    req.authMode = config.mode;

    if (config.mode === 'development') {
      req.user = {
        id: 0,
        provider: 'development',
        username: 'dev',
        name: 'Developer',
        displayName: 'Developer',
        email: 'dev@localhost',
        role: 'admin',
        enabled: true,
      };
      return next();
    }

    if (config.mode === 'proxy') {
      if (STATE_CHANGING_METHODS.has(req.method) && !hasAllowedOrigin(req, config)) {
        return res.status(403).json({ error: 'Cross-site mutation rejected' });
      }
      return proxyHeaderAuth(req, res, () => {
        try {
          req.user = resolveProxyAccount(db, req.proxyIdentity, config.proxyAutoProvisionRole, {
            ipAddress: safeIp(req.socket?.remoteAddress),
          });
          next();
        } catch (err) {
          res.status(err.status || 401).json({ error: err.message || 'Authentication required' });
        }
      });
    }

    const session = findActiveSession(db, getSessionCookie(req), config);
    if (!session) return unauthorized(res);
    req.authSession = session;
    req.user = session.user;

    if (STATE_CHANGING_METHODS.has(req.method)) {
      const csrfHeader = req.headers['x-csrf-token'];
      if (typeof csrfHeader !== 'string' || !verifySessionCsrf(session, getCsrfCookie(req), csrfHeader)) {
        return res.status(403).json({ error: 'CSRF validation failed' });
      }
    }
    return next();
  };
}
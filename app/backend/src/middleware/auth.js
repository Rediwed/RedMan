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

// Peer API: validate Bearer token against configured peer API key
export function peerAuth(db) {
  return (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized — Bearer token required' });
    }

    const token = authHeader.slice(7);
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('peer_api_key');
    const configuredKey = row?.value;

    if (!configuredKey || configuredKey.length === 0) {
      return res.status(503).json({ error: 'Peer API key not configured' });
    }

    // Constant-time comparison to prevent timing attacks
    if (token.length !== configuredKey.length) {
      return res.status(401).json({ error: 'Invalid API key' });
    }
    let mismatch = 0;
    for (let i = 0; i < token.length; i++) {
      mismatch |= token.charCodeAt(i) ^ configuredKey.charCodeAt(i);
    }
    if (mismatch !== 0) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    next();
  };
}

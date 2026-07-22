import { Router } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import {
  authenticateLocalUser,
  bootstrapAdmin,
  changeLocalPassword,
  createLocalUser,
  createSession,
  findActiveSession,
  getLocalUserCount,
  listAuthUsers,
  resetPasswordWithRecovery,
  revokeSession,
  revokeUserSessions,
  updateAuthUser,
} from '../services/authService.js';
import {
  clearSessionCookies,
  getSessionCookie,
  setSessionCookies,
} from '../services/sessionCookies.js';
import { getAuthClientIp } from '../middleware/auth.js';

function requestContext(req) {
  return {
    ipAddress: getAuthClientIp(req),
    userAgent: req.headers['user-agent'] || null,
  };
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Insufficient permission' });
  return next();
}

function localOnly(config, req, res) {
  if (config.mode !== 'local') {
    res.status(409).json({ error: 'Local authentication is not enabled' });
    return false;
  }
  return true;
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function requireAllowedOrigin(config, req, res, next) {
  let origin = req.headers.origin;
  if (!origin && req.headers.referer) {
    try { origin = new URL(req.headers.referer).origin; } catch { origin = null; }
  }
  if (!origin) {
    if (config.publicOrigin) return res.status(403).json({ error: 'Authentication request origin required' });
    return next();
  }
  if (!config.allowedCredentialOrigins.has(origin)) {
    return res.status(403).json({ error: 'Cross-site authentication request rejected' });
  }
  return next();
}

export function createAuthRouter({ db, config, mainApiAuth }) {
  const router = Router();
  const credentialOrigin = requireAllowedOrigin.bind(null, config);
  const credentialLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: req => ipKeyGenerator(getAuthClientIp(req)),
    message: { error: 'Too many authentication attempts; try again later' },
  });

  router.get('/status', (req, res) => {
    const localUsers = getLocalUserCount(db);
    res.json({
      mode: config.mode,
      requiresBootstrap: config.mode === 'local' && localUsers === 0,
      bootstrapConfigured: config.mode === 'local' && config.bootstrapConfigured,
    });
  });

  function revokePresentedSession(req) {
    const presented = findActiveSession(db, getSessionCookie(req), config);
    if (presented) revokeSession(db, presented.sessionId, requestContext(req));
  }

  router.post('/bootstrap', credentialOrigin, credentialLimiter, asyncRoute(async (req, res) => {
    if (!localOnly(config, req, res)) return;
    const user = await bootstrapAdmin(db, {
      bootstrapToken: req.body.bootstrap_token,
      configuredToken: config.bootstrapToken,
      username: req.body.username,
      password: req.body.password,
      displayName: req.body.display_name,
      email: req.body.email,
      ...requestContext(req),
    });
    revokePresentedSession(req);
    const session = createSession(db, user.id, config, requestContext(req));
    setSessionCookies(res, session, config);
    res.status(201).json({ user, mode: config.mode });
  }));

  router.post('/login', credentialOrigin, credentialLimiter, asyncRoute(async (req, res) => {
    if (!localOnly(config, req, res)) return;
    const user = await authenticateLocalUser(db, req.body.username, req.body.password, requestContext(req));
    revokePresentedSession(req);
    const session = createSession(db, user.id, config, requestContext(req));
    setSessionCookies(res, session, config);
    res.json({ user, mode: config.mode });
  }));

  router.post('/recover', credentialOrigin, credentialLimiter, asyncRoute(async (req, res) => {
    if (!localOnly(config, req, res)) return;
    await resetPasswordWithRecovery(db, {
      username: req.body.username,
      recoveryToken: req.body.recovery_token,
      newPassword: req.body.new_password,
      ...requestContext(req),
    });
    clearSessionCookies(res, config);
    res.json({ success: true });
  }));

  router.get('/session', mainApiAuth, (req, res) => {
    res.json({ user: req.user, mode: config.mode });
  });

  router.post('/logout', mainApiAuth, (req, res) => {
    if (req.authSession) revokeSession(db, req.authSession.sessionId, {
      actorUserId: req.user.id,
      ...requestContext(req),
    });
    clearSessionCookies(res, config);
    res.json({ success: true });
  });

  router.post('/password', mainApiAuth, asyncRoute(async (req, res) => {
    if (!localOnly(config, req, res)) return;
    if (req.user.provider !== 'local') return res.status(400).json({ error: 'Proxy accounts do not have local passwords' });
    await changeLocalPassword(db, req.user.id, req.body.current_password, req.body.new_password, {
      actorUserId: req.user.id,
      ...requestContext(req),
    });
    const session = createSession(db, req.user.id, config, requestContext(req));
    setSessionCookies(res, session, config);
    res.json({ success: true });
  }));

  router.get('/users', mainApiAuth, requireAdmin, (req, res) => {
    res.json(listAuthUsers(db));
  });

  router.post('/users', mainApiAuth, requireAdmin, asyncRoute(async (req, res) => {
    if (config.mode !== 'local') return res.status(409).json({ error: 'Local user creation requires local authentication mode' });
    const user = await createLocalUser(db, {
      username: req.body.username,
      password: req.body.password,
      role: req.body.role,
      displayName: req.body.display_name,
      email: req.body.email,
      actorUserId: req.user.id,
      ...requestContext(req),
    });
    res.status(201).json(user);
  }));

  router.put('/users/:id', mainApiAuth, requireAdmin, (req, res) => {
    try {
      const user = updateAuthUser(db, Number(req.params.id), req.body, {
        actorUserId: req.user.id,
        ...requestContext(req),
      });
      res.json(user);
    } catch (err) {
      res.status(err.message === 'User not found' ? 404 : 400).json({ error: err.message });
    }
  });

  router.post('/users/:id/revoke-sessions', mainApiAuth, requireAdmin, (req, res) => {
    const userId = Number(req.params.id);
    if (!db.prepare('SELECT id FROM auth_users WHERE id = ?').get(userId)) {
      return res.status(404).json({ error: 'User not found' });
    }
    const revoked = revokeUserSessions(db, userId);
    return res.json({ revoked });
  });

  router.get('/audit', mainApiAuth, requireAdmin, (req, res) => {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
    const total = db.prepare('SELECT COUNT(*) AS count FROM auth_audit_log').get().count;
    const entries = db.prepare(`
      SELECT a.*, u.username, actor.username AS actor_username
      FROM auth_audit_log a
      LEFT JOIN auth_users u ON u.id = a.user_id
      LEFT JOIN auth_users actor ON actor.id = a.actor_user_id
      ORDER BY datetime(a.created_at) DESC, a.id DESC LIMIT ? OFFSET ?
    `).all(limit, (page - 1) * limit);
    res.json({ entries, page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) });
  });

  router.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err.status) return res.status(err.status).json({ error: err.message });
    if (String(err.code || '').startsWith('SQLITE_CONSTRAINT')) {
      return res.status(409).json({ error: 'An account with that identity already exists' });
    }
    if (/^(Username|Password|Role|Display name|Email)/.test(err.message || '')) {
      return res.status(400).json({ error: err.message });
    }
    return next(err);
  });

  return router;
}

export default createAuthRouter;

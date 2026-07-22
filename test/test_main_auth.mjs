import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const fixture = resolve(import.meta.dirname, 'data', `main-auth-${process.pid}`);
mkdirSync(fixture, { recursive: true });
process.env.DB_PATH = resolve(fixture, 'redman.db');

const { default: db } = await import('../app/backend/src/db.js');
const { createMainApiAuth } = await import('../app/backend/src/middleware/mainAuth.js');
const { bootstrapAdmin, createSession } = await import('../app/backend/src/services/authService.js');
const { parseCookies, setSessionCookies } = await import('../app/backend/src/services/sessionCookies.js');

function response() {
  return {
    statusCode: null,
    body: null,
    headers: [],
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    append(name, value) { this.headers.push([name, value]); },
  };
}

function invoke(middleware, req) {
  const res = response();
  let nextCalled = false;
  middleware(req, res, () => { nextCalled = true; });
  return { req, res, nextCalled };
}

try {
  const development = invoke(createMainApiAuth(db, { mode: 'development' }), {
    method: 'DELETE', headers: {}, socket: { remoteAddress: '127.0.0.1' },
  });
  assert.equal(development.nextCalled, true);
  assert.equal(development.req.user.role, 'admin');

  const proxyConfig = {
    mode: 'proxy',
    proxyAutoProvisionRole: 'viewer',
    allowedCredentialOrigins: new Set(['https://redman.example.test']),
  };
  const proxy = invoke(createMainApiAuth(db, proxyConfig), {
    method: 'GET',
    headers: { 'remote-user': 'proxy.viewer@example.com', 'remote-name': 'Proxy Viewer' },
    socket: { remoteAddress: '127.0.0.1' },
  });
  assert.equal(proxy.nextCalled, true);
  assert.equal(proxy.req.user.role, 'viewer');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM auth_users WHERE provider = 'proxy'").get().count, 1);

  const proxyMutationWithoutOrigin = invoke(createMainApiAuth(db, proxyConfig), {
    method: 'POST',
    headers: { 'remote-user': 'proxy.viewer@example.com' },
    socket: { remoteAddress: '127.0.0.1' },
  });
  assert.equal(proxyMutationWithoutOrigin.res.statusCode, 403);
  const proxyMutationWithOrigin = invoke(createMainApiAuth(db, proxyConfig), {
    method: 'POST',
    headers: { 'remote-user': 'proxy.viewer@example.com', origin: 'https://redman.example.test' },
    socket: { remoteAddress: '127.0.0.1' },
  });
  assert.equal(proxyMutationWithOrigin.nextCalled, true);

  const admin = await bootstrapAdmin(db, {
    bootstrapToken: 'bootstrap-token',
    configuredToken: 'bootstrap-token',
    username: 'localadmin',
    password: 'correct horse battery staple',
  });
  const config = {
    mode: 'local', secureCookies: true, sessionIdleMinutes: 30, sessionAbsoluteHours: 24,
  };
  const session = createSession(db, admin.id, config);
  const cookieHeader = `redman_session=${session.token}; redman_csrf=${session.csrfToken}`;

  const proxyIgnoresLocalCookie = invoke(createMainApiAuth(db, { ...proxyConfig, proxyAutoProvisionRole: null }), {
    method: 'GET', headers: { cookie: cookieHeader }, socket: { remoteAddress: '127.0.0.1' },
  });
  assert.equal(proxyIgnoresLocalCookie.res.statusCode, 401);

  const localIgnoresProxyHeaders = invoke(createMainApiAuth(db, config), {
    method: 'GET', headers: { 'remote-user': 'proxy.viewer@example.com' }, socket: { remoteAddress: '127.0.0.1' },
  });
  assert.equal(localIgnoresProxyHeaders.res.statusCode, 401);

  const localRead = invoke(createMainApiAuth(db, config), {
    method: 'GET', headers: { cookie: cookieHeader }, socket: { remoteAddress: '127.0.0.1' },
  });
  assert.equal(localRead.nextCalled, true);
  assert.equal(localRead.req.user.role, 'admin');

  const missingCsrf = invoke(createMainApiAuth(db, config), {
    method: 'POST', headers: { cookie: cookieHeader }, socket: { remoteAddress: '127.0.0.1' },
  });
  assert.equal(missingCsrf.nextCalled, false);
  assert.equal(missingCsrf.res.statusCode, 403);

  const validCsrf = invoke(createMainApiAuth(db, config), {
    method: 'POST',
    headers: { cookie: cookieHeader, 'x-csrf-token': session.csrfToken },
    socket: { remoteAddress: '127.0.0.1' },
  });
  assert.equal(validCsrf.nextCalled, true);

  db.prepare("UPDATE auth_users SET enabled = 0 WHERE provider = 'proxy'").run();
  const disabledProxy = invoke(createMainApiAuth(db, proxyConfig), {
    method: 'GET',
    headers: { 'remote-user': 'proxy.viewer@example.com' },
    socket: { remoteAddress: '127.0.0.1' },
  });
  assert.equal(disabledProxy.res.statusCode, 403);

  const cookieResponse = response();
  setSessionCookies(cookieResponse, session, config);
  assert.equal(cookieResponse.headers.length, 2);
  assert.match(cookieResponse.headers[0][1], /HttpOnly/);
  assert.match(cookieResponse.headers[0][1], /Secure/);
  assert.match(cookieResponse.headers[0][1], /SameSite=Strict/);
  assert.doesNotMatch(cookieResponse.headers[1][1], /HttpOnly/);
  assert.equal(parseCookies(cookieHeader).redman_session, session.token);

  console.log('Main auth boundary: development, proxy, local session, CSRF, and cookie attributes passed');
} finally {
  db.close();
  rmSync(fixture, { recursive: true, force: true });
}

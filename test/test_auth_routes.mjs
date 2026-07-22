import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const fixture = resolve(import.meta.dirname, 'data', `auth-routes-${process.pid}`);
mkdirSync(fixture, { recursive: true });
process.env.DB_PATH = resolve(fixture, 'redman.db');

const require = createRequire(resolve(import.meta.dirname, '../app/package.json'));
const express = require('express');
const { default: db } = await import('../app/backend/src/db.js');
const { createMainApiAuth } = await import('../app/backend/src/middleware/mainAuth.js');
const { issueRecoveryToken } = await import('../app/backend/src/services/authService.js');
const { authorizeApiRoute } = await import('../app/backend/src/services/routePermissions.js');
const { createAuthRouter } = await import('../app/backend/src/routes/auth.js');

const config = {
  mode: 'local',
  bootstrapConfigured: true,
  bootstrapToken: 'route-bootstrap-token',
  secureCookies: false,
  sessionIdleMinutes: 30,
  sessionAbsoluteHours: 24,
  recoveryMinutes: 15,
  allowedCredentialOrigins: new Set(['http://127.0.0.1']),
};
const mainApiAuth = createMainApiAuth(db, config);
const app = express();
app.use(express.json());
app.use('/api/auth', createAuthRouter({ db, config, mainApiAuth }));
app.use('/api', mainApiAuth, authorizeApiRoute);
app.get('/api/ssd-backup/configs', (req, res) => res.json({ role: req.user.role }));
app.post('/api/ssd-backup/configs/1/run', (req, res) => res.json({ started: true }));
app.use((err, req, res, next) => {
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

const server = await new Promise(resolveServer => {
  const instance = app.listen(0, '127.0.0.1', () => resolveServer(instance));
});
const baseUrl = `http://127.0.0.1:${server.address().port}`;

function cookiesFrom(response) {
  const values = response.headers.getSetCookie?.() || [response.headers.get('set-cookie')].filter(Boolean);
  return values.map(value => value.split(';')[0]).join('; ');
}

function csrfFrom(cookieHeader) {
  const match = cookieHeader.match(/(?:^|; )redman_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

async function request(path, { method = 'GET', body, cookies, csrf, origin } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookies) headers.Cookie = cookies;
  if (csrf) headers['X-CSRF-Token'] = csrf;
  if (origin) headers.Origin = origin;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  return { response, payload, cookies: cookiesFrom(response) };
}

try {
  const status = await request('/api/auth/status');
  assert.equal(status.response.status, 200);
  assert.equal(status.payload.requiresBootstrap, true);

  const badBootstrap = await request('/api/auth/bootstrap', {
    method: 'POST',
    body: { bootstrap_token: 'wrong', username: 'admin', password: 'correct horse battery staple' },
  });
  assert.equal(badBootstrap.response.status, 401);

  const bootstrap = await request('/api/auth/bootstrap', {
    method: 'POST',
    body: {
      bootstrap_token: config.bootstrapToken,
      username: 'admin',
      password: 'correct horse battery staple',
      display_name: 'Admin',
    },
  });
  assert.equal(bootstrap.response.status, 201);
  assert.equal(bootstrap.payload.user.role, 'admin');
  assert.match(bootstrap.cookies, /redman_session=/);
  assert.match(bootstrap.cookies, /redman_csrf=/);
  let adminCookies = bootstrap.cookies;
  let adminCsrf = csrfFrom(adminCookies);

  const secondBootstrap = await request('/api/auth/bootstrap', {
    method: 'POST',
    body: { bootstrap_token: config.bootstrapToken, username: 'second', password: 'another long password' },
  });
  assert.equal(secondBootstrap.response.status, 409);

  const crossSiteLogin = await request('/api/auth/login', {
    method: 'POST',
    origin: 'https://attacker.example',
    body: { username: 'admin', password: 'correct horse battery staple' },
  });
  assert.equal(crossSiteLogin.response.status, 403);

  assert.equal((await request('/api/auth/session', { cookies: adminCookies })).payload.user.role, 'admin');
  assert.equal((await request('/api/auth/logout', { method: 'POST', cookies: adminCookies })).response.status, 403);

  const viewerCreate = await request('/api/auth/users', {
    method: 'POST',
    cookies: adminCookies,
    csrf: adminCsrf,
    body: { username: 'viewer', password: 'viewer password is long enough', role: 'viewer' },
  });
  assert.equal(viewerCreate.response.status, 201);
  assert.equal(viewerCreate.payload.role, 'viewer');

  const viewerLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { username: 'viewer', password: 'viewer password is long enough' },
  });
  assert.equal(viewerLogin.response.status, 200);
  const viewerCookies = viewerLogin.cookies;
  const viewerCsrf = csrfFrom(viewerCookies);
  assert.equal((await request('/api/ssd-backup/configs', { cookies: viewerCookies })).response.status, 200);
  assert.equal((await request('/api/ssd-backup/configs/1/run', {
    method: 'POST', cookies: viewerCookies, csrf: viewerCsrf, body: {},
  })).response.status, 403);
  assert.equal((await request('/api/auth/users', { cookies: viewerCookies })).response.status, 403);

  const users = await request('/api/auth/users', { cookies: adminCookies });
  assert.equal(users.response.status, 200);
  assert.equal(users.payload.length, 2);
  const audit = await request('/api/auth/audit', { cookies: adminCookies });
  assert.equal(audit.response.status, 200);
  assert.ok(audit.payload.entries.length > 0);

  const rotatedLogin = await request('/api/auth/login', {
    method: 'POST',
    cookies: adminCookies,
    body: { username: 'admin', password: 'correct horse battery staple' },
  });
  assert.equal(rotatedLogin.response.status, 200);
  assert.notEqual(rotatedLogin.cookies, adminCookies);
  assert.equal((await request('/api/auth/session', { cookies: adminCookies })).response.status, 401);
  adminCookies = rotatedLogin.cookies;
  adminCsrf = csrfFrom(adminCookies);

  const logout = await request('/api/auth/logout', {
    method: 'POST', cookies: adminCookies, csrf: adminCsrf, body: {},
  });
  assert.equal(logout.response.status, 200);
  assert.equal((await request('/api/auth/session', { cookies: adminCookies })).response.status, 401);

  const failedLogin = await request('/api/auth/login', {
    method: 'POST', body: { username: 'admin', password: 'wrong password' },
  });
  assert.equal(failedLogin.response.status, 401);
  assert.equal(failedLogin.payload.error, 'Invalid username or password');

  const recovery = issueRecoveryToken(db, 'viewer', config);
  const recovered = await request('/api/auth/recover', {
    method: 'POST',
    body: {
      username: 'viewer',
      recovery_token: recovery.token,
      new_password: 'viewer recovered password 2026',
    },
  });
  assert.equal(recovered.response.status, 200);
  assert.equal((await request('/api/auth/session', { cookies: viewerCookies })).response.status, 401);
  assert.equal((await request('/api/auth/login', {
    method: 'POST',
    body: { username: 'viewer', password: 'viewer recovered password 2026' },
  })).response.status, 200);

  console.log('Authentication routes: bootstrap, cookies, CSRF, viewer authorization, recovery, rotation, audit, and logout passed');
} finally {
  await new Promise(resolveClose => server.close(resolveClose));
  db.close();
  rmSync(fixture, { recursive: true, force: true });
}

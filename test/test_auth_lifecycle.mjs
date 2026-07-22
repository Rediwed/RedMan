import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const fixture = resolve(import.meta.dirname, 'data', `auth-lifecycle-${process.pid}`);
mkdirSync(fixture, { recursive: true });
process.env.DB_PATH = resolve(fixture, 'redman.db');

const { default: db } = await import('../app/backend/src/db.js');
const {
  authenticateLocalUser,
  bootstrapAdmin,
  createLocalUser,
  createSession,
  findActiveSession,
  getAuthUserCount,
  issueRecoveryToken,
  listAuthUsers,
  resetPasswordWithRecovery,
  resolveProxyAccount,
  provisionProxyAccount,
  updateAuthUser,
  verifySessionCsrf,
} = await import('../app/backend/src/services/authService.js');

const config = {
  sessionIdleMinutes: 30,
  sessionAbsoluteHours: 24,
  recoveryMinutes: 15,
};
const bootstrapInput = {
  bootstrapToken: 'one-time-bootstrap-token',
  configuredToken: 'one-time-bootstrap-token',
  username: 'admin',
  password: 'correct horse battery staple',
  displayName: 'RedMan Admin',
  ipAddress: '127.0.0.1',
};

try {
  await assert.rejects(
    bootstrapAdmin(db, { ...bootstrapInput, bootstrapToken: 'wrong' }),
    /Invalid bootstrap credentials/,
  );
  const admin = await bootstrapAdmin(db, bootstrapInput);
  assert.equal(admin.role, 'admin');
  assert.equal(getAuthUserCount(db), 1);
  await assert.rejects(bootstrapAdmin(db, bootstrapInput), /no longer available/);

  for (let attempt = 0; attempt < 5; attempt++) {
    await assert.rejects(
      authenticateLocalUser(db, 'admin', 'incorrect password', { now: new Date('2026-07-17T12:00:00.000Z') }),
      /Invalid username or password/,
    );
  }
  const locked = db.prepare('SELECT failed_attempts, locked_until FROM auth_users WHERE id = ?').get(admin.id);
  assert.equal(locked.failed_attempts, 5);
  assert.ok(locked.locked_until);
  await assert.rejects(
    authenticateLocalUser(db, 'admin', bootstrapInput.password, { now: new Date('2026-07-17T12:00:10.000Z') }),
    /Invalid username or password/,
  );
  const stillLocked = db.prepare('SELECT failed_attempts, locked_until FROM auth_users WHERE id = ?').get(admin.id);
  assert.deepEqual(stillLocked, locked);

  const loginTime = new Date('2026-07-17T12:02:00.000Z');
  const loggedIn = await authenticateLocalUser(db, 'admin', bootstrapInput.password, { now: loginTime });
  assert.equal(loggedIn.id, admin.id);
  assert.equal(db.prepare('SELECT failed_attempts FROM auth_users WHERE id = ?').get(admin.id).failed_attempts, 0);

  const concurrentFailures = await Promise.allSettled(Array.from({ length: 5 }, () =>
    authenticateLocalUser(db, 'admin', 'concurrent wrong password', { now: new Date('2026-07-17T12:02:30.000Z') })
  ));
  assert.equal(concurrentFailures.every(result => result.status === 'rejected'), true);
  const concurrentLock = db.prepare('SELECT failed_attempts, locked_until FROM auth_users WHERE id = ?').get(admin.id);
  assert.equal(concurrentLock.failed_attempts, 5);
  assert.ok(concurrentLock.locked_until);
  db.prepare('UPDATE auth_users SET failed_attempts = 0, locked_until = NULL WHERE id = ?').run(admin.id);

  const session = createSession(db, admin.id, config, { now: loginTime, ipAddress: '127.0.0.1' });
  const storedSession = db.prepare('SELECT * FROM auth_sessions WHERE id = ?').get(session.sessionId);
  assert.notEqual(storedSession.token_hash, session.token);
  assert.notEqual(storedSession.csrf_token_hash, session.csrfToken);
  const active = findActiveSession(db, session.token, config, { now: new Date('2026-07-17T12:02:00.000Z') });
  assert.equal(active.user.role, 'admin');
  assert.equal(verifySessionCsrf(active, session.csrfToken, session.csrfToken), true);
  assert.equal(verifySessionCsrf(active, session.csrfToken, 'wrong'), false);

  const expiredSession = createSession(db, admin.id, config, { now: new Date('2026-07-15T00:00:00.000Z') });
  assert.equal(findActiveSession(db, expiredSession.token, config, { now: loginTime }), null);

  const viewer = await createLocalUser(db, {
    username: 'viewer',
    password: 'viewer password is long enough',
    role: 'viewer',
    actorUserId: admin.id,
  });
  assert.equal(viewer.role, 'viewer');
  assert.throws(() => updateAuthUser(db, admin.id, { enabled: false }, { actorUserId: admin.id }), /last enabled admin/);

  const viewerSession = createSession(db, viewer.id, config, { now: loginTime });
  updateAuthUser(db, viewer.id, { role: 'admin' }, { actorUserId: admin.id });
  assert.equal(findActiveSession(db, viewerSession.token, config, { now: loginTime }), null);
  const promotedSession = createSession(db, viewer.id, config, { now: loginTime });
  updateAuthUser(db, viewer.id, { enabled: false }, { actorUserId: admin.id });
  assert.equal(findActiveSession(db, promotedSession.token, config, { now: loginTime }), null);
  await assert.rejects(authenticateLocalUser(db, 'viewer', 'viewer password is long enough'), /Invalid username or password/);
  const disabledRecovery = issueRecoveryToken(db, 'viewer', config, { now: loginTime });
  await resetPasswordWithRecovery(db, {
    username: 'viewer',
    recoveryToken: disabledRecovery.token,
    newPassword: 'viewer recovered but disabled',
    now: new Date('2026-07-17T12:03:00.000Z'),
  });
  assert.equal(db.prepare('SELECT enabled FROM auth_users WHERE id = ?').get(viewer.id).enabled, 0);
  updateAuthUser(db, viewer.id, { enabled: true, role: 'viewer' }, { actorUserId: admin.id });

  assert.throws(() => resolveProxyAccount(db, {
    subject: 'proxy.user@example.com', displayName: 'Proxy User', email: 'proxy.user@example.com',
  }, null), /not provisioned/);
  const proxyViewer = resolveProxyAccount(db, {
    subject: 'proxy.user@example.com', displayName: 'Proxy User', email: 'proxy.user@example.com',
  }, 'viewer');
  assert.equal(proxyViewer.provider, 'proxy');
  assert.equal(proxyViewer.role, 'viewer');
  const opaqueProxy = resolveProxyAccount(db, {
    subject: 'Tenant|Subject+Case:42', displayName: 'Opaque Proxy', email: 'opaque@example.com',
  }, 'viewer');
  assert.equal(db.prepare('SELECT provider_subject FROM auth_users WHERE id = ?').get(opaqueProxy.id).provider_subject, 'Tenant|Subject+Case:42');
  assert.match(opaqueProxy.username, /^tenant-subject-case-42-/);
  const compatibilitySubjectA = resolveProxyAccount(db, { subject: 'tenant-a' }, 'viewer');
  const compatibilitySubjectB = resolveProxyAccount(db, { subject: 'tenant-ª' }, 'viewer');
  assert.notEqual(compatibilitySubjectA.id, compatibilitySubjectB.id);
  assert.equal(db.prepare('SELECT provider_subject FROM auth_users WHERE id = ?').get(compatibilitySubjectB.id).provider_subject, 'tenant-ª');
  const hostProvisioned = provisionProxyAccount(db, 'Host|Provisioned:Subject', 'admin', 'Host Provisioned');
  assert.equal(hostProvisioned.role, 'admin');
  assert.equal(provisionProxyAccount(db, 'Host|Provisioned:Subject', 'viewer').role, 'viewer');
  const collidingProxy = resolveProxyAccount(db, {
    subject: 'admin', displayName: 'Proxy Admin Subject', email: 'proxy-admin@example.com',
  }, 'viewer');
  assert.notEqual(collidingProxy.username, 'admin');
  assert.match(collidingProxy.username, /^admin-/);
  updateAuthUser(db, collidingProxy.id, { role: 'admin' }, { actorUserId: admin.id });
  assert.throws(() => updateAuthUser(db, admin.id, { role: 'viewer' }, { actorUserId: collidingProxy.id }), /last enabled admin/);

  const recovery = issueRecoveryToken(db, 'admin', config, { now: loginTime });
  assert.notEqual(db.prepare('SELECT token_hash FROM auth_recovery_events WHERE id = ?').get(recovery.recoveryId).token_hash, recovery.token);
  const replayResults = await Promise.allSettled([
    resetPasswordWithRecovery(db, {
      username: 'admin', recoveryToken: recovery.token,
      newPassword: 'a new correct horse battery staple', now: new Date('2026-07-17T12:05:00.000Z'),
    }),
    resetPasswordWithRecovery(db, {
      username: 'admin', recoveryToken: recovery.token,
      newPassword: 'a new correct horse battery staple', now: new Date('2026-07-17T12:05:00.000Z'),
    }),
  ]);
  assert.equal(replayResults.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(replayResults.filter(result => result.status === 'rejected').length, 1);
  assert.equal(findActiveSession(db, session.token, config, { now: new Date('2026-07-17T12:06:00.000Z') }), null);
  await assert.rejects(authenticateLocalUser(db, 'admin', bootstrapInput.password), /Invalid username or password/);
  assert.equal((await authenticateLocalUser(db, 'admin', 'a new correct horse battery staple')).id, admin.id);

  assert.equal(listAuthUsers(db).length, 8);
  assert.ok(db.prepare('SELECT COUNT(*) AS count FROM auth_audit_log').get().count >= 10);
  console.log('Authentication lifecycle: bootstrap, lockout, sessions, CSRF, proxy, roles, and recovery passed');
} finally {
  db.close();
  rmSync(fixture, { recursive: true, force: true });
}

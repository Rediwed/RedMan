import argon2 from 'argon2';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const PASSWORD_OPTIONS = Object.freeze({
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
});
const GENERIC_LOGIN_ERROR = 'Invalid username or password';
const dummyHashPromise = argon2.hash(randomBytes(32).toString('base64url'), PASSWORD_OPTIONS);

function tokenHash(token) {
  return createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

function safeTokenEqual(actual, expected) {
  const actualHash = Buffer.from(tokenHash(actual), 'hex');
  const expectedHash = Buffer.from(tokenHash(expected), 'hex');
  return timingSafeEqual(actualHash, expectedHash);
}

function isoAfter(now, milliseconds) {
  return new Date(now.getTime() + milliseconds).toISOString();
}

function safeUser(row) {
  return {
    id: row.id,
    provider: row.provider,
    username: row.username,
    name: row.display_name || row.username,
    displayName: row.display_name || row.username,
    email: row.email || '',
    role: row.role,
    enabled: Boolean(row.enabled),
    lastLoginAt: row.last_login_at || null,
    createdAt: row.created_at || null,
  };
}

export function normalizeUsername(value) {
  const username = String(value || '').normalize('NFKC').trim().toLowerCase();
  if (username.length < 3 || username.length > 64 || !/^[a-z0-9][a-z0-9._@-]*$/.test(username)) {
    throw new Error('Username must be 3-64 characters using letters, digits, dot, dash, underscore, or @');
  }
  return username;
}

function normalizeOptionalText(value, maximum, field) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = String(value).normalize('NFKC').trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${field} is invalid`);
  }
  return normalized;
}

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
    throw new Error('Password must be 12-128 characters');
  }
  return password;
}

export function normalizeProxyIdentity(identity) {
  const rawSubject = String(identity?.subject || '');
  if (rawSubject.length < 1 || rawSubject.length > 255 || /[\u0000-\u001f\u007f]/.test(rawSubject)) {
    throw new Error('Proxy subject is invalid');
  }
  const subject = rawSubject;
  let username = subject.toLowerCase()
    .replace(/[^a-z0-9._@-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (username.length < 3) username = `user-${tokenHash(subject).slice(0, 8)}`;
  if (username.length > 64 || username !== subject) {
    username = `${username.slice(0, 55)}-${tokenHash(subject).slice(0, 8)}`;
  }
  return {
    subject,
    username,
    displayName: normalizeOptionalText(identity?.displayName, 128, 'Proxy display name'),
    email: normalizeOptionalText(identity?.email, 254, 'Proxy email'),
    groups: Array.isArray(identity?.groups)
      ? identity.groups.map(group => normalizeOptionalText(group, 128, 'Proxy group')).filter(Boolean)
      : [],
  };
}

export function auditAuthEvent(db, event, {
  userId = null,
  actorUserId = null,
  details = null,
  ipAddress = null,
} = {}) {
  db.prepare(`
    INSERT INTO auth_audit_log (user_id, actor_user_id, event, details, ip_address)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    userId,
    actorUserId,
    event,
    details == null ? null : JSON.stringify(details),
    ipAddress,
  );
}

export function getAuthUserCount(db) {
  return db.prepare('SELECT COUNT(*) AS count FROM auth_users').get().count;
}

export function getLocalUserCount(db) {
  return db.prepare("SELECT COUNT(*) AS count FROM auth_users WHERE provider = 'local'").get().count;
}

async function passwordHash(password) {
  return argon2.hash(validatePassword(password), PASSWORD_OPTIONS);
}

export async function bootstrapAdmin(db, {
  bootstrapToken,
  configuredToken,
  username,
  password,
  displayName = null,
  email = null,
  ipAddress = null,
}) {
  if (!configuredToken || !safeTokenEqual(bootstrapToken, configuredToken)) {
    const error = new Error('Invalid bootstrap credentials');
    error.status = 401;
    throw error;
  }
  const normalizedUsername = normalizeUsername(username);
  const secretHash = await passwordHash(password);
  const create = db.transaction(() => {
    if (getLocalUserCount(db) !== 0) {
      const error = new Error('Bootstrap is no longer available');
      error.status = 409;
      throw error;
    }
    const result = db.prepare(`
      INSERT INTO auth_users (provider, provider_subject, username, display_name, email, role)
      VALUES ('local', ?, ?, ?, ?, 'admin')
    `).run(
      normalizedUsername,
      normalizedUsername,
      normalizeOptionalText(displayName, 128, 'Display name'),
      normalizeOptionalText(email, 254, 'Email'),
    );
    const userId = Number(result.lastInsertRowid);
    db.prepare(`
      INSERT INTO auth_credentials (user_id, credential_type, secret_hash)
      VALUES (?, 'password', ?)
    `).run(userId, secretHash);
    auditAuthEvent(db, 'bootstrap_admin_created', { userId, actorUserId: userId, ipAddress });
    return db.prepare('SELECT * FROM auth_users WHERE id = ?').get(userId);
  });
  return safeUser(create.immediate());
}

export async function createLocalUser(db, {
  username,
  password,
  role = 'viewer',
  displayName = null,
  email = null,
  actorUserId = null,
  ipAddress = null,
}) {
  if (!['admin', 'viewer'].includes(role)) throw new Error('Role must be admin or viewer');
  const normalizedUsername = normalizeUsername(username);
  const secretHash = await passwordHash(password);
  const create = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO auth_users (provider, provider_subject, username, display_name, email, role)
      VALUES ('local', ?, ?, ?, ?, ?)
    `).run(
      normalizedUsername,
      normalizedUsername,
      normalizeOptionalText(displayName, 128, 'Display name'),
      normalizeOptionalText(email, 254, 'Email'),
      role,
    );
    const userId = Number(result.lastInsertRowid);
    db.prepare(`INSERT INTO auth_credentials (user_id, credential_type, secret_hash) VALUES (?, 'password', ?)`)
      .run(userId, secretHash);
    auditAuthEvent(db, 'user_created', { userId, actorUserId, details: { role, provider: 'local' }, ipAddress });
    return db.prepare('SELECT * FROM auth_users WHERE id = ?').get(userId);
  });
  return safeUser(create.immediate());
}

export async function authenticateLocalUser(db, username, password, {
  now = new Date(),
  ipAddress = null,
} = {}) {
  let normalizedUsername;
  try {
    normalizedUsername = normalizeUsername(username);
  } catch {
    normalizedUsername = String(username || '').trim().toLowerCase();
  }
  const row = db.prepare(`
    SELECT u.*, c.secret_hash
    FROM auth_users u
    LEFT JOIN auth_credentials c ON c.user_id = u.id AND c.credential_type = 'password'
    WHERE u.provider = 'local' AND u.username = ?
  `).get(normalizedUsername);
  const hash = row?.secret_hash || await dummyHashPromise;
  const passwordMatches = typeof password === 'string'
    ? await argon2.verify(hash, password).catch(() => false)
    : false;
  const locked = row?.locked_until && Date.parse(row.locked_until) > now.getTime();
  const accepted = Boolean(row && row.enabled && !locked && passwordMatches);

  if (!accepted) {
    if (row) {
      const recordFailure = db.transaction(() => {
        const current = db.prepare('SELECT failed_attempts, locked_until FROM auth_users WHERE id = ?').get(row.id);
        const currentlyLocked = current.locked_until && Date.parse(current.locked_until) > now.getTime();
        if (currentlyLocked) return { attempts: current.failed_attempts, locked: true };
        const attempts = (current.failed_attempts || 0) + 1;
        const lockSeconds = attempts >= 5 ? Math.min(900, 30 * (2 ** (attempts - 5))) : 0;
        db.prepare(`
          UPDATE auth_users SET failed_attempts = ?, locked_until = ?, updated_at = datetime('now') WHERE id = ?
        `).run(attempts, lockSeconds ? isoAfter(now, lockSeconds * 1000) : null, row.id);
        return { attempts, locked: Boolean(lockSeconds) };
      });
      const failure = recordFailure.immediate();
      auditAuthEvent(db, 'login_failed', {
        userId: row.id,
        details: failure,
        ipAddress,
      });
    } else {
      auditAuthEvent(db, 'login_failed', { details: { unknownUsername: true }, ipAddress });
    }
    const error = new Error(GENERIC_LOGIN_ERROR);
    error.status = 401;
    throw error;
  }

  db.prepare(`
    UPDATE auth_users SET failed_attempts = 0, locked_until = NULL,
      last_login_at = ?, updated_at = datetime('now') WHERE id = ?
  `).run(now.toISOString(), row.id);
  auditAuthEvent(db, 'login_succeeded', { userId: row.id, ipAddress });
  return safeUser({ ...row, last_login_at: now.toISOString() });
}

export function createSession(db, userId, config, {
  now = new Date(),
  ipAddress = null,
  userAgent = null,
} = {}) {
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(32).toString('base64url');
  const absoluteExpiresAt = isoAfter(now, config.sessionAbsoluteHours * 60 * 60 * 1000);
  const idleExpiresAt = isoAfter(now, config.sessionIdleMinutes * 60 * 1000);
  const result = db.prepare(`
    INSERT INTO auth_sessions (
      user_id, token_hash, csrf_token_hash, ip_address, user_agent,
      created_at, last_seen_at, idle_expires_at, absolute_expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    tokenHash(token),
    tokenHash(csrfToken),
    ipAddress,
    userAgent ? String(userAgent).slice(0, 512) : null,
    now.toISOString(),
    now.toISOString(),
    idleExpiresAt,
    absoluteExpiresAt,
  );
  auditAuthEvent(db, 'session_created', { userId, details: { sessionId: Number(result.lastInsertRowid) }, ipAddress });
  return { token, csrfToken, sessionId: Number(result.lastInsertRowid), idleExpiresAt, absoluteExpiresAt };
}

export function findActiveSession(db, token, config, { now = new Date() } = {}) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT s.*, u.provider, u.username, u.display_name, u.email, u.role, u.enabled,
      u.last_login_at, u.created_at AS user_created_at
    FROM auth_sessions s
    JOIN auth_users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL
  `).get(tokenHash(token));
  if (!row || !row.enabled) return null;
  if (Date.parse(row.idle_expires_at) <= now.getTime() || Date.parse(row.absolute_expires_at) <= now.getTime()) {
    db.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(now.toISOString(), row.id);
    auditAuthEvent(db, 'session_expired', { userId: row.user_id, details: { sessionId: row.id } });
    return null;
  }

  if (now.getTime() - Date.parse(row.last_seen_at) >= 60_000) {
    const nextIdle = Math.min(
      Date.parse(row.absolute_expires_at),
      now.getTime() + config.sessionIdleMinutes * 60 * 1000,
    );
    db.prepare('UPDATE auth_sessions SET last_seen_at = ?, idle_expires_at = ? WHERE id = ?')
      .run(now.toISOString(), new Date(nextIdle).toISOString(), row.id);
    row.last_seen_at = now.toISOString();
    row.idle_expires_at = new Date(nextIdle).toISOString();
  }

  return {
    sessionId: row.id,
    userId: row.user_id,
    csrfTokenHash: row.csrf_token_hash,
    idleExpiresAt: row.idle_expires_at,
    absoluteExpiresAt: row.absolute_expires_at,
    user: safeUser({
      id: row.user_id,
      provider: row.provider,
      username: row.username,
      display_name: row.display_name,
      email: row.email,
      role: row.role,
      enabled: row.enabled,
      last_login_at: row.last_login_at,
      created_at: row.user_created_at,
    }),
  };
}

export function verifySessionCsrf(session, cookieToken, headerToken) {
  if (!session || !cookieToken || !headerToken || !safeTokenEqual(cookieToken, headerToken)) return false;
  return timingSafeEqual(
    Buffer.from(tokenHash(cookieToken), 'hex'),
    Buffer.from(session.csrfTokenHash, 'hex'),
  );
}

export function revokeSession(db, sessionId, { actorUserId = null, ipAddress = null } = {}) {
  const row = db.prepare('SELECT user_id FROM auth_sessions WHERE id = ?').get(sessionId);
  if (!row) return false;
  const result = db.prepare("UPDATE auth_sessions SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL")
    .run(sessionId);
  if (result.changes) auditAuthEvent(db, 'session_revoked', { userId: row.user_id, actorUserId, details: { sessionId }, ipAddress });
  return result.changes > 0;
}

export function revokeUserSessions(db, userId, { exceptSessionId = null } = {}) {
  if (exceptSessionId) {
    return db.prepare(`
      UPDATE auth_sessions SET revoked_at = datetime('now')
      WHERE user_id = ? AND id != ? AND revoked_at IS NULL
    `).run(userId, exceptSessionId).changes;
  }
  return db.prepare(`
    UPDATE auth_sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL
  `).run(userId).changes;
}

export function revokeSessionsAfterDatabaseRestore(db, restored) {
  if (!restored) return 0;
  const result = db.prepare(`
    UPDATE auth_sessions SET revoked_at = datetime('now') WHERE revoked_at IS NULL
  `).run();
  auditAuthEvent(db, 'database_restore_sessions_revoked', {
    details: { revokedSessions: result.changes },
  });
  return result.changes;
}

export function resolveProxyAccount(db, identity, autoProvisionRole, { ipAddress = null } = {}) {
  const normalized = normalizeProxyIdentity(identity);
  let row = db.prepare(`
    SELECT * FROM auth_users WHERE provider = 'proxy' AND provider_subject = ?
  `).get(normalized.subject);

  if (!row) {
    if (!autoProvisionRole) {
      const error = new Error('Proxy identity is not provisioned in RedMan');
      error.status = 403;
      throw error;
    }
    const create = db.transaction(() => {
      const existing = db.prepare(`SELECT * FROM auth_users WHERE provider = 'proxy' AND provider_subject = ?`).get(normalized.subject);
      if (existing) return existing;
      let username = normalized.username;
      const collision = db.prepare('SELECT id FROM auth_users WHERE username = ?').get(username);
      if (collision) {
        username = `${username.slice(0, 55)}-${tokenHash(normalized.subject).slice(0, 8)}`;
      }
      const result = db.prepare(`
        INSERT INTO auth_users (provider, provider_subject, username, display_name, email, role, last_login_at)
        VALUES ('proxy', ?, ?, ?, ?, ?, datetime('now'))
      `).run(normalized.subject, username, normalized.displayName, normalized.email, autoProvisionRole);
      const userId = Number(result.lastInsertRowid);
      auditAuthEvent(db, 'proxy_user_provisioned', {
        userId,
        actorUserId: userId,
        details: { role: autoProvisionRole },
        ipAddress,
      });
      return db.prepare('SELECT * FROM auth_users WHERE id = ?').get(userId);
    });
    row = create.immediate();
  }

  if (!row.enabled) {
    const error = new Error('Account disabled');
    error.status = 403;
    throw error;
  }
  db.prepare(`
    UPDATE auth_users SET display_name = COALESCE(?, display_name), email = COALESCE(?, email),
      last_login_at = CASE WHEN last_login_at IS NULL OR last_login_at < datetime('now', '-5 minutes') THEN datetime('now') ELSE last_login_at END,
      updated_at = CASE WHEN COALESCE(display_name, '') != COALESCE(?, '') OR COALESCE(email, '') != COALESCE(?, '') THEN datetime('now') ELSE updated_at END
    WHERE id = ?
  `).run(normalized.displayName, normalized.email, normalized.displayName, normalized.email, row.id);
  return safeUser({ ...row, display_name: normalized.displayName || row.display_name, email: normalized.email || row.email });
}

export function issueRecoveryToken(db, username, config, { now = new Date() } = {}) {
  const normalizedUsername = normalizeUsername(username);
  const user = db.prepare("SELECT * FROM auth_users WHERE provider = 'local' AND username = ?").get(normalizedUsername);
  if (!user) throw new Error('Local account not found');
  const token = randomBytes(32).toString('base64url');
  const expiresAt = isoAfter(now, config.recoveryMinutes * 60 * 1000);
  const create = db.transaction(() => {
    db.prepare("UPDATE auth_recovery_events SET status = 'revoked' WHERE user_id = ? AND status = 'issued'").run(user.id);
    const result = db.prepare(`
      INSERT INTO auth_recovery_events (user_id, token_hash, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `).run(user.id, tokenHash(token), expiresAt, now.toISOString());
    auditAuthEvent(db, 'recovery_token_issued', { userId: user.id, details: { recoveryId: Number(result.lastInsertRowid) } });
    return Number(result.lastInsertRowid);
  });
  return { token, recoveryId: create.immediate(), expiresAt, user: safeUser(user) };
}

export async function resetPasswordWithRecovery(db, {
  username,
  recoveryToken,
  newPassword,
  now = new Date(),
  ipAddress = null,
}) {
  const normalizedUsername = normalizeUsername(username);
  const recovery = db.prepare(`
    SELECT r.*, u.username, u.enabled
    FROM auth_recovery_events r
    JOIN auth_users u ON u.id = r.user_id
    WHERE r.token_hash = ? AND u.provider = 'local' AND u.username = ?
  `).get(tokenHash(recoveryToken), normalizedUsername);
  if (!recovery || recovery.status !== 'issued' || Date.parse(recovery.expires_at) <= now.getTime()) {
    if (recovery?.status === 'issued') {
      db.prepare("UPDATE auth_recovery_events SET status = 'expired' WHERE id = ?").run(recovery.id);
    }
    const error = new Error('Invalid or expired recovery token');
    error.status = 401;
    throw error;
  }
  const secretHash = await passwordHash(newPassword);
  const reset = db.transaction(() => {
    const claimed = db.prepare(`
      UPDATE auth_recovery_events SET status = 'used', used_at = ?
      WHERE id = ? AND status = 'issued' AND expires_at > ?
    `).run(now.toISOString(), recovery.id, now.toISOString());
    if (claimed.changes !== 1) {
      const error = new Error('Invalid or expired recovery token');
      error.status = 401;
      throw error;
    }
    db.prepare(`
      UPDATE auth_credentials SET secret_hash = ?, updated_at = ?
      WHERE user_id = ? AND credential_type = 'password'
    `).run(secretHash, now.toISOString(), recovery.user_id);
    db.prepare(`
      UPDATE auth_users SET failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?
    `).run(now.toISOString(), recovery.user_id);
    revokeUserSessions(db, recovery.user_id);
    auditAuthEvent(db, 'password_recovered', { userId: recovery.user_id, ipAddress });
  });
  reset.immediate();
  return { success: true, userId: recovery.user_id };
}

export async function changeLocalPassword(db, userId, currentPassword, newPassword, {
  actorUserId = userId,
  ipAddress = null,
} = {}) {
  const credential = db.prepare(`
    SELECT secret_hash FROM auth_credentials WHERE user_id = ? AND credential_type = 'password'
  `).get(userId);
  if (!credential || !await argon2.verify(credential.secret_hash, currentPassword).catch(() => false)) {
    const error = new Error('Current password is incorrect');
    error.status = 400;
    throw error;
  }
  const secretHash = await passwordHash(newPassword);
  db.prepare(`
    UPDATE auth_credentials SET secret_hash = ?, updated_at = datetime('now')
    WHERE user_id = ? AND credential_type = 'password'
  `).run(secretHash, userId);
  revokeUserSessions(db, userId);
  auditAuthEvent(db, 'password_changed', { userId, actorUserId, ipAddress });
  return true;
}

export function updateAuthUser(db, userId, updates, { actorUserId = null, ipAddress = null } = {}) {
  const existing = db.prepare('SELECT * FROM auth_users WHERE id = ?').get(userId);
  if (!existing) throw new Error('User not found');
  const role = updates.role ?? existing.role;
  if (!['admin', 'viewer'].includes(role)) throw new Error('Role must be admin or viewer');
  const enabled = updates.enabled === undefined ? existing.enabled : (updates.enabled ? 1 : 0);
  if (existing.role === 'admin' && (role !== 'admin' || !enabled)) {
    const otherAdmins = db.prepare(`
      SELECT COUNT(*) AS count FROM auth_users
      WHERE provider = ? AND role = 'admin' AND enabled = 1 AND id != ?
    `).get(existing.provider, userId).count;
    if (otherAdmins === 0) throw new Error('Cannot disable or demote the last enabled admin');
  }
  db.prepare(`
    UPDATE auth_users SET role = ?, enabled = ?, display_name = ?, email = ?, updated_at = datetime('now') WHERE id = ?
  `).run(
    role,
    enabled,
    updates.displayName === undefined ? existing.display_name : normalizeOptionalText(updates.displayName, 128, 'Display name'),
    updates.email === undefined ? existing.email : normalizeOptionalText(updates.email, 254, 'Email'),
    userId,
  );
  if (role !== existing.role || enabled !== existing.enabled) revokeUserSessions(db, userId);
  auditAuthEvent(db, 'user_updated', {
    userId,
    actorUserId,
    details: { role, enabled: Boolean(enabled) },
    ipAddress,
  });
  return safeUser(db.prepare('SELECT * FROM auth_users WHERE id = ?').get(userId));
}

export function listAuthUsers(db) {
  return db.prepare(`
    SELECT id, provider, username, display_name, email, role, enabled, last_login_at, created_at
    FROM auth_users ORDER BY username COLLATE NOCASE
  `).all().map(safeUser);
}

export function promoteLocalAdminForRecovery(db, username) {
  const normalizedUsername = normalizeUsername(username);
  const user = db.prepare("SELECT * FROM auth_users WHERE provider = 'local' AND username = ?").get(normalizedUsername);
  if (!user) throw new Error('Local account not found');
  db.prepare(`
    UPDATE auth_users SET role = 'admin', enabled = 1, failed_attempts = 0,
      locked_until = NULL, updated_at = datetime('now') WHERE id = ?
  `).run(user.id);
  revokeUserSessions(db, user.id);
  auditAuthEvent(db, 'local_admin_recovered', { userId: user.id, actorUserId: user.id });
  return safeUser(db.prepare('SELECT * FROM auth_users WHERE id = ?').get(user.id));
}

export function provisionProxyAccount(db, subject, role = 'viewer', displayName = null) {
  if (!['admin', 'viewer'].includes(role)) throw new Error('Role must be admin or viewer');
  const normalized = normalizeProxyIdentity({ subject, displayName });
  const existing = db.prepare("SELECT * FROM auth_users WHERE provider = 'proxy' AND provider_subject = ?").get(normalized.subject);
  if (!existing) return resolveProxyAccount(db, normalized, role);
  db.prepare(`
    UPDATE auth_users SET role = ?, enabled = 1, display_name = COALESCE(?, display_name),
      updated_at = datetime('now') WHERE id = ?
  `).run(role, normalized.displayName, existing.id);
  revokeUserSessions(db, existing.id);
  auditAuthEvent(db, 'proxy_account_provisioned_by_host', {
    userId: existing.id,
    actorUserId: existing.id,
    details: { role },
  });
  return safeUser(db.prepare('SELECT * FROM auth_users WHERE id = ?').get(existing.id));
}

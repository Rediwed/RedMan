import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const fixture = resolve(import.meta.dirname, 'data', `auth-backup-${process.pid}`);
mkdirSync(fixture, { recursive: true });
const sourcePath = resolve(fixture, 'source.db');
const backupPath = resolve(fixture, 'backup.db');
const restoredPath = resolve(fixture, 'restored.db');
process.env.DB_PATH = sourcePath;

const require = createRequire(resolve(import.meta.dirname, '../app/package.json'));
const Database = require('better-sqlite3');
const { default: db } = await import('../app/backend/src/db.js');
const { bootstrapAdmin, createLocalUser, createSession, revokeSessionsAfterDatabaseRestore } = await import('../app/backend/src/services/authService.js');
const {
  applyPendingDatabaseRestore,
  createOnlineDatabaseBackup,
  stageDatabaseRestore,
} = await import('../app/backend/src/services/databaseFileSafety.js');

try {
  const admin = await bootstrapAdmin(db, {
    bootstrapToken: 'backup-bootstrap',
    configuredToken: 'backup-bootstrap',
    username: 'backupadmin',
    password: 'backup admin password 2026',
  });
  await createLocalUser(db, {
    username: 'backupviewer',
    password: 'backup viewer password 2026',
    role: 'viewer',
    actorUserId: admin.id,
  });
  createSession(db, admin.id, { sessionIdleMinutes: 30, sessionAbsoluteHours: 24 });

  await createOnlineDatabaseBackup(db, backupPath);
  await stageDatabaseRestore(backupPath, restoredPath);
  applyPendingDatabaseRestore(restoredPath);

  const restored = new Database(restoredPath);
  assert.equal(restored.prepare('SELECT COUNT(*) AS count FROM auth_users').get().count, 2);
  assert.equal(restored.prepare('SELECT COUNT(*) AS count FROM auth_credentials').get().count, 2);
  const hashes = restored.prepare('SELECT secret_hash FROM auth_credentials').all();
  assert.ok(hashes.every(row => row.secret_hash.startsWith('$argon2id$')));
  assert.ok(hashes.every(row => !row.secret_hash.includes('password 2026')));
  assert.equal(revokeSessionsAfterDatabaseRestore(restored, true), 1);
  assert.equal(restored.prepare('SELECT COUNT(*) AS count FROM auth_sessions WHERE revoked_at IS NULL').get().count, 0);
  assert.equal(restored.prepare("SELECT COUNT(*) AS count FROM auth_audit_log WHERE event = 'database_restore_sessions_revoked'").get().count, 1);
  restored.close();
  console.log('Authentication backup/restore: users and Argon2id credentials survived staged recovery');
} finally {
  db.close();
  rmSync(fixture, { recursive: true, force: true });
}
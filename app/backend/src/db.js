import Database from 'better-sqlite3';
import { chmodSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { applyPendingDatabaseRestore } from './services/databaseFileSafety.js';
import { migratePeerSecrets } from './services/peerSecrets.js';
import { reconcilePeerSshAuthorizationsAtStartup } from './services/peerSshAuthorization.js';
import { revokeSessionsAfterDatabaseRestore } from './services/authService.js';
import { runMigrations } from './migrations.js';

const filename = fileURLToPath(import.meta.url);
const moduleDirectory = dirname(filename);
const dbPath = process.env.DB_PATH || join(moduleDirectory, '..', 'data', 'redman.db');

const restored = applyPendingDatabaseRestore(dbPath);
if (restored) {
  console.log(`[db-restore] Installed staged database restore; previous database saved as ${restored.previousSavedAs || 'not present'}`);
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

for (const suffix of ['', '-wal', '-shm']) {
  const filePath = `${dbPath}${suffix}`;
  if (existsSync(filePath)) chmodSync(filePath, 0o600);
}

runMigrations(db);
migratePeerSecrets(db);
const sshReconciliation = reconcilePeerSshAuthorizationsAtStartup(db, {
  onError(peer, error) {
    console.error(`[peer-ssh] Disabled peer ${peer.id} after startup reconciliation failed: ${error.message}`);
  },
});
if (sshReconciliation.managed || sshReconciliation.disabled) {
  console.log(`[peer-ssh] Startup reconciliation managed ${sshReconciliation.managed} and disabled ${sshReconciliation.disabled} peer(s)`);
}
revokeSessionsAfterDatabaseRestore(db, restored);

export default db;
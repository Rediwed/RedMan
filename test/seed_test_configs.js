/**
 * seed_test_configs.js — Pre-configure SSD Backup + Hyper Backup jobs for testing.
 *
 * Usage: node test/seed_test_configs.js <db_a_path> <db_b_path> <test_data_dir>
 *
 * Uses createRequire to resolve better-sqlite3 from the backend's node_modules.
 */

import { createRequire } from 'module';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';
import { hostname, userInfo } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(__dirname, '../app/package.json'));
const Database = require('better-sqlite3');

// ── Parse arguments ──────────────────────────────────────────────────

const [,, dbPathA, dbPathB, testDataDir] = process.argv;

if (!dbPathA || !dbPathB || !testDataDir) {
  console.error('Usage: node seed_test_configs.js <db_a> <db_b> <test_data_dir>');
  process.exit(1);
}

const sourceDir = resolve(testDataDir, 'source');
const destSsd = resolve(testDataDir, 'dest_ssd');
const destHyper = resolve(testDataDir, 'dest_hyper');

// Ensure destination directories exist
mkdirSync(destSsd, { recursive: true });
mkdirSync(destHyper, { recursive: true });

const currentUser = userInfo().username;
const host = 'localhost';

// ── Seed Instance A ──────────────────────────────────────────────────

console.log('🔧 Configuring Instance A (primary)...');
const dbA = new Database(dbPathA);
dbA.pragma('journal_mode = WAL');
dbA.pragma('foreign_keys = ON');

const upsertA = dbA.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
dbA.transaction(() => {
  upsertA.run('instance_name', 'RedMan-A (Test Primary)');
  upsertA.run('peer_api_key', 'test-peer-key-alpha');
  upsertA.run('peer_api_port', '8091');

  // Notification settings (disabled for testing — less noise)
  upsertA.run('ntfy_enabled', 'false');
  upsertA.run('browser_notify_enabled', 'false');
})();

// SSD Backup config: source → dest_ssd
dbA.prepare(`
  INSERT OR REPLACE INTO ssd_backup_configs
    (id, name, source_path, dest_path, cron_expression, versioning_enabled, enabled)
  VALUES (1, 'Test SSD Backup', ?, ?, '*/5 * * * *', 1, 0)
`).run(sourceDir, destSsd);

console.log(`  ✅ SSD Backup: ${sourceDir} → ${destSsd}`);

// Hyper Backup job: push A → B via localhost SSH
dbA.prepare(`
  INSERT OR REPLACE INTO hyper_backup_jobs
    (id, name, direction, remote_url, remote_api_key, local_path, remote_path,
     ssh_user, ssh_host, ssh_port, cron_expression, enabled)
  VALUES (1, 'Test Hyper Push A→B', 'push',
    'http://localhost:8095', 'test-peer-key-beta',
    ?, ?,
    ?, ?, 22, '0 */2 * * *', 0)
`).run(sourceDir, destHyper, currentUser, host);

console.log(`  ✅ Hyper Backup (push): ${sourceDir} → ${currentUser}@${host}:${destHyper}`);

dbA.close();

// ── Seed Instance B ──────────────────────────────────────────────────

console.log('🔧 Configuring Instance B (remote peer)...');
const dbB = new Database(dbPathB);
dbB.pragma('journal_mode = WAL');
dbB.pragma('foreign_keys = ON');

const upsertB = dbB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
dbB.transaction(() => {
  upsertB.run('instance_name', 'RedMan-B (Test Remote)');
  upsertB.run('peer_api_key', 'test-peer-key-beta');
  upsertB.run('peer_api_port', '8095');

  upsertB.run('ntfy_enabled', 'false');
  upsertB.run('browser_notify_enabled', 'false');
})();

// Hyper Backup job: pull from A (reverse direction for testing both modes)
dbB.prepare(`
  INSERT OR REPLACE INTO hyper_backup_jobs
    (id, name, direction, remote_url, remote_api_key, local_path, remote_path,
     ssh_user, ssh_host, ssh_port, cron_expression, enabled)
  VALUES (1, 'Test Hyper Pull B←A', 'pull',
    'http://localhost:8091', 'test-peer-key-alpha',
    ?, ?,
    ?, ?, 22, '0 */2 * * *', 0)
`).run(destHyper, sourceDir, currentUser, host);

console.log(`  ✅ Hyper Backup (pull): ${currentUser}@${host}:${sourceDir} → ${destHyper}`);

dbB.close();

console.log('\n✅ Test configurations seeded successfully.');
console.log(`\n   Instance A: peer key = test-peer-key-alpha`);
console.log(`   Instance B: peer key = test-peer-key-beta`);
console.log(`   SSH user:   ${currentUser}@${host}`);
console.log(`\n   ⚠️  Jobs are created DISABLED. Enable them in the UI or via API.`);
console.log(`   ⚠️  Ensure macOS Remote Login (SSH) is enabled for Hyper Backup.`);

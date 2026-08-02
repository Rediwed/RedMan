import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LATEST_SCHEMA_VERSION } from '../app/backend/src/migrations.js';

const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, '..');
const fixtureDir = resolve(testDir, 'data', `fresh-start-${process.pid}`);
const dbPath = resolve(fixtureDir, 'redman.db');
const dbModuleUrl = pathToFileURL(resolve(root, 'app/backend/src/db.js')).href;
const require = createRequire(resolve(root, 'app/package.json'));
const Database = require('better-sqlite3');

mkdirSync(fixtureDir, { recursive: true });

function startDatabase() {
  const result = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    `import('${dbModuleUrl}').then(({ default: db }) => db.close())`,
  ], {
    cwd: root,
    env: { ...process.env, DB_PATH: dbPath },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
}

try {
  startDatabase();
  startDatabase();

  const db = new Database(dbPath, { readonly: true });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name);
  const requiredTables = [
    'settings',
    'ssd_backup_configs',
    'backup_runs',
    'backup_run_files',
    'hyper_backup_jobs',
    'rclone_jobs',
    'container_metrics',
    'media_drives',
    'media_import_ledger',
    'restore_events',
    'auth_users',
    'auth_credentials',
    'auth_sessions',
    'auth_recovery_events',
    'auth_audit_log',
    'authorized_peers',
    'peer_audit_log',
    'cache',
    'pairing_requests',
    'external_jobs',
    'external_job_runs',
    'events',
    'schema_migrations',
  ];

  for (const table of requiredTables) assert(tables.includes(table), `Missing table: ${table}`);
    assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, LATEST_SCHEMA_VERSION);
  db.close();

  console.log('Fresh database startup: 2 idempotent starts passed');
} finally {
  rmSync(fixtureDir, { recursive: true, force: true });
}
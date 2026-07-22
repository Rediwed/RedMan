import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const fixture = resolve(import.meta.dirname, 'data', `rclone-policy-${process.pid}`);
const storage = resolve(fixture, 'storage');
const databasePath = resolve(fixture, 'redman-data', 'redman.db');
mkdirSync(storage, { recursive: true });
mkdirSync(resolve(fixture, 'redman-data'), { recursive: true });
process.env.DB_PATH = databasePath;

const { executeRcloneJob, redactSensitive, validateRcloneJobInput } = await import('../app/backend/src/services/rclone.js');
const { default: db } = await import('../app/backend/src/db.js');
const options = { roots: [storage], databasePath };

try {
  const valid = validateRcloneJobInput({
    local_path: resolve(storage, 'cloud-copy'),
    remote_name: 'cloud_1',
    remote_path: 'Documents',
    sync_direction: 'download',
  }, options);
  assert.equal(valid.local_path, resolve(storage, 'cloud-copy'));
  assert.equal(valid.allowedRoot, storage);

  assert.throws(() => validateRcloneJobInput({
    local_path: '/', remote_name: 'cloud', remote_path: 'Documents', sync_direction: 'download',
  }, options), /dedicated directory/);
  assert.throws(() => validateRcloneJobInput({
    local_path: storage, remote_name: 'cloud', remote_path: 'Documents', sync_direction: 'download',
  }, options), /dedicated subdirectory/);
  assert.throws(() => validateRcloneJobInput({
    local_path: resolve(fixture, 'outside'), remote_name: 'cloud', remote_path: 'Documents', sync_direction: 'download',
  }, options), /configured storage root/);
  assert.throws(() => validateRcloneJobInput({
    local_path: resolve(fixture, 'redman-data'), remote_name: 'cloud', remote_path: 'Documents', sync_direction: 'download',
  }, { roots: [fixture], databasePath }), /database directory/);
  assert.throws(() => validateRcloneJobInput({
    local_path: resolve(storage, 'copy'), remote_name: '--config', remote_path: 'Documents', sync_direction: 'download',
  }, options), /remote_name/);
  assert.throws(() => validateRcloneJobInput({
    local_path: resolve(storage, 'copy'), remote_name: 'cloud', remote_path: 'bad\npath', sync_direction: 'download',
  }, options), /control characters/);
  assert.throws(() => validateRcloneJobInput({
    local_path: resolve(storage, 'copy'), remote_name: 'cloud', remote_path: 'folder/../other', sync_direction: 'download',
  }, options), /remote_path/);

  const credentialKeys = [
    'token', 'password', 'secret', 'client_secret', 'pass', 'key',
    'service_account_credentials', 'service_account_file', 'access_key_id',
    'secret_access_key', 'key_file', 'key_pem', 'app_key', 'app_secret',
    '2fa', 'mailbox_password',
  ];
  const redacted = redactSensitive(Object.fromEntries(credentialKeys.map(key => [key, 'sensitive'])));
  assert.ok(credentialKeys.every(key => redacted[key] === '••••••••'));

  const invalidJob = db.prepare(`
    INSERT INTO rclone_jobs (name, local_path, remote_name, remote_path, sync_direction)
    VALUES (?, ?, ?, ?, ?)
  `).run('Unsafe legacy job', '/', 'cloud', 'Documents', 'download');
  const claimedRun = db.prepare(`
    INSERT INTO backup_runs (feature, config_id, status) VALUES ('rclone', ?, 'running')
  `).run(invalidJob.lastInsertRowid);
  await assert.rejects(
    executeRcloneJob(Number(invalidJob.lastInsertRowid), Number(claimedRun.lastInsertRowid)),
    /dedicated directory/,
  );
  assert.equal(
    db.prepare('SELECT status FROM backup_runs WHERE id = ?').get(claimedRun.lastInsertRowid).status,
    'failed',
  );

  console.log('Rclone policy: confined local paths, protected DB, and safe remote arguments passed');
} finally {
  db.close();
  rmSync(fixture, { recursive: true, force: true });
}
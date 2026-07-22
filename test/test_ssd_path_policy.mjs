import assert from 'node:assert/strict';
import { mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { localPathsOverlap, validateSsdBackupPaths } from '../app/backend/src/middleware/validation.js';

const protectedRoots = ['/srv/redman-backups', '/media'];
assert.equal(validateSsdBackupPaths('/srv/source', '/srv/redman-backups', protectedRoots).ok, false);
assert.equal(validateSsdBackupPaths('/srv/source', '/media', protectedRoots).ok, false);
assert.equal(validateSsdBackupPaths('/srv/source', '/srv/redman-backups/job-a', protectedRoots).ok, true);
assert.equal(validateSsdBackupPaths('/srv/source', '/srv/source/nested', protectedRoots).ok, false);
assert.equal(validateSsdBackupPaths('/srv/redman-backups/job-a', '/srv/redman-backups/job-a', protectedRoots).ok, false);

const fixture = resolve(import.meta.dirname, 'data', `ssd-path-policy-${process.pid}`);
const source = resolve(fixture, 'source');
const alias = resolve(fixture, 'alias');
mkdirSync(source, { recursive: true });
symlinkSync(source, alias);
process.env.DB_PATH = resolve(fixture, 'redman.db');
try {
	assert.equal(validateSsdBackupPaths(source, alias, []).ok, false);
	assert.equal(validateSsdBackupPaths(source, resolve(alias, 'nested'), []).ok, false);
	assert.equal(localPathsOverlap(resolve(source, 'job-a'), resolve(alias, 'job-a')), true);

	const { default: db } = await import('../app/backend/src/db.js');
	const { executeSsdBackup } = await import('../app/backend/src/services/rsync.js');
	const invalidConfig = db.prepare(`
		INSERT INTO ssd_backup_configs (name, source_path, dest_path)
		VALUES ('Unsafe legacy SSD job', '/', ?)
	`).run(resolve(fixture, 'unsafe-destination'));
	const claimedRun = db.prepare(`
		INSERT INTO backup_runs (feature, config_id, status)
		VALUES ('ssd-backup', ?, 'running')
	`).run(invalidConfig.lastInsertRowid);
	await assert.rejects(
		executeSsdBackup(Number(invalidConfig.lastInsertRowid), Number(claimedRun.lastInsertRowid)),
		/inside the source/,
	);
	assert.equal(
		db.prepare('SELECT status FROM backup_runs WHERE id = ?').get(claimedRun.lastInsertRowid).status,
		'failed',
	);
	db.close();
} finally {
	rmSync(fixture, { recursive: true, force: true });
}

console.log('SSD path policy: protected roots and symlink aliases blocked from destructive sync');
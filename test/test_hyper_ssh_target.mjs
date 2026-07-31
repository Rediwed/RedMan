import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const fixture = resolve(import.meta.dirname, 'data', `hyper-ssh-target-${process.pid}`);
mkdirSync(fixture, { recursive: true });
process.env.DB_PATH = resolve(fixture, 'redman.db');
const { resolveHyperSshTarget, buildHyperSshCommand, resolveHyperRemotePath } = await import('../app/backend/src/services/hyperBackup.js');
const { default: db } = await import('../app/backend/src/db.js');

try {
  const hyperBackupSource = readFileSync(resolve(import.meta.dirname, '../app/backend/src/services/hyperBackup.js'), 'utf8');
  assert.doesNotMatch(hyperBackupSource, /['"]--mkpath['"]/);
  assert.match(hyperBackupSource, /\/peer\/backup\/prepare/);

  const baseJob = { remote_url: 'http://192.168.1.20:8091', ssh_host: null, ssh_user: null, ssh_port: null };
  assert.deepEqual(resolveHyperSshTarget(baseJob, {
    sshHost: '100.90.128.2', sshUser: 'redman-backup', sshPort: 2222,
  }), { host: '100.90.128.2', user: 'redman-backup', port: 2222 });
  assert.deepEqual(resolveHyperSshTarget({
    ...baseJob, ssh_host: 'nas.internal', ssh_user: 'backup-user', ssh_port: 2200,
  }, { sshHost: '100.90.128.2', sshUser: 'remote-user', sshPort: 22 }), {
    host: 'nas.internal', user: 'backup-user', port: 2200,
  });
  assert.throws(() => resolveHyperSshTarget(baseJob, { sshHost: '-oProxyCommand=bad' }), /numeric private IP/);
  assert.throws(() => resolveHyperSshTarget(baseJob, { sshHost: 'example.com' }), /numeric private IP/);
  assert.throws(() => resolveHyperSshTarget(baseJob, { sshHost: '8.8.8.8' }), /numeric private IP/);
  assert.throws(() => resolveHyperSshTarget(baseJob, { sshHost: '100.90.128.2', sshUser: '-root' }), /invalid SSH user/);
  assert.throws(() => resolveHyperSshTarget(baseJob, { sshHost: '100.90.128.2', sshUser: 'root' }), /invalid SSH user/);
  assert.throws(() => resolveHyperSshTarget({ ...baseJob, ssh_user: 'root' }, { sshHost: '100.90.128.2' }), /invalid SSH user/);
  assert.throws(() => resolveHyperSshTarget(baseJob, { sshHost: '100.90.128.2', sshPort: 70000 }), /invalid SSH port/);

  // The private key lives in the data volume, not $HOME/.ssh, so ssh can never
  // discover it on its own. Omitting -i makes every transfer fail with
  // "Permission denied (publickey)" as soon as the container is recreated.
  const withKey = buildHyperSshCommand(22, '/app/backend/data/.ssh/id_ed25519');
  assert.match(withKey, /-i \/app\/backend\/data\/\.ssh\/id_ed25519(\s|$)/);
  assert.match(withKey, /-o IdentitiesOnly=yes/);
  assert.match(withKey, /-p 22(\s|$)/);
  assert.match(withKey, /ServerAliveInterval=60/);
  // Without a generated key the command must stay usable (no bare "-i").
  assert.doesNotMatch(buildHyperSshCommand(2222, null), /-i(\s|$)/);
  assert.match(buildHyperSshCommand(2222, null), /-p 2222(\s|$)/);
  // The transport rsync actually receives must carry the identity.
  assert.match(hyperBackupSource, /'-e', buildHyperSshCommand\(sshPort\)/);
  // rsync splits the -e string on whitespace, so a space would inject an extra
  // ssh option — and ssh runs -o ProxyCommand= through a shell.
  assert.throws(() => buildHyperSshCommand(22, '/tmp/my key'), /whitespace/);
  assert.throws(() => buildHyperSshCommand(22, '-oProxyCommand=touch /tmp/pwned'), /whitespace or start with/);
  assert.throws(() => buildHyperSshCommand(70000), /invalid SSH port/);
  assert.throws(() => buildHyperSshCommand('22 -oProxyCommand=x'), /invalid SSH port/);

  // A restricted peer advertises the path rsync must ask for, because rrsync
  // resolves it under the allowed prefix. Using the job's absolute path there
  // makes the peer apply the prefix twice.
  const pathJob = { remote_path: '/mnt/user/cross-site/appdata' };
  assert.equal(resolveHyperRemotePath(pathJob, { rsyncPath: '/appdata' }), '/appdata');
  // A peer that advertises nothing keeps the previous behaviour.
  assert.equal(resolveHyperRemotePath(pathJob, {}), '/mnt/user/cross-site/appdata');
  assert.equal(resolveHyperRemotePath(pathJob, { rsyncPath: null }), '/mnt/user/cross-site/appdata');
  // The path comes from the peer, so it is validated before it reaches rsync.
  assert.throws(() => resolveHyperRemotePath(pathJob, { rsyncPath: '../../etc' }), /invalid rsync path/);
  assert.throws(() => resolveHyperRemotePath(pathJob, { rsyncPath: '/a/../../etc' }), /invalid rsync path/);
  assert.throws(() => resolveHyperRemotePath(pathJob, { rsyncPath: 'relative' }), /invalid rsync path/);
  assert.throws(() => resolveHyperRemotePath(pathJob, { rsyncPath: '/a\nb' }), /invalid rsync path/);
  assert.throws(() => resolveHyperRemotePath(pathJob, { rsyncPath: 42 }), /invalid rsync path/);
  // Re-rooting only strips a prefix, so the advertised path is always a suffix
  // of the configured one. A peer naming anything else is redirecting the
  // transfer — on a pull that is the rsync source, and --delete-after would
  // then wipe the local copy it was meant to restore.
  assert.throws(() => resolveHyperRemotePath(pathJob, { rsyncPath: '/etc/shadow' }), /not part of this job/);
  assert.throws(() => resolveHyperRemotePath(pathJob, { rsyncPath: '/root/.ssh' }), /not part of this job/);
  assert.throws(() => resolveHyperRemotePath(pathJob, { rsyncPath: '/appdata-other' }), /not part of this job/);
  // An unrestricted peer echoes the job's own absolute path, which still fits.
  assert.equal(resolveHyperRemotePath(pathJob, { rsyncPath: '/mnt/user/cross-site/appdata' }), '/mnt/user/cross-site/appdata');
  assert.equal(resolveHyperRemotePath({ remote_path: '/backups/' }, { rsyncPath: '/backups' }), '/backups');
  // The whole prefix being the destination stays valid.
  assert.equal(resolveHyperRemotePath(pathJob, { rsyncPath: '/' }), '/');
  // The transfer must use the resolved path, not the raw job field.
  assert.match(hyperBackupSource, /const remotePath = resolveHyperRemotePath\(job, prepareResult\)/);
  assert.doesNotMatch(hyperBackupSource, /\$\{sshUser\}@\$\{sshHost\}:\$\{job\.remote_path\}/);

  console.log('Hyper SSH target: authenticated peer advertisement, overrides, and validation passed');
} finally {
  db.close();
  rmSync(fixture, { recursive: true, force: true });
}
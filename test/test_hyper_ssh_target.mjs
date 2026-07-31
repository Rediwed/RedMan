import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const fixture = resolve(import.meta.dirname, 'data', `hyper-ssh-target-${process.pid}`);
mkdirSync(fixture, { recursive: true });
process.env.DB_PATH = resolve(fixture, 'redman.db');
const { resolveHyperSshTarget, buildHyperSshCommand } = await import('../app/backend/src/services/hyperBackup.js');
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

  console.log('Hyper SSH target: authenticated peer advertisement, overrides, and validation passed');
} finally {
  db.close();
  rmSync(fixture, { recursive: true, force: true });
}
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const portable = resolve(root, 'scripts/setup-backup-user.sh');
const unraid = resolve(root, 'scripts/setup-unraid-backup-user.sh');

function run(script, args) {
  return spawnSync('bash', [script, ...args], { encoding: 'utf8' });
}

const linuxPlan = run(portable, ['--data-dir', '/srv/redman', '--backup-root', '/srv/redman-backups', '--dry-run']);
assert.equal(linuxPlan.status, 0, linuxPlan.stderr);
assert.match(linuxPlan.stdout, /BACKUP_GROUP=redman-backup/);
assert.match(linuxPlan.stdout, /HOME_DIR=\/var\/lib\/redman-backup/);
assert.match(linuxPlan.stdout, /AUTHORIZED_KEYS=\/srv\/redman\/ssh-keys\/authorized_keys/);
assert.match(linuxPlan.stdout, /AUTHORIZED_KEYS_COMMAND=\/usr\/local\/libexec\/redman-authorized-keys-redman-backup/);
assert.match(linuxPlan.stdout, /BACKUP_ROOT=\/srv\/redman-backups/);

const unraidPlan = run(unraid, ['--data-dir', '/mnt/user/appdata/redman', '--dry-run']);
assert.equal(unraidPlan.status, 0, unraidPlan.stderr);
assert.match(unraidPlan.stdout, /HOME_DIR=\/home\/redman-backup/);

assert.notEqual(run(portable, ['--data-dir', 'relative', '--dry-run']).status, 0);
assert.notEqual(run(portable, ['--data-dir', '/srv/redman', '--user', 'root', '--dry-run']).status, 0);
assert.notEqual(run(portable, ['--data-dir', '/srv/redman', '--authorized-keys', '/tmp/keys', '--dry-run']).status, 0);

const portableSource = readFileSync(portable, 'utf8');
const unraidSource = readFileSync(unraid, 'utf8');
for (const directive of ['AuthorizedKeysFile none', 'AuthorizedKeysCommand', 'AuthorizedKeysCommandUser', 'PasswordAuthentication no', 'PermitTTY no', 'AllowTcpForwarding no', 'PermitTunnel no']) {
  assert.match(portableSource, new RegExp(directive.replace(/ /g, '\\s+')));
}
assert.match(portableSource, /AuthorizedKeysCommandUser root/);
assert.match(portableSource, /install -m 0600 -o root -g root/);
assert.match(portableSource, /CANONICAL_BACKUP_ROOTS/);
assert.match(portableSource, /path !~ \/\^\\\/\[-A-Za-z0-9\._\\\/ \]\+\$\//);
assert.doesNotMatch(portableSource, /\/boot\/config|group users|T_SSH/i);
assert.match(unraidSource, /\/boot\/config\/go/);
assert.match(unraidSource, /setup-backup-user\.sh/);
assert.match(unraidSource, /WayneD\/rsync\/v3\.2\.1\/support\/rrsync/);
assert.match(unraidSource, /34661573a4b773b07191fe4b6f583a348bb0ed70909ad84b1cc24ce58aaf27b0/);
assert.match(unraidSource, /BOOT_COMMAND="bash/);
assert.match(unraidSource, /bash "\$CORE_SCRIPT"/);

// Unraid's /etc/rc.d/rc.sshd restart rebuilds sshd_config from a template and
// takes the Match block with it, while still reporting success — so signalling
// the running listener must be tried first, and the block must be re-checked
// after any reload rather than assumed to have survived.
const sighupAt = portableSource.indexOf('kill -HUP "$sshd_pid"');
const rcSshdAt = portableSource.indexOf('[[ -x /etc/rc.d/rc.sshd ]]');
assert.notEqual(sighupAt, -1, 'reload must be able to signal sshd directly');
assert.notEqual(rcSshdAt, -1);
assert.ok(sighupAt < rcSshdAt, 'SIGHUP must be attempted before rc.sshd restart');
assert.match(portableSource, /grep -qF "\$BEGIN_MARKER" "\$SSHD_CONFIG"/);
assert.match(portableSource, /discarded the \$\{BACKUP_USER\} block/);

console.log('Backup account bootstrap: generic Linux and Unraid greenfield plans passed');
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
// As root, kill succeeds against any live pid, so a recycled pid would
// terminate an unrelated daemon and still report a successful reload.
assert.match(portableSource, /ps -p "\$sshd_pid" -o comm=/);
assert.ok(portableSource.indexOf('ps -p "$sshd_pid" -o comm=') < portableSource.indexOf('kill -HUP "$sshd_pid"'),
  'the pid must be confirmed to be sshd before it is signalled');
// The on-disk file surviving does not prove the daemon resolves the block.
assert.match(portableSource, /"\$SSHD_BIN" -T -f "\$SSHD_CONFIG" -C "user=\$BACKUP_USER/);
assert.match(portableSource, /passwordauthentication no/);

// A restricted account cannot chmod files it does not own, so backup content
// left by an earlier root-owned run is unusable until it is handed over.
assert.match(portableSource, /--adopt-backup-roots/);
assert.match(portableSource, /ADOPT_ROOTS=false/);
// Handing over is opt-in: an unbounded recursive chown must not run on boot.
assert.doesNotMatch(portableSource, /^ADOPT_ROOTS=true/m);
// find -exec chown hands path strings to a separate process that re-resolves
// them, so a writer swapping a directory component mid-run can redirect a root
// chown outside the tree. chown -R walks with directory file descriptors.
assert.match(portableSource, /chown -Rh "\$BACKUP_USER:\$BACKUP_GROUP" "\$root"/);
assert.doesNotMatch(portableSource, /-exec chown/);
// -h keeps a symlink's target — which may lie outside the root — untouched.
assert.doesNotMatch(portableSource, /chown -R "/);
// The detection is bounded in the clean case too, not only when it finds a hit.
assert.match(portableSource, /-xdev -mindepth 1 -maxdepth 3 ! -user "\$BACKUP_USER" -print -quit/);
assert.match(portableSource, /command -v timeout[^\n]*\|\| continue/);
assert.match(portableSource, /rc -eq 124/);
// Adoption must never abort the script: the sshd block is configured above it.
const adoptIdx = portableSource.indexOf('adopt_or_report_backup_roots || true');
const reloadIdx = portableSource.indexOf('if ! reload_sshd; then');
assert.ok(adoptIdx !== -1 && reloadIdx !== -1 && adoptIdx > reloadIdx, 'adoption runs after the sshd configuration');
assert.match(portableSource, /adopt_or_report_backup_roots \|\| true/);
// Re-owning a mount point or system path would rewrite unrelated shares.
assert.match(portableSource, /ADOPT_DENYLIST=/);
assert.match(portableSource, /mountpoint -q "\$root" && return 0/);
for (const p of ['/mnt/user', '/mnt/disks', '/etc', '/home']) {
  assert.ok(portableSource.includes(p), `denylist must cover ${p}`);
}
// It acts on the canonicalised root, not the raw argument.
assert.match(portableSource, /for root in "\$\{CANONICAL_ROOT_LIST\[@\]\}"/);
// A filename chosen by a peer must not be able to rewrite the console.
assert.match(portableSource, /tr -d '\[:cntrl:\]'/);
// -R would hand the root itself to the account; it is meant to stay
// root-owned with setgid so new content inherits the group.
assert.match(portableSource, /chown "root:\$BACKUP_GROUP" "\$root" && chmod 2770 "\$root"/);

// The Unraid wrapper accepts the flag but never persists it into the boot file.
assert.match(unraidSource, /--adopt-backup-roots\)/);
const wrapperAdopt = unraidSource.slice(unraidSource.indexOf('--adopt-backup-roots)'), unraidSource.indexOf('--adopt-backup-roots)') + 260);
assert.doesNotMatch(wrapperAdopt, /PERSIST_ARGS\+=/);

console.log('Backup account bootstrap: generic Linux and Unraid greenfield plans passed');
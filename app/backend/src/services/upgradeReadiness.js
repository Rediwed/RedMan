import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export const UPGRADE_BRIDGE_VERSION = 1;
export const UPGRADE_BACKUP_PAGES_PER_STEP = 16_384;
const READINESS_DIR = 'upgrade-readiness';
const HOST_RECEIPT = 'host-prepared.json';
const BACKUP_RECEIPT = 'application-backup.json';
const BACKEND_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const execFileAsync = promisify(execFile);
const HELPER_RELEASE = 'v1.1.7';
const HELPER_BASE_URL = `https://raw.githubusercontent.com/Rediwed/RedMan/${HELPER_RELEASE}/scripts`;
const UNRAID_RRSYNC_RELEASE = 'v3.2.1';
const UNRAID_RRSYNC_URL = `https://raw.githubusercontent.com/WayneD/rsync/${UNRAID_RRSYNC_RELEASE}/support/rrsync`;
const UNRAID_RRSYNC_SHA256 = '34661573a4b773b07191fe4b6f583a348bb0ed70909ad84b1cc24ce58aaf27b0';
const HELPER_FILES = Object.freeze({
  'prepare-upgrade-host.sh': '7e8e61f5097e2c6652f5b7fe55f0424a2d767f1d8fea3e0d30f04613828db037',
  'setup-backup-user.sh': 'ee055b8de0d933a54d537f3927bcb23eae423cd1de38f306b2701fb644387bdc',
  'setup-unraid-backup-user.sh': 'c4b4177bbe4a5f8caada815862656d138a06ae892e960567530f5faedae9b811',
});

function tableExists(database, table) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function columns(database, table) {
  if (!tableExists(database, table)) return new Set();
  return new Set(database.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name));
}

function count(database, sql) {
  return Number(database.prepare(sql).get()?.count || 0);
}

function setting(database, key) {
  if (!tableExists(database, 'settings')) return '';
  return String(database.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value || '');
}

function normalizeTimezone(value) {
  const timezone = String(value || '').trim();
  if (!/^[A-Za-z][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9._+-]+)*$/.test(timezone)) {
    throw new Error('Timezone must be a valid IANA zone such as Europe/Amsterdam or UTC');
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
  } catch {
    throw new Error('Timezone must be a valid IANA zone such as Europe/Amsterdam or UTC');
  }
  return timezone;
}

function suggestedTimezone(database, fallback) {
  const runtimeTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  for (const candidate of [setting(database, 'timezone'), fallback, process.env.TZ, runtimeTimezone, 'UTC']) {
    try {
      return normalizeTimezone(candidate);
    } catch {
      // Try the next configured source.
    }
  }
  return 'UTC';
}

function check(id, label, status, detail, resolution = null) {
  return { id, label, status, detail, resolution: status === 'pass' ? null : resolution };
}

const RESOLUTIONS = Object.freeze({
  'database-integrity': {
    timing: 'now',
    title: 'Stop and restore a known-good database',
    steps: [
      'Do not continue with this upgrade while the SQLite schema is unreadable.',
      'Stop RedMan and restore the verified pre-bridge rollback database.',
      'Start the bridge again, then refresh this assessment.',
    ],
    action: { type: 'refresh', label: 'Recheck database' },
  },
  'active-runs': {
    timing: 'now',
    title: 'Wait for active work to stop',
    steps: [
      'Let the reported job finish; do not interrupt file transfers from this screen.',
      'If the marker remains after the process has stopped, restart the bridge so stale running records are closed safely.',
      'Refresh this assessment before creating the backup.',
    ],
    action: { type: 'refresh', label: 'Check again' },
  },
  'legacy-ssh-jobs': {
    timing: 'prepare-host',
    title: 'Prepare the restricted account, then migrate at cutover',
    steps: [
      'Create the verified backup first.',
      'In Prepare host, install the restricted redman-backup account and approved roots.',
      'The hardened migration changes these jobs from root to redman-backup; test each job after cutover.',
    ],
    action: { type: 'step', step: 2, label: 'Open Prepare host' },
  },
  'legacy-peers': {
    timing: 'after-cutover',
    title: 'Review and re-pair after the hardened cutover',
    steps: [
      'Do not broaden or rewrite peer grants in the bridge; preserving them keeps rollback predictable.',
      'The hardened migration disables grants with root scope, unlimited quota, or missing stable identity.',
      'After cutover, re-pair affected peers with a narrow path and finite quota.',
    ],
  },
  'media-deletion': {
    timing: 'now',
    title: 'Disable destructive source deletion now',
    steps: [
      'Disable delete-after-import on every affected drive before continuing.',
      'The hardened release can re-enable deletion only after per-file upload verification is available.',
    ],
    action: { type: 'remediate', issueId: 'media-deletion', label: 'Disable delete-after-import' },
  },
  'docker-access': {
    timing: 'configure',
    title: 'Choose the hardened Docker boundary during configuration',
    steps: [
      'The bridge already runs without the raw Docker socket, so no host change is needed now.',
      'In Configure, enable Docker monitoring only if you need it.',
      'The hardened deployment then uses separate exact-path read and control proxies.',
    ],
    action: { type: 'step', step: 3, label: 'Open Configure' },
  },
  'application-backup': {
    timing: 'now',
    title: 'Create the verified application backup',
    steps: [
      'Open Back up and create an online SQLite backup.',
      'Wait for the full integrity check and SHA-256 receipt to complete.',
    ],
    action: { type: 'step', step: 1, label: 'Create backup' },
  },
  'host-preparation': {
    timing: 'prepare-host',
    title: 'Run the generated command on the NAS host',
    steps: [
      'Create the verified application backup first.',
      'Open Prepare host, select narrow backup roots, and generate the command.',
      'Run it once in the NAS terminal, then return here and check the receipt.',
    ],
    action: { type: 'step', step: 2, label: 'Open Prepare host' },
  },
});

function receiptPath(dataDir, filename) {
  return join(dataDir, READINESS_DIR, filename);
}

function readJson(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return { invalid: true };
  }
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function safeRelativePath(value, requiredPrefix) {
  const normalized = String(value || '').replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')
      || !normalized.startsWith(`${requiredPrefix}/`)) return null;
  return normalized;
}

function inspectHostReceipt(dataDir) {
  const filePath = receiptPath(dataDir, HOST_RECEIPT);
  const receipt = readJson(filePath);
  if (!receipt) return { status: 'missing', path: filePath, receipt: null };
  if (receipt.invalid || receipt.bridgeVersion !== UPGRADE_BRIDGE_VERSION
      || !['linux', 'unraid'].includes(receipt.platform)
      || receipt.user !== 'redman-backup'
      || !Array.isArray(receipt.backupRoots)
      || receipt.backupRoots.length === 0
      || !safeRelativePath(receipt.rollbackRelativePath, READINESS_DIR)
      || !Array.isArray(receipt.artifacts)
      || receipt.artifacts.length < 2) {
    return { status: 'invalid', path: filePath, receipt: null };
  }
  const rollbackPath = resolve(dataDir, receipt.rollbackRelativePath);
  if (!existsSync(rollbackPath)) return { status: 'invalid', path: filePath, receipt: null };
  for (const artifact of receipt.artifacts) {
    const relativePath = safeRelativePath(artifact.relativePath, receipt.rollbackRelativePath);
    if (!relativePath || !/^[a-f0-9]{64}$/.test(artifact.sha256 || '')) {
      return { status: 'invalid', path: filePath, receipt: null };
    }
    const artifactPath = resolve(dataDir, relativePath);
    if (!existsSync(artifactPath) || statSync(artifactPath).size !== artifact.sizeBytes) {
      return { status: 'invalid', path: filePath, receipt: null };
    }
  }
  const databaseArtifact = receipt.artifacts.find(artifact => artifact.relativePath.endsWith('/redman.db'));
  if (!databaseArtifact) return { status: 'invalid', path: filePath, receipt: null };
  return { status: 'ready', path: filePath, receipt };
}

function inspectApplicationBackup(dataDir) {
  const filePath = receiptPath(dataDir, BACKUP_RECEIPT);
  const receipt = readJson(filePath);
  if (!receipt) return { status: 'missing', path: filePath, receipt: null };
  const relativePath = safeRelativePath(receipt.backupRelativePath, `${READINESS_DIR}/backups`);
  if (receipt.invalid || receipt.bridgeVersion !== UPGRADE_BRIDGE_VERSION
      || receipt.integrity !== 'ok' || !relativePath || !/^[a-f0-9]{64}$/.test(receipt.sha256 || '')) {
    return { status: 'invalid', path: filePath, receipt: null };
  }
  const backupPath = resolve(dataDir, relativePath);
  try {
    if (!existsSync(backupPath) || statSync(backupPath).size !== receipt.sizeBytes) {
      throw new Error('backup receipt mismatch');
    }
  } catch {
    return { status: 'invalid', path: filePath, receipt: null };
  }
  receipt.backupPath = backupPath;
  return { status: 'ready', path: filePath, receipt };
}

function pathCandidates(database) {
  const candidates = new Set();
  const collect = (table, fields) => {
    const available = columns(database, table);
    const selected = fields.filter(field => available.has(field));
    if (selected.length === 0) return;
    for (const row of database.prepare(`SELECT ${selected.join(', ')} FROM ${table}`).all()) {
      for (const field of selected) {
        const value = String(row[field] || '').trim();
        if (value.startsWith('/') && value !== '/') candidates.add(value);
      }
    }
  };
  collect('ssd_backup_configs', ['dest_path']);
  collect('hyper_backup_jobs', ['local_path']);
  collect('authorized_peers', ['allowed_path_prefix']);
  return [...candidates].sort();
}

export function assessUpgradeReadiness(database, options = {}) {
  const dataDir = resolve(options.dataDir || dirname(database.name));
  const checks = [];
  let databaseReadable = true;
  try {
    database.prepare('SELECT name FROM sqlite_master LIMIT 1').get();
  } catch {
    databaseReadable = false;
  }
  checks.push(check(
    'database-integrity',
    'Database readability',
    databaseReadable ? 'pass' : 'blocked',
    databaseReadable
      ? 'SQLite schema is readable; the backup step performs a full off-process integrity check.'
      : 'SQLite schema could not be read.',
    RESOLUTIONS['database-integrity'],
  ));

  const activeRuns = tableExists(database, 'backup_runs')
    ? count(database, "SELECT COUNT(*) AS count FROM backup_runs WHERE status = 'running'")
    : 0;
  checks.push(check(
    'active-runs',
    'Active work',
    activeRuns === 0 ? 'pass' : 'blocked',
    activeRuns === 0 ? 'No database-backed jobs are running.' : `${activeRuns} job(s) must finish or be stopped before preparation.`,
    RESOLUTIONS['active-runs'],
  ));

  const hyperColumns = columns(database, 'hyper_backup_jobs');
  const rootJobs = hyperColumns.has('ssh_user')
    ? count(database, "SELECT COUNT(*) AS count FROM hyper_backup_jobs WHERE ssh_user IS NULL OR ssh_user = 'root'")
    : 0;
  checks.push(check(
    'legacy-ssh-jobs',
    'Legacy Hyper Backup SSH users',
    rootJobs === 0 ? 'pass' : 'warning',
    rootJobs === 0 ? 'No root-based Hyper Backup jobs were found.' : `${rootJobs} job(s) will move to the restricted redman-backup account.`,
    RESOLUTIONS['legacy-ssh-jobs'],
  ));

  const peerColumns = columns(database, 'authorized_peers');
  let unsafePeers = 0;
  if (peerColumns.size > 0) {
    const conditions = [];
    if (peerColumns.has('allowed_path_prefix')) conditions.push("allowed_path_prefix = '/'");
    if (peerColumns.has('storage_limit_bytes')) conditions.push('storage_limit_bytes <= 0');
    if (peerColumns.has('static_pubkey')) conditions.push('static_pubkey IS NULL');
    if (conditions.length > 0) {
      unsafePeers = count(database, `SELECT COUNT(*) AS count FROM authorized_peers WHERE enabled = 1 AND (${conditions.join(' OR ')})`);
    }
  }
  checks.push(check(
    'legacy-peers',
    'Legacy peer grants',
    unsafePeers === 0 ? 'pass' : 'warning',
    unsafePeers === 0 ? 'No broad or unverifiable enabled peers were found.' : `${unsafePeers} peer grant(s) require review or re-pairing after the hardened upgrade.`,
    RESOLUTIONS['legacy-peers'],
  ));

  const mediaColumns = columns(database, 'media_drives');
  const destructiveMedia = mediaColumns.has('delete_after_import')
    ? count(database, 'SELECT COUNT(*) AS count FROM media_drives WHERE delete_after_import != 0')
    : 0;
  checks.push(check(
    'media-deletion',
    'Delete-after-import settings',
    destructiveMedia === 0 ? 'pass' : 'warning',
    destructiveMedia === 0 ? 'No delete-after-import setting is enabled.' : `${destructiveMedia} drive setting(s) will be disabled until per-file verification is available.`,
    RESOLUTIONS['media-deletion'],
  ));

  const dockerEndpoint = setting(database, 'docker_socket');
  const directDockerSocket = dockerEndpoint.startsWith('/');
  checks.push(check(
    'docker-access',
    'Docker monitoring endpoint',
    directDockerSocket ? 'warning' : 'pass',
    directDockerSocket
      ? 'Direct socket access will be replaced by optional exact-path proxy sidecars.'
      : (dockerEndpoint ? 'Docker monitoring already uses a network endpoint.' : 'Docker monitoring is not configured.'),
    RESOLUTIONS['docker-access'],
  ));

  const applicationBackup = inspectApplicationBackup(dataDir);
  checks.push(check(
    'application-backup',
    'Verified pre-upgrade backup',
    applicationBackup.status === 'ready' ? 'pass' : 'blocked',
    applicationBackup.status === 'ready'
      ? `Verified backup: ${applicationBackup.receipt.backupPath}`
      : 'Create a verified online database backup before running the host helper.',
    RESOLUTIONS['application-backup'],
  ));

  const hostPreparation = inspectHostReceipt(dataDir);
  checks.push(check(
    'host-preparation',
    'Host preparation receipt',
    hostPreparation.status === 'ready' ? 'pass' : (hostPreparation.status === 'invalid' ? 'blocked' : 'warning'),
    hostPreparation.status === 'ready'
      ? `Prepared ${hostPreparation.receipt.platform} host for ${hostPreparation.receipt.backupRoots.length} backup root(s).`
      : (hostPreparation.status === 'invalid' ? 'The host receipt is invalid or incompatible.' : 'Run the generated host command after creating the backup.'),
    RESOLUTIONS['host-preparation'],
  ));

  return {
    bridgeVersion: UPGRADE_BRIDGE_VERSION,
    dataDir,
    databasePath: database.name,
    suggestedTimezone: suggestedTimezone(database, options.timezone),
    checks,
    summary: {
      pass: checks.filter(item => item.status === 'pass').length,
      warning: checks.filter(item => item.status === 'warning').length,
      blocked: checks.filter(item => item.status === 'blocked').length,
      activeRuns,
      rootJobs,
      unsafePeers,
      destructiveMedia,
    },
    pathCandidates: pathCandidates(database),
    applicationBackup,
    hostPreparation,
  };
}

export function remediateUpgradeIssue(database, issueId) {
  if (issueId !== 'media-deletion') {
    const error = new Error('This issue has no bridge-owned automatic remediation');
    error.status = 400;
    throw error;
  }
  const mediaColumns = columns(database, 'media_drives');
  if (!tableExists(database, 'media_drives') || !mediaColumns.has('delete_after_import')) {
    return { issueId, changed: 0 };
  }
  const result = database.prepare(mediaColumns.has('updated_at')
    ? "UPDATE media_drives SET delete_after_import = 0, updated_at = datetime('now') WHERE delete_after_import != 0"
    : 'UPDATE media_drives SET delete_after_import = 0 WHERE delete_after_import != 0').run();
  return { issueId, changed: result.changes };
}

function safeTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

async function validateBackupFile(filePath) {
  const script = `
    import Database from 'better-sqlite3';
    const candidate = new Database(process.env.REDMAN_BACKUP_PATH, { readonly: true, fileMustExist: true });
    try {
      const result = candidate.pragma('integrity_check', { simple: true });
      if (result !== 'ok') throw new Error('Backup integrity check failed');
    } finally {
      candidate.close();
    }
  `;
  try {
    await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: BACKEND_DIR,
      env: { ...process.env, REDMAN_BACKUP_PATH: filePath },
      maxBuffer: 1024 * 1024,
      timeout: 30 * 60 * 1000,
    });
  } catch {
    throw new Error('Backup integrity check failed');
  }
}

function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, filePath);
}

export async function createUpgradeBackup(database, options = {}) {
  const dataDir = resolve(options.dataDir || dirname(database.name));
  const activeRuns = tableExists(database, 'backup_runs')
    ? count(database, "SELECT COUNT(*) AS count FROM backup_runs WHERE status = 'running'")
    : 0;
  if (activeRuns > 0) {
    const error = new Error(`${activeRuns} active job(s) block the pre-upgrade backup`);
    error.status = 409;
    throw error;
  }
  const readinessDir = join(dataDir, READINESS_DIR);
  const backupDir = join(readinessDir, 'backups');
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  chmodSync(readinessDir, 0o700);
  chmodSync(backupDir, 0o700);

  const timestamp = safeTimestamp(options.now || new Date());
  const backupPath = join(backupDir, `redman-pre-hardened-${timestamp}.db`);
  const backupRelativePath = join(READINESS_DIR, 'backups', `redman-pre-hardened-${timestamp}.db`);
  const temporaryPath = `${backupPath}.tmp`;
  if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
  let digest;
  try {
    await database.backup(temporaryPath, {
      progress: () => UPGRADE_BACKUP_PAGES_PER_STEP,
    });
    chmodSync(temporaryPath, 0o600);
    await validateBackupFile(temporaryPath);
    digest = await sha256File(temporaryPath);
    renameSync(temporaryPath, backupPath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }

  const receipt = {
    bridgeVersion: UPGRADE_BRIDGE_VERSION,
    createdAt: (options.now || new Date()).toISOString(),
    backupRelativePath,
    backupPath,
    sizeBytes: statSync(backupPath).size,
    sha256: digest,
    integrity: 'ok',
  };
  writeJsonAtomic(receiptPath(dataDir, BACKUP_RECEIPT), receipt);

  const backups = readdirSync(backupDir)
    .filter(name => name.startsWith('redman-pre-hardened-') && name.endsWith('.db'))
    .sort()
    .reverse();
  for (const expired of backups.slice(3)) rmSync(join(backupDir, expired), { force: true });
  return receipt;
}

function absolutePath(value, label) {
  const raw = String(value || '').trim();
  if (!/^\/[A-Za-z0-9._/-]+$/.test(raw) || raw.split('/').includes('..')) {
    throw new Error(`${label} must be a non-root absolute path without traversal or shell characters`);
  }
  const normalized = posix.normalize(raw).replace(/\/$/, '');
  if (!normalized || normalized === '/') {
    throw new Error(`${label} must be a non-root absolute path without traversal or shell characters`);
  }
  return normalized;
}

function containerName(value) {
  const normalized = String(value || 'redman').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(normalized)) throw new Error('Container name is invalid');
  return normalized;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function createHostPreparationPlan(input = {}) {
  const platform = String(input.platform || '').toLowerCase();
  if (!['linux', 'unraid'].includes(platform)) throw new Error('Platform must be linux or unraid');
  const dataDir = absolutePath(input.dataDir, 'Data directory');
  const roots = [...new Set((input.backupRoots || []).map((root, index) => absolutePath(root, `Backup root ${index + 1}`)))];
  if (roots.length === 0 || roots.length > 16) throw new Error('Provide between 1 and 16 backup roots');
  const container = containerName(input.container);
  const privilege = platform === 'linux' ? 'sudo ' : '';
  const arguments_ = [
    '--platform', platform,
    '--container', container,
    '--data-dir', dataDir,
    ...roots.flatMap(root => ['--backup-root', root]),
  ];
  const downloads = Object.entries(HELPER_FILES).flatMap(([filename, checksum]) => [
    `curl -fsSL --proto '=https' --tlsv1.2 -o "$REDMAN_BRIDGE_TMP/${filename}" ${shellQuote(`${HELPER_BASE_URL}/${filename}`)}`,
    `printf ${shellQuote(`${checksum}  %s\n`)} "$REDMAN_BRIDGE_TMP/${filename}" | sha256sum -c -`,
  ]);
  if (platform === 'unraid') {
    downloads.push(
      `curl -fsSL --proto '=https' --tlsv1.2 -o "$REDMAN_BRIDGE_TMP/rrsync" ${shellQuote(UNRAID_RRSYNC_URL)}`,
      `printf ${shellQuote(`${UNRAID_RRSYNC_SHA256}  %s\n`)} "$REDMAN_BRIDGE_TMP/rrsync" | sha256sum -c -`,
    );
  }
  const installerArguments = arguments_.map(shellQuote).join(' ')
    + (platform === 'unraid' ? ' --rrsync-source "$REDMAN_BRIDGE_TMP/rrsync"' : '');
  const command = [
    'REDMAN_BRIDGE_TMP="$(mktemp -d /tmp/redman-upgrade-bridge.XXXXXX)"',
    'trap \'rm -rf "$REDMAN_BRIDGE_TMP"\' EXIT',
    ...downloads,
    `chmod 0700 "$REDMAN_BRIDGE_TMP/"*.sh`,
    `${privilege}bash "$REDMAN_BRIDGE_TMP/prepare-upgrade-host.sh" ${installerArguments}`,
  ].join(' && \\\n');
  return {
    bridgeVersion: UPGRADE_BRIDGE_VERSION,
    platform,
    container,
    dataDir,
    backupRoots: roots,
    command,
    receiptPath: join(dataDir, READINESS_DIR, HOST_RECEIPT),
  };
}

export function createFinalConfiguration(input = {}) {
  const authMode = String(input.authMode || 'proxy').toLowerCase();
  if (!['proxy', 'local'].includes(authMode)) throw new Error('Authentication mode must be proxy or local');
  const publicOrigin = String(input.publicOrigin || '').trim();
  if (!/^https:\/\/[A-Za-z0-9._:-]+$/.test(publicOrigin)) throw new Error('Public origin must be an exact HTTPS origin');
  const trustedProxy = String(input.trustedProxy || '').trim();
  const [trustedAddress, trustedPrefix] = trustedProxy.split('/');
  const trustedVersion = isIP(trustedAddress);
  if (!trustedVersion || (trustedPrefix && trustedPrefix !== (trustedVersion === 4 ? '32' : '128'))) {
    throw new Error('Trusted proxy must be one exact IPv4 or IPv6 host');
  }
  const peerHost = String(input.peerHost || '').trim().replace(/^\[|\]$/g, '');
  const peerVersion = isIP(peerHost);
  const privatePeer = peerVersion === 4
    ? (() => {
        const parts = peerHost.split('.').map(Number);
        return parts[0] === 10
          || parts[0] === 127
          || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
          || (parts[0] === 192 && parts[1] === 168)
          || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
          || (parts[0] === 169 && parts[1] === 254);
      })()
    : peerVersion === 6 && (peerHost === '::1' || /^(?:fc|fd|fe[89ab])/i.test(peerHost));
  if (!privatePeer) throw new Error('Peer host must be a numeric private IP');
  const dataPath = absolutePath(input.dataPath, 'Data path');
  const storagePath = absolutePath(input.storagePath, 'Storage path');
  const mediaPath = absolutePath(input.mediaPath, 'Media path');
  const timezone = normalizeTimezone(
    Object.prototype.hasOwnProperty.call(input, 'timezone') ? input.timezone : 'UTC',
  );
  if (dataPath === '/mnt/user') throw new Error('Data path may not authorize every Unraid user share');
  if (mediaPath === '/mnt/user') throw new Error('Media path may not authorize every Unraid user share');
  if (storagePath === '/mnt/user' && input.allowBroadStorage !== true) {
    throw new Error('Using /mnt/user requires explicit confirmation that every Unraid share is intentionally in scope');
  }
  const dockerMonitoring = Boolean(input.dockerMonitoring);
  const lines = [
    `REDMAN_DATA_PATH=${dataPath}`,
    `REDMAN_STORAGE_PATH=${storagePath}`,
    `REDMAN_MEDIA_PATH=${mediaPath}`,
    `REDMAN_HOST_AUTHORIZED_KEYS_PATH=${dataPath}/ssh-keys/authorized_keys`,
    'REDMAN_WEB_PORT=8090',
    'REDMAN_PEER_PUBLISHED_PORT=8091',
    `AUTH_MODE=${authMode}`,
    `REDMAN_PUBLIC_ORIGIN=${publicOrigin}`,
    `TRUSTED_PROXIES=${trustedPrefix ? trustedProxy : `${trustedProxy}/${trustedVersion === 6 ? '128' : '32'}`}`,
    'PROXY_AUTO_PROVISION_ROLE=',
    `REDMAN_BOOTSTRAP_TOKEN=${authMode === 'local' ? '<generate-a-32-character-random-token>' : ''}`,
    `PEER_HOST=${peerHost}`,
    `TZ=${timezone}`,
    `DOCKER_HOST=${dockerMonitoring ? 'http://docker-socket-proxy:2375' : ''}`,
    `DOCKER_CONTROL_HOST=${dockerMonitoring ? 'http://docker-control-proxy:2375' : ''}`,
  ];
  return { authMode, timezone, dockerMonitoring, broadStorageConfirmed: storagePath === '/mnt/user', env: `${lines.join('\n')}\n` };
}

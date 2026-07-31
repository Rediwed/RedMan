// Hyper Backup service — cross-site backup orchestrator
// Uses API-to-API for the control plane, rsync over SSH for data transfer

import os from 'os';
import db from '../db.js';
import { runRsyncWithSsh, cancelSsdRun } from './rsync.js';
import { createJobNotificationTracker, notifyBackupResult, shouldNotify } from './notify.js';
import { isCancelledRun } from './runStatus.js';
import { claimBackupRun } from './runClaim.js';
import { assertLocalSourceHasEntries } from './sourceHealth.js';
import { validatePrivatePeerBaseUrl } from './peerUrlPolicy.js';
import { decryptPeerApiKey } from './peerSecrets.js';
import { resolvePeerBinding, syncJobRemoteUrl } from './peerBinding.js';
import { getIdentityPath } from './sshManager.js';
import { runtimeConfig } from './runtimeConfig.js';
import { validateSshHost, validateSshPort, validateSshUser } from '../middleware/validation.js';
import { validatePrivatePeerHost } from './peerUrlPolicy.js';
import { fetchWithoutRedirect } from './httpPolicy.js';

const IS_MAC = os.platform() === 'darwin';
const activeRuns = new Map();

export function cancelHyperRun(runId) {
  return cancelSsdRun(runId);
}

// Rsync exit codes → user-friendly descriptions
const RSYNC_EXIT_MESSAGES = {
  1:  'Syntax or usage error in rsync command',
  2:  'Protocol incompatibility between local and remote rsync',
  3:  'Errors selecting input/output files or directories',
  4:  'Requested action not supported',
  5:  'Error starting client-server protocol',
  10: 'Error in socket I/O',
  11: 'Error in file I/O',
  12: 'Error in rsync protocol data stream',
  13: 'Errors with program diagnostics',
  14: 'Error in IPC code',
  20: 'Transfer interrupted (SIGUSR1 or SIGINT received)',
  21: 'Some error returned by waitpid()',
  22: 'Error allocating core memory buffers',
  23: 'Partial transfer due to error',
  24: 'Partial transfer due to vanished source files',
  25: 'The --max-delete limit stopped deletions',
  30: 'Timeout in data send/receive',
  35: 'Timeout waiting for daemon connection',
  127: 'rsync command not found',
  255: 'SSH connection failed',
};

export function getActiveHyperRun(runId) {
  return activeRuns.get(runId);
}

export function buildHyperSshCommand(port, identityPath = getIdentityPath()) {
  // rsync splits this string on whitespace and hands the pieces to ssh as argv,
  // so a value containing a space would inject an extra ssh option — and ssh
  // does run -o ProxyCommand= through a shell. Validate here rather than trust
  // the caller: this is an exported contract function.
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Hyper Backup SSH transport got an invalid SSH port: ${port}`);
  }
  if (identityPath != null && (/\s/.test(identityPath) || identityPath.startsWith('-'))) {
    throw new Error('Hyper Backup SSH identity path may not contain whitespace or start with "-"');
  }
  // The key lives in the data volume, never in $HOME/.ssh, so ssh cannot find
  // it by itself. Without -i every transfer fails with "Permission denied
  // (publickey)" once the container is recreated.
  const identity = identityPath ? `-i ${identityPath} -o IdentitiesOnly=yes ` : '';
  return `ssh ${identity}-p ${port} -o StrictHostKeyChecking=accept-new`
    + ' -o ServerAliveInterval=60 -o ServerAliveCountMax=3 -o TCPKeepAlive=yes';
}

export function resolveHyperRemotePath(job, prepareResult) {
  // A restricted peer reaches its filesystem through rrsync, which resolves
  // every request under the allowed prefix. Such a peer advertises the path
  // rsync must ask for; the job's own absolute path would be applied twice.
  const advertised = prepareResult?.rsyncPath;
  if (advertised === undefined || advertised === null) return job.remote_path;
  if (typeof advertised !== 'string' || !advertised.startsWith('/')
      || /[\n\r\0]/u.test(advertised)
      || advertised.split('/').includes('..')) {
    throw new Error('Remote prepare returned an invalid rsync path');
  }
  return advertised;
}

export function resolveHyperSshTarget(job, prepareResult) {
  const host = job.ssh_host || (prepareResult.sshHost
    ? validatePrivatePeerHost(prepareResult.sshHost, 'Remote prepare SSH host')
    : new URL(job.remote_url).hostname);
  const user = job.ssh_user || prepareResult.sshUser || runtimeConfig.sshUser;
  const port = job.ssh_port || prepareResult.sshPort || runtimeConfig.sshPort;
  if (!validateSshHost(host)) throw new Error('Remote prepare returned an invalid SSH host');
  if (!validateSshUser(user)) throw new Error('Remote prepare returned an invalid SSH user');
  if (!validateSshPort(port)) throw new Error('Remote prepare returned an invalid SSH port');
  return { host, user, port: Number(port) };
}

export async function executeHyperBackup(jobId, existingRunId = null) {
  const job = db.prepare('SELECT * FROM hyper_backup_jobs WHERE id = ?').get(jobId);
  if (!job) throw new Error(`Hyper Backup job ${jobId} not found`);

  let runId = existingRunId;
  if (runId) {
    db.prepare(`UPDATE backup_runs SET status = 'running', peer_static_pubkey = ? WHERE id = ?`)
      .run(job.peer_static_pubkey, runId);
  } else {
    const claim = claimBackupRun(db, 'hyper-backup', jobId, job.peer_static_pubkey);
    if (!claim.claimed) return { runId: claim.runId, status: 'running', skipped: true };
    runId = claim.runId;
  }

  const startTime = Date.now();
  activeRuns.set(runId, { status: 'preparing', progress: null, startedAt: startTime });
  const notifications = createJobNotificationTracker({
    job, feature: 'Hyper Backup', name: job.name, runId, startedAt: startTime,
  });

  try {
    // Resolve the peer's current address and credential from the pairing record —
    // re-pairing rotates the API key and may move the peer to a new address.
    const binding = resolvePeerBinding(db, job);
    const remoteApiKey = decryptPeerApiKey(binding.apiKeyEncrypted);
    if (!remoteApiKey) throw new Error('Hyper Backup peer credential is unavailable');
    if (binding.source === 'job' && job.peer_static_pubkey) {
      console.warn(`[hyper-backup] No accepted pairing for job ${job.id}'s peer identity — falling back to the credential stored on the job`);
    }
    if (syncJobRemoteUrl(db, job, binding.remoteUrl)) {
      console.log(`[hyper-backup] Peer for job ${job.id} moved to ${binding.remoteUrl}`);
    }
    if (job.direction === 'push') {
      await assertLocalSourceHasEntries(job.local_path, 'Hyper Backup source');
    }

    // Step 1: Call remote peer API to prepare
    const prepareResult = await callPeerApi(binding.remoteUrl, remoteApiKey, 'POST', '/peer/backup/prepare', {
      direction: job.direction,
      remotePath: job.remote_path,
      runId,
    });

    if (!prepareResult.ok) {
      throw new Error(`Remote prepare failed: ${prepareResult.error || 'Unknown error'}`);
    }
    notifications.start();

    // Step 2: Execute rsync over SSH
    activeRuns.set(runId, { status: 'transferring', progress: null, startedAt: startTime });
    const { host: sshHost, user: sshUser, port: sshPort } = resolveHyperSshTarget(job, prepareResult);
    const remotePath = resolveHyperRemotePath(job, prepareResult);

    const args = [
      '-avz', '--delete-after',
      '--no-owner', '--no-group', '--omit-dir-times',
      '--itemize-changes', '--stats',
      // Resume partial transfers on interruption (critical for multi-TB datasets)
      '--partial',
      '--partial-dir=.rsync-partial',
      // Abort if no data transferred for 5 minutes (protects against hangs)
      '--timeout=300',
      IS_MAC ? '--progress' : '--info=progress2',
      '--out-format=%i %l %n',
      // SSH with keepalive to prevent silent connection drops on long transfers
      '-e', buildHyperSshCommand(sshPort),
    ];

    if (job.direction === 'push') {
      const source = job.local_path.endsWith('/') ? job.local_path : job.local_path + '/';
      args.push(source, `${sshUser}@${sshHost}:${remotePath}/`);
    } else {
      args.push(`${sshUser}@${sshHost}:${remotePath}/`, job.local_path + '/');
    }

    const insertFile = db.prepare(`
      INSERT INTO backup_run_files (run_id, file_path, action, size) VALUES (?, ?, ?, ?)
    `);
    const insertAllFiles = db.transaction((entries) => {
      for (const entry of entries) insertFile.run(runId, entry.path, entry.action, entry.size);
    });
    let pendingFileEntries = [];
    const flushFileEntries = () => {
      if (pendingFileEntries.length === 0) return;
      insertAllFiles(pendingFileEntries);
      pendingFileEntries = [];
    };

    const result = await runRsyncWithSsh(args, (rsyncProgress) => {
      activeRuns.set(runId, {
        status: 'transferring', startedAt: startTime,
        ...rsyncProgress,
      });
      notifications.progress(rsyncProgress);
    }, runId, (entry) => {
      pendingFileEntries.push(entry);
      if (pendingFileEntries.length >= 1000) flushFileEntries();
    });
    flushFileEntries();
    activeRuns.set(runId, { status: 'completing', startedAt: startTime, ...result.progress });

    const persistedStatus = db.prepare('SELECT status FROM backup_runs WHERE id = ?').get(runId)?.status;
    const status = isCancelledRun(persistedStatus, result.exitCode)
      ? 'cancelled'
      : result.exitCode === 0
        ? (result.progress.filesFailed > 0 ? 'partial' : 'completed')
        : ([23, 24].includes(result.exitCode) && result.progress.filesCopied > 0 ? 'partial' : 'failed');

    // Step 3: Notify remote peer that transfer is complete
    await callPeerApi(binding.remoteUrl, remoteApiKey, 'POST', '/peer/backup/complete', {
      runId,
      status,
      stats: result.progress,
    });

    // Update run record
    const duration = (Date.now() - startTime) / 1000;
    db.prepare(`
      UPDATE backup_runs SET
        status = ?, completed_at = datetime('now'),
        files_total = ?, files_copied = ?, files_failed = ?,
        bytes_transferred = ?, duration_seconds = ?,
        error_message = ?
      WHERE id = ?
    `).run(
      status,
      result.progress.filesTotal, result.progress.filesCopied, result.progress.filesFailed,
      result.progress.bytesTransferred, duration,
      status === 'cancelled'
        ? 'Cancelled by user'
        : result.exitCode !== 0 ? buildRsyncErrorMessage(result) : null,
      runId,
    );

    // Notification
    if (status === 'completed' && shouldNotify(job, 'success')) {
      await notifyBackupResult('Hyper Backup', job.name, 'completed', {
        filesCopied: result.progress.filesCopied, filesFailed: result.progress.filesFailed,
        bytesTransferred: result.progress.bytesTransferred, duration,
      });
    } else if (status === 'partial' && shouldNotify(job, 'partial')) {
      await notifyBackupResult('Hyper Backup', job.name, 'partial', {
        filesCopied: result.progress.filesCopied, filesFailed: result.progress.filesFailed,
        bytesTransferred: result.progress.bytesTransferred, duration,
        errorMessage: buildRsyncErrorMessage(result),
      });
    } else if (status === 'failed' && shouldNotify(job, 'failure')) {
      await notifyBackupResult('Hyper Backup', job.name, 'failed', {
        filesCopied: result.progress.filesCopied, bytesTransferred: result.progress.bytesTransferred, duration,
      });
    }

    return { runId, status };
  } catch (err) {
    const duration = (Date.now() - startTime) / 1000;
    const persistedStatus = db.prepare('SELECT status FROM backup_runs WHERE id = ?').get(runId)?.status;
    if (persistedStatus === 'cancelled') {
      return { runId, status: 'cancelled' };
    }

    db.prepare(`
      UPDATE backup_runs SET status = 'failed', completed_at = datetime('now'),
        error_message = ?, duration_seconds = ?
      WHERE id = ?
    `).run(err.message, duration, runId);

    if (shouldNotify(job, 'failure')) {
      await notifyBackupResult('Hyper Backup', job.name, 'failed', { duration });
    }
    throw err;
  } finally {
    notifications.close();
    activeRuns.delete(runId);
  }
}

// Test connection to a remote peer
export async function testPeerConnection(remoteUrl, apiKey) {
  try {
    const result = await callPeerApi(remoteUrl, apiKey, 'GET', '/peer/health');
    return { reachable: true, ...result };
  } catch (err) {
    return { reachable: false, error: err.message };
  }
}

// Browse directories on a remote peer
export async function browsePeerDirectory(remoteUrl, apiKey, dir) {
  const query = dir ? `?dir=${encodeURIComponent(dir)}` : '';
  return callPeerApi(remoteUrl, apiKey, 'GET', `/peer/browse${query}`);
}

// Get filesystem roots on a remote peer
export async function getPeerRoots(remoteUrl, apiKey) {
  return callPeerApi(remoteUrl, apiKey, 'GET', '/peer/roots');
}

// Get Unraid shares on a remote peer
export async function getPeerShares(remoteUrl, apiKey) {
  return callPeerApi(remoteUrl, apiKey, 'GET', '/peer/shares');
}

// Notify all known Hyper Backup peers that this instance is shutting down.
// Best-effort: failures are logged but don't block shutdown.
export async function notifyPeersOfShutdown() {
  // Resolve each job's peer live — a re-paired peer has a new key and address
  const jobs = db.prepare(`
    SELECT id, remote_url, peer_static_pubkey, remote_api_key_encrypted FROM hyper_backup_jobs
  `).all();
  if (jobs.length === 0) return;

  const notified = new Set();
  const promises = [];

  for (const job of jobs) {
    let binding;
    try {
      binding = resolvePeerBinding(db, job);
    } catch {
      continue; // Nothing to notify — the job has no usable destination
    }

    // Deduplicate by resolved address (multiple jobs may target the same peer)
    if (notified.has(binding.remoteUrl)) continue;
    notified.add(binding.remoteUrl);

    promises.push(
      callPeerApi(binding.remoteUrl, decryptPeerApiKey(binding.apiKeyEncrypted), 'POST', '/peer/shutdown', {
        reason: 'graceful shutdown',
      }).then(() => {
        console.log(`[shutdown] Notified peer at ${binding.remoteUrl}`);
      }).catch((err) => {
        console.warn(`[shutdown] Could not notify peer at ${binding.remoteUrl}: ${err.message}`);
      })
    );
  }

  // Wait for all notifications with a 5-second timeout so shutdown isn't blocked
  await Promise.race([
    Promise.allSettled(promises),
    new Promise(resolve => { setTimeout(resolve, 5000); }),
  ]);
}

// Helper to call the peer API
async function callPeerApi(baseUrl, apiKey, method, path, body = null) {
  baseUrl = validatePrivatePeerBaseUrl(baseUrl);
  const url = `${baseUrl}${path}`;
  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  const options = { method, headers, signal: AbortSignal.timeout(15000) };
  if (body) options.body = JSON.stringify(body);

  let response;
  try {
    response = await fetchWithoutRedirect(url, options);
  } catch (err) {
    // Network-level errors → friendly messages
    const code = err.cause?.code || '';
    const msg = err.message || '';
    if (code === 'ECONNREFUSED' || msg.includes('ECONNREFUSED')) {
      throw new Error(`Remote peer is unreachable at ${baseUrl} — connection refused. Is the peer instance running?`);
    }
    if (code === 'ECONNRESET' || msg.includes('ECONNRESET')) {
      throw new Error(`Connection to remote peer at ${baseUrl} was reset. The peer may have shut down.`);
    }
    if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || msg.includes('ETIMEDOUT')) {
      throw new Error(`Connection to remote peer at ${baseUrl} timed out. Check network connectivity.`);
    }
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || msg.includes('ENOTFOUND')) {
      throw new Error(`Could not resolve hostname for ${baseUrl}. Check the remote URL.`);
    }
    if (code === 'EHOSTUNREACH' || msg.includes('EHOSTUNREACH')) {
      throw new Error(`Remote host at ${baseUrl} is unreachable. Check network connectivity.`);
    }
    throw new Error(`Failed to connect to remote peer at ${baseUrl}: ${code || msg}`);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`Remote peer at ${baseUrl} returned an invalid response (HTTP ${response.status})`);
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Authentication failed — the API key was rejected by the remote peer at ${baseUrl}`);
    }
    throw new Error(data.error || `Remote peer returned HTTP ${response.status}`);
  }

  return data;
}

// Build a user-friendly error message from rsync result
function buildRsyncErrorMessage(result) {
  const { exitCode, stderr, stdout } = result;

  // Try stderr first (Linux / non-PTY)
  if (stderr && stderr.trim()) {
    return stderr.trim();
  }

  // On macOS, script -q merges stderr into stdout — extract error lines
  const errorLines = (stdout || '').split('\n').filter(l => {
    const t = l.trim();
    return t.startsWith('rsync:') || t.startsWith('rsync error:') ||
           t.startsWith('ssh:') || t.startsWith('ssh_exchange_identification:') ||
           t.includes('Connection refused') || t.includes('Connection reset') ||
           t.includes('Connection timed out') || t.includes('Connection closed') ||
           t.includes('Permission denied') || t.includes('No such file or directory') ||
           t.includes('Host key verification failed') ||
           t.includes('No route to host');
  }).map(l => l.trim());

  if (errorLines.length > 0) {
    // Deduplicate and take first few meaningful lines
    const unique = [...new Set(errorLines)].slice(0, 3);
    return unique.join('\n');
  }

  // Fall back to exit code description
  const description = RSYNC_EXIT_MESSAGES[exitCode];
  if (description) {
    // Add extra context for common codes
    if (exitCode === 255) return 'SSH connection failed — verify the remote host is reachable, SSH is enabled, and the credentials are correct';
    if (exitCode === 23) return 'Partial transfer due to error — some files could not be read or written. Check file permissions and disk space.';
    if (exitCode === 30) return 'Transfer timed out — the remote host stopped responding during the transfer';
    if (exitCode === 12) return 'Protocol error in data stream — possible network interruption during transfer';
    if (exitCode === 20) return 'Transfer was interrupted by a signal (the remote host may have shut down)';
    return description;
  }

  return `rsync exited with code ${exitCode}`;
}

// Hyper Backup service — cross-site backup orchestrator
// Uses API-to-API for the control plane, rsync over SSH for data transfer

import os from 'os';
import db from '../db.js';
import { runRsyncWithSsh, parseItemizeAction } from './rsync.js';
import { notifyBackupResult } from './notify.js';

const IS_MAC = os.platform() === 'darwin';
const activeRuns = new Map();

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

export async function executeHyperBackup(jobId, existingRunId = null) {
  const job = db.prepare('SELECT * FROM hyper_backup_jobs WHERE id = ?').get(jobId);
  if (!job) throw new Error(`Hyper Backup job ${jobId} not found`);

  let runId = existingRunId;
  if (runId) {
    db.prepare(`UPDATE backup_runs SET status = 'running' WHERE id = ?`).run(runId);
  } else {
    const run = db.prepare(`
      INSERT INTO backup_runs (feature, config_id, status) VALUES ('hyper-backup', ?, 'running')
    `).run(jobId);
    runId = Number(run.lastInsertRowid);
  }

  const startTime = Date.now();
  activeRuns.set(runId, { status: 'preparing', progress: null, startedAt: startTime });

  try {
    // Step 1: Call remote peer API to prepare
    const prepareResult = await callPeerApi(job.remote_url, job.remote_api_key, 'POST', '/peer/backup/prepare', {
      direction: job.direction,
      remotePath: job.remote_path,
      runId,
    });

    if (!prepareResult.ok) {
      throw new Error(`Remote prepare failed: ${prepareResult.error || 'Unknown error'}`);
    }

    // Step 2: Execute rsync over SSH
    activeRuns.set(runId, { status: 'transferring', progress: null, startedAt: startTime });
    const sshHost = job.ssh_host || new URL(job.remote_url).hostname;
    const sshUser = job.ssh_user || 'root';
    const sshPort = job.ssh_port || 22;

    const args = [
      '-avz', '--delete',
      '--itemize-changes', '--stats',
      // Resume partial transfers on interruption (critical for multi-TB datasets)
      '--partial',
      '--partial-dir=.rsync-partial',
      // Abort if no data transferred for 5 minutes (protects against hangs)
      '--timeout=300',
      IS_MAC ? '--progress' : '--info=progress2',
      '--out-format=%i %l %n',
      // SSH with keepalive to prevent silent connection drops on long transfers
      '-e', `ssh -p ${sshPort} -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=60 -o ServerAliveCountMax=3 -o TCPKeepAlive=yes`,
    ];

    if (job.direction === 'push') {
      const source = job.local_path.endsWith('/') ? job.local_path : job.local_path + '/';
      args.push(source, `${sshUser}@${sshHost}:${job.remote_path}/`);
    } else {
      args.push(`${sshUser}@${sshHost}:${job.remote_path}/`, job.local_path + '/');
    }

    const result = await runRsyncWithSsh(args, (rsyncProgress) => {
      activeRuns.set(runId, {
        status: 'transferring', startedAt: startTime,
        ...rsyncProgress,
      });
    });
    activeRuns.set(runId, { status: 'completing', startedAt: startTime, ...result.progress });

    // Step 3: Notify remote peer that transfer is complete
    await callPeerApi(job.remote_url, job.remote_api_key, 'POST', '/peer/backup/complete', {
      runId,
      status: result.exitCode === 0 ? 'completed' : 'failed',
      stats: result.progress,
    });

    // Store file details (batched in a single transaction for performance)
    const insertFile = db.prepare(`
      INSERT INTO backup_run_files (run_id, file_path, action, size) VALUES (?, ?, ?, ?)
    `);
    const insertAllFiles = db.transaction((entries) => {
      for (const e of entries) insertFile.run(e.runId, e.path, e.action, e.size);
    });
    const fileEntries = [];
    const lines = (result.stdout || '').split('\n');
    for (const line of lines) {
      const match = line.match(/^([<>.ch*][fdLDS][cstpoguax.+?]{7,9})\s+(\d+)\s+(.+)$/);
      if (match) {
        const action = parseItemizeAction(match[1]);
        fileEntries.push({ runId, path: match[3], action, size: parseInt(match[2]) || 0 });
        continue;
      }
      // Handle *deleting lines
      const delMatch = line.match(/^\*deleting\s+(.+)$/);
      if (delMatch) {
        fileEntries.push({ runId, path: delMatch[1], action: 'deleted', size: 0 });
      }
    }
    if (fileEntries.length > 0) insertAllFiles(fileEntries);

    // Update run record
    const duration = (Date.now() - startTime) / 1000;
    const status = result.exitCode === 0 ? 'completed' : 'failed';
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
      result.exitCode !== 0 ? buildRsyncErrorMessage(result) : null,
      runId,
    );

    // Notification
    if (job.notify_on_success && status === 'completed') {
      await notifyBackupResult('Hyper Backup', job.name, 'completed', {
        filesCopied: result.progress.filesCopied, filesFailed: result.progress.filesFailed,
        bytesTransferred: result.progress.bytesTransferred, duration,
      });
    } else if (job.notify_on_failure && status === 'failed') {
      await notifyBackupResult('Hyper Backup', job.name, 'failed', {
        filesCopied: result.progress.filesCopied, bytesTransferred: result.progress.bytesTransferred, duration,
      });
    }

    return { runId, status };
  } catch (err) {
    const duration = (Date.now() - startTime) / 1000;
    db.prepare(`
      UPDATE backup_runs SET status = 'failed', completed_at = datetime('now'),
        error_message = ?, duration_seconds = ?
      WHERE id = ?
    `).run(err.message, duration, runId);

    if (job.notify_on_failure) {
      await notifyBackupResult('Hyper Backup', job.name, 'failed', { duration });
    }
    throw err;
  } finally {
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

// Notify all known Hyper Backup peers that this instance is shutting down.
// Best-effort: failures are logged but don't block shutdown.
export async function notifyPeersOfShutdown() {
  // Get unique peer URLs + keys from hyper backup jobs
  const jobs = db.prepare('SELECT DISTINCT remote_url, remote_api_key FROM hyper_backup_jobs').all();
  if (jobs.length === 0) return;

  const notified = new Set();
  const promises = [];

  for (const job of jobs) {
    // Deduplicate by remote_url (multiple jobs may target the same peer)
    if (notified.has(job.remote_url)) continue;
    notified.add(job.remote_url);

    promises.push(
      callPeerApi(job.remote_url, job.remote_api_key, 'POST', '/peer/shutdown', {
        reason: 'graceful shutdown',
      }).then(() => {
        console.log(`[shutdown] Notified peer at ${job.remote_url}`);
      }).catch((err) => {
        console.warn(`[shutdown] Could not notify peer at ${job.remote_url}: ${err.message}`);
      })
    );
  }

  // Wait for all notifications with a 5-second timeout so shutdown isn't blocked
  await Promise.race([
    Promise.allSettled(promises),
    new Promise(resolve => setTimeout(resolve, 5000)),
  ]);
}

// Helper to call the peer API
async function callPeerApi(baseUrl, apiKey, method, path, body = null) {
  const url = `${baseUrl}${path}`;
  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);

  let response;
  try {
    response = await fetch(url, options);
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

// Hyper Backup service — cross-site backup orchestrator
// Uses API-to-API for the control plane, rsync over SSH for data transfer

import os from 'os';
import db from '../db.js';
import { runRsyncWithSsh, parseItemizeAction } from './rsync.js';
import { notifyBackupResult } from './notify.js';

const IS_MAC = os.platform() === 'darwin';
const activeRuns = new Map();

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
      '-av', '--delete',
      '--itemize-changes', '--stats',
      IS_MAC ? '--progress' : '--info=progress2',
      '--out-format=%i %l %n',
      '-e', `ssh -p ${sshPort} -o StrictHostKeyChecking=accept-new`,
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

    // Store file details
    const insertFile = db.prepare(`
      INSERT INTO backup_run_files (run_id, file_path, action, size) VALUES (?, ?, ?, ?)
    `);
    const lines = (result.stdout || '').split('\n');
    for (const line of lines) {
      const match = line.match(/^([<>.ch*][fdLDS][cstpoguax.+?]{7,9})\s+(\d+)\s+(.+)$/);
      if (match) {
        const action = parseItemizeAction(match[1]);
        insertFile.run(runId, match[3], action, parseInt(match[2]) || 0);
        continue;
      }
      // Handle *deleting lines
      const delMatch = line.match(/^\*deleting\s+(.+)$/);
      if (delMatch) {
        insertFile.run(runId, delMatch[1], 'deleted', 0);
      }
    }

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
      result.exitCode !== 0 ? result.stderr : null,
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

// Helper to call the peer API
async function callPeerApi(baseUrl, apiKey, method, path, body = null) {
  const url = `${baseUrl}${path}`;
  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);

  const response = await fetch(url, options);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || `Peer API returned ${response.status}`);
  }

  return data;
}

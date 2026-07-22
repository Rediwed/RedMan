import db from '../db.js';
import { verifyDeltaChain } from './deltaVersion.js';
import { claimBackupRun } from './runClaim.js';
import { notifyJobCancelled, shouldNotify } from './notify.js';

const activeVerifications = new Map();

export function getActiveVersionVerification(runId) {
  return activeVerifications.get(Number(runId))?.progress || null;
}

export function startVersionVerification(configId) {
  const config = db.prepare('SELECT * FROM ssd_backup_configs WHERE id = ?').get(configId);
  if (!config) throw new Error('Config not found');

  const claim = claimBackupRun(db, 'version-verify', configId);
  if (!claim.claimed) return { runId: claim.runId, status: 'running', existing: true };

  const controller = new AbortController();
  const state = {
    controller,
    progress: { status: 'running', total: 0, verified: 0, broken: 0, current: null },
    promise: null,
  };
  state.promise = verifyDeltaChain(configId, {
    signal: controller.signal,
    onProgress(progress) {
      state.progress = { status: 'running', ...progress };
    },
  }).then(result => {
    const status = result.broken > 0 ? 'partial' : 'completed';
    db.prepare(`
      UPDATE backup_runs SET status = ?, completed_at = datetime('now'),
        files_total = ?, files_copied = ?, files_failed = ?, error_message = ?
      WHERE id = ?
    `).run(
      status,
      result.total,
      result.verified,
      result.broken,
      result.broken > 0 ? JSON.stringify(result.errors) : null,
      claim.runId,
    );
    state.progress = { status, ...result };
  }).catch(err => {
    const cancelled = controller.signal.aborted || err.message === 'Verification cancelled';
    const status = cancelled ? 'cancelled' : 'failed';
    db.prepare(`
      UPDATE backup_runs SET status = ?, completed_at = datetime('now'), error_message = ? WHERE id = ?
    `).run(status, cancelled ? 'Cancelled by user' : err.message, claim.runId);
    if (cancelled && shouldNotify(config, 'cancel')) {
      notifyJobCancelled('Version Verification', config.name);
    }
    state.progress = { ...state.progress, status, error: err.message };
  }).finally(() => {
    setTimeout(() => activeVerifications.delete(claim.runId), 5 * 60 * 1000).unref?.();
  });

  activeVerifications.set(claim.runId, state);
  return { runId: claim.runId, status: 'running', existing: false };
}

export function cancelVersionVerification(runId) {
  const state = activeVerifications.get(Number(runId));
  if (!state || state.progress.status !== 'running') return false;
  state.controller.abort();
  return true;
}

export async function stopActiveVersionVerifications() {
  const states = [...activeVerifications.values()].filter(state => state.progress.status === 'running');
  for (const state of states) state.controller.abort();
  await Promise.allSettled(states.map(state => state.promise));
  activeVerifications.clear();
  return { stopped: states.length, forced: 0 };
}
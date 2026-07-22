export function failRunningHyperRunsForPeer(db, staticPublicKey, peerName) {
  if (!staticPublicKey) return 0;

  return db.prepare(`
    UPDATE backup_runs
    SET status = 'failed', completed_at = datetime('now'),
      error_message = 'Remote peer "' || ? || '" is shutting down'
    WHERE feature = 'hyper-backup' AND status = 'running'
      AND config_id IN (
        SELECT id FROM hyper_backup_jobs WHERE peer_static_pubkey = ?
      )
  `).run(peerName, staticPublicKey).changes;
}

export function getPeerOwnedHyperRun(db, runId, staticPublicKey) {
  if (!staticPublicKey) return null;

  return db.prepare(`
    SELECT * FROM backup_runs
    WHERE id = ? AND feature = 'hyper-backup' AND peer_static_pubkey = ?
  `).get(runId, staticPublicKey) || null;
}
export function claimBackupRun(db, feature, configId, peerStaticPublicKey = null) {
  const claim = db.transaction(() => {
    const active = db.prepare(`
      SELECT id FROM backup_runs
      WHERE feature = ? AND config_id = ? AND status IN ('running', 'cancelling')
      ORDER BY id DESC LIMIT 1
    `).get(feature, Number(configId));

    if (active) return { claimed: false, runId: active.id };

    const result = db.prepare(`
      INSERT INTO backup_runs (feature, config_id, status, peer_static_pubkey)
      VALUES (?, ?, 'running', ?)
    `).run(feature, Number(configId), peerStaticPublicKey);

    return { claimed: true, runId: Number(result.lastInsertRowid) };
  });

  return claim.immediate();
}
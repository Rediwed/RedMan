// Authorized Peers routes — manage per-peer API keys for Hyper Backup

import { Router } from 'express';
import { randomBytes } from 'crypto';
import db from '../db.js';
import {
  initiatePairing, getOutgoingPairingStatus,
  getPendingIncoming, getAllPairingRequests,
  acceptPairing, declinePairing,
} from '../services/pairing.js';
import { validatePairingAccess } from '../services/peerAccessPolicy.js';
import { validatePrivatePeerBaseUrl } from '../services/peerUrlPolicy.js';
import { fetchWithoutRedirect } from '../services/httpPolicy.js';
import {
  decryptPeerApiKey,
  hashPeerApiKey,
  hashedPeerKeyMarker,
} from '../services/peerSecrets.js';
import { reconcilePeerSshAuthorization } from '../services/peerSshAuthorization.js';
const router = Router();

function generateApiKey() {
  return randomBytes(32).toString('hex');
}

function maskApiKey(key) {
  if (!key || key.length < 12) return '••••••••';
  return '••••••••' + key.slice(-8);
}

// List all peers — both incoming (authorized to push here) and outgoing (we push to them)
router.get('/', (req, res) => {
  // Incoming: peers authorized to back up to this instance
  const incoming = db.prepare('SELECT * FROM authorized_peers ORDER BY created_at DESC').all();
  const safeIncoming = incoming.map(p => ({
    ...p,
    api_key: '••••••••',
    api_key_hash: undefined,
    role: 'incoming',
    ssh_authorization: p.ssh_public_key ? 'managed' : 'external',
  }));

  // Outgoing: peers we've paired with and push backups to (deduplicated by
  // static identity where known, latest accepted pairing wins)
  const outgoing = db.prepare(`
    SELECT p1.id, p1.remote_instance as name, p1.remote_url, p1.status,
           p1.remote_storage_limit, p1.remote_allowed_path,
           p1.handshake_version, p1.remote_fingerprint, p1.remote_static_pubkey,
           p1.created_at, p1.updated_at
    FROM pairing_requests p1
    INNER JOIN (
      SELECT COALESCE(remote_static_pubkey, remote_url) AS peer_key, MAX(id) as max_id
      FROM pairing_requests
      WHERE direction = 'outgoing' AND status = 'accepted'
      GROUP BY COALESCE(remote_static_pubkey, remote_url)
    ) p2 ON p1.id = p2.max_id
    ORDER BY p1.created_at DESC
  `).all().map(p => ({ ...p, role: 'outgoing' }));

  res.json({ incoming: safeIncoming, outgoing });
});

// ── Pairing ──────────────────────────────────────────────────────

// Initiate pairing with a discovered peer
router.post('/pair', async (req, res) => {
  const { remote_url } = req.body;
  if (!remote_url) return res.status(400).json({ error: 'remote_url is required' });
  try {
    const result = await initiatePairing(remote_url);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get pending incoming pairing requests (for notification badge + accept/decline UI)
router.get('/pair/incoming', (req, res) => {
  res.json(getPendingIncoming());
});

// Get all pairing requests (history)
router.get('/pair/history', (req, res) => {
  res.json(getAllPairingRequests());
});

// Get status of an outgoing pairing request (frontend polls this)
router.get('/pair/status/:id', (req, res) => {
  const status = getOutgoingPairingStatus(parseInt(req.params.id));
  if (!status) return res.status(404).json({ error: 'Not found' });
  res.json(status);
});

// Accept an incoming pairing request
router.post('/pair/:id/accept', async (req, res) => {
  try {
    const access = validatePairingAccess(req.body.allowed_path_prefix, req.body.storage_limit_bytes);
    const result = await acceptPairing(
      parseInt(req.params.id),
      access,
      req.body.confirmed_fingerprint,
    );
    if (result.error) return res.status(400).json(result);
    res.json(result);
  } catch (err) {
    console.error('[peers] acceptPairing threw:', err);
    res.status(500).json({ error: err.message || 'Accept failed' });
  }
});

// Decline an incoming pairing request
router.post('/pair/:id/decline', (req, res) => {
  const result = declinePairing(parseInt(req.params.id));
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// Remove an outgoing pairing (unpair from a destination)
router.delete('/pair/:id', (req, res) => {
  const req_ = db.prepare('SELECT * FROM pairing_requests WHERE id = ?').get(parseInt(req.params.id));
  if (!req_) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM pairing_requests WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Sync outgoing peer quotas from remotes (queries each destination's /peer/storage)
router.post('/pair/sync', async (req, res) => {
  const outgoing = db.prepare(`
    SELECT id, remote_url, api_key_encrypted FROM pairing_requests
    WHERE direction = 'outgoing' AND status = 'accepted' AND api_key_encrypted IS NOT NULL
  `).all();

  const results = [];
  for (const p of outgoing) {
    try {
      const remoteBase = validatePrivatePeerBaseUrl(p.remote_url);
      const apiKey = decryptPeerApiKey(p.api_key_encrypted);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const r = await fetchWithoutRedirect(`${remoteBase}/peer/storage`, {
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (r.ok) {
        const data = await r.json();
        db.prepare(`
          UPDATE pairing_requests SET
            remote_storage_limit = ?, remote_allowed_path = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(data.limitBytes || 0, data.prefix || '/', p.id);
        results.push({ id: p.id, synced: true, limitBytes: data.limitBytes, prefix: data.prefix });
      } else {
        results.push({ id: p.id, synced: false, error: `HTTP ${r.status}` });
      }
    } catch (err) {
      results.push({ id: p.id, synced: false, error: err.message });
    }
  }
  res.json(results);
});

// Check connectivity to outgoing (destination) peers we push backups to
router.get('/connectivity', async (req, res) => {
  // Outgoing peers: deduplicated by static identity where known, latest accepted pairing wins
  const peers = db.prepare(`
    SELECT p1.id, p1.remote_instance as name, p1.remote_url, p1.updated_at,
           p1.handshake_version, p1.remote_fingerprint, p1.remote_static_pubkey
    FROM pairing_requests p1
    INNER JOIN (
      SELECT COALESCE(remote_static_pubkey, remote_url) AS peer_key, MAX(id) as max_id
      FROM pairing_requests
      WHERE direction = 'outgoing' AND status = 'accepted'
      GROUP BY COALESCE(remote_static_pubkey, remote_url)
    ) p2 ON p1.id = p2.max_id
    ORDER BY p1.created_at DESC
  `).all();

  const results = await Promise.all(peers.map(async (peer) => {
    // Extract host from remote_url to build the discover endpoint
    let discoverUrl;
    try {
      discoverUrl = `${validatePrivatePeerBaseUrl(peer.remote_url)}/peer/discover`;
    } catch {
      return { id: peer.id, name: peer.name, url: peer.remote_url, status: 'unknown', last_seen_at: peer.updated_at };
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const r = await fetchWithoutRedirect(discoverUrl, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' },
      });
      clearTimeout(timer);
      if (!r.ok) {
        return { id: peer.id, name: peer.name, url: peer.remote_url, status: 'unreachable', last_seen_at: peer.updated_at };
      }
      const data = await r.json();
      if (data.service === 'redman') {
        return {
          id: peer.id, name: peer.name, url: peer.remote_url, status: 'online',
          instance: data.instance, version: data.version, hostname: data.hostname,
          handshake_version: peer.handshake_version || 1,
          fingerprint: peer.remote_fingerprint || null,
          last_seen_at: peer.updated_at,
        };
      }
      return { id: peer.id, name: peer.name, url: peer.remote_url, status: 'unreachable', last_seen_at: peer.updated_at };
    } catch {
      return { id: peer.id, name: peer.name, url: peer.remote_url, status: 'unreachable', last_seen_at: peer.updated_at };
    }
  }));

  res.json(results);
});

// Get a single peer (key masked)
router.get('/:id', (req, res) => {
  const peer = db.prepare('SELECT * FROM authorized_peers WHERE id = ?').get(req.params.id);
  if (!peer) return res.status(404).json({ error: 'Peer not found' });
  peer.api_key = '••••••••';
  delete peer.api_key_hash;
  res.json(peer);
});

// Create a new peer — returns the full API key ONCE
router.post('/', (req, res) => {
  const { name, allowed_path_prefix, storage_limit_bytes } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }

  let access;
  try {
    access = validatePairingAccess(allowed_path_prefix, storage_limit_bytes);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const apiKey = generateApiKey();
  const apiKeyHash = hashPeerApiKey(apiKey);
  const result = db.prepare(`
    INSERT INTO authorized_peers (name, api_key, api_key_hash, allowed_path_prefix, storage_limit_bytes)
    VALUES (?, ?, ?, ?, ?)
  `).run(name.trim(), hashedPeerKeyMarker(apiKeyHash), apiKeyHash,
    access.allowedPathPrefix, access.storageLimitBytes);

  const peer = db.prepare('SELECT * FROM authorized_peers WHERE id = ?').get(result.lastInsertRowid);

  // Return full key only on creation
  res.status(201).json({
    ...peer,
    api_key: apiKey,
    _key_warning: 'This API key will not be shown again. Copy it now.',
    _ssh_warning: 'SSH authorization is externally managed for manual peers; paired peers are managed automatically.',
  });
});

// Update a peer (name, allowed_path_prefix, enabled)
router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM authorized_peers WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Peer not found' });

  const { name, allowed_path_prefix, enabled, storage_limit_bytes } = req.body;
  const targetEnabled = enabled !== undefined ? Boolean(enabled) : Boolean(existing.enabled);
  let access = {
    allowedPathPrefix: existing.allowed_path_prefix,
    storageLimitBytes: existing.storage_limit_bytes,
  };
  if (targetEnabled || allowed_path_prefix !== undefined || storage_limit_bytes !== undefined) {
    try {
      access = validatePairingAccess(
        allowed_path_prefix ?? existing.allowed_path_prefix,
        storage_limit_bytes ?? existing.storage_limit_bytes,
      );
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }

  try {
    reconcilePeerSshAuthorization(existing, {
      enabled: targetEnabled,
      allowedPathPrefix: access.allowedPathPrefix,
      sourceIp: existing.last_seen_ip,
    });
  } catch (err) {
    return res.status(503).json({ error: `Could not update peer SSH authorization: ${err.message}` });
  }

  db.prepare(`
    UPDATE authorized_peers SET
      name = ?, allowed_path_prefix = ?, enabled = ?, storage_limit_bytes = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    name?.trim() || existing.name,
    access.allowedPathPrefix,
    targetEnabled ? 1 : 0,
    access.storageLimitBytes,
    req.params.id,
  );

  const updated = db.prepare('SELECT * FROM authorized_peers WHERE id = ?').get(req.params.id);
  updated.api_key = '••••••••';
  delete updated.api_key_hash;
  res.json(updated);
});

// Delete a peer
router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM authorized_peers WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Peer not found' });

  try {
    reconcilePeerSshAuthorization(existing, { enabled: false });
  } catch (err) {
    return res.status(503).json({ error: `Could not revoke peer SSH authorization: ${err.message}` });
  }

  const del = db.transaction(() => {
    db.prepare('UPDATE pairing_requests SET peer_id = NULL WHERE peer_id = ?').run(req.params.id);
    db.prepare('DELETE FROM peer_audit_log WHERE peer_id = ?').run(req.params.id);
    db.prepare('DELETE FROM authorized_peers WHERE id = ?').run(req.params.id);
  });
  del();
  res.json({ success: true });
});

// Regenerate API key — returns the new key ONCE
router.post('/:id/regenerate-key', (req, res) => {
  const existing = db.prepare('SELECT * FROM authorized_peers WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Peer not found' });

  const newKey = generateApiKey();
  const newHash = hashPeerApiKey(newKey);
  db.prepare('UPDATE authorized_peers SET api_key = ?, api_key_hash = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(hashedPeerKeyMarker(newHash), newHash, req.params.id);

  res.json({
    id: existing.id,
    name: existing.name,
    api_key: newKey,
    _key_warning: 'This API key will not be shown again. Copy it now.',
  });
});

// Get audit log for a specific peer
router.get('/:id/audit-log', (req, res) => {
  const existing = db.prepare('SELECT * FROM authorized_peers WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Peer not found' });

  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
  const offset = (page - 1) * limit;

  const total = db.prepare('SELECT COUNT(*) as total FROM peer_audit_log WHERE peer_id = ?').get(req.params.id).total;
  const entries = db.prepare(
    'SELECT * FROM peer_audit_log WHERE peer_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(req.params.id, limit, offset);

  res.json({ entries, page, limit, total, totalPages: Math.ceil(total / limit) });
});

// Get full audit log (all peers, including unauthenticated failures)
router.get('/audit-log/all', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
  const offset = (page - 1) * limit;

  const total = db.prepare('SELECT COUNT(*) as total FROM peer_audit_log').get().total;
  const entries = db.prepare(
    'SELECT * FROM peer_audit_log ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(limit, offset);

  res.json({ entries, page, limit, total, totalPages: Math.ceil(total / limit) });
});

export default router;

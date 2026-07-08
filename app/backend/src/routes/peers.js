// Authorized Peers routes — manage per-peer API keys for Hyper Backup

import { Router } from 'express';
import { randomBytes } from 'crypto';
import db from '../db.js';
import { normalizePath } from '../middleware/validation.js';
import {
  initiatePairing, getOutgoingPairingStatus,
  getPendingIncoming, getAllPairingRequests,
  acceptPairing, declinePairing,
} from '../services/pairing.js';
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
  const safeIncoming = incoming.map(p => ({ ...p, api_key: maskApiKey(p.api_key), role: 'incoming' }));

  // Outgoing: peers we've paired with and push backups to (deduplicated by remote_url, latest wins)
  const outgoing = db.prepare(`
    SELECT p1.id, p1.remote_instance as name, p1.remote_url, p1.status,
           p1.remote_storage_limit, p1.remote_allowed_path,
           p1.handshake_version, p1.remote_fingerprint,
           p1.created_at, p1.updated_at
    FROM pairing_requests p1
    INNER JOIN (
      SELECT remote_url, MAX(id) as max_id
      FROM pairing_requests
      WHERE direction = 'outgoing' AND status = 'accepted'
      GROUP BY remote_url
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
    const result = await acceptPairing(parseInt(req.params.id));
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
    SELECT id, remote_url, api_key FROM pairing_requests
    WHERE direction = 'outgoing' AND status = 'accepted' AND api_key IS NOT NULL
  `).all();

  const results = [];
  for (const p of outgoing) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const r = await fetch(`${p.remote_url}/peer/storage`, {
        headers: { 'Authorization': `Bearer ${p.api_key}`, 'Accept': 'application/json' },
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
  // Outgoing peers: deduplicated by remote_url, latest accepted pairing wins
  const peers = db.prepare(`
    SELECT p1.id, p1.remote_instance as name, p1.remote_url, p1.updated_at,
           p1.handshake_version, p1.remote_fingerprint
    FROM pairing_requests p1
    INNER JOIN (
      SELECT remote_url, MAX(id) as max_id
      FROM pairing_requests
      WHERE direction = 'outgoing' AND status = 'accepted'
      GROUP BY remote_url
    ) p2 ON p1.id = p2.max_id
    ORDER BY p1.created_at DESC
  `).all();

  const results = await Promise.all(peers.map(async (peer) => {
    // Extract host from remote_url to build the discover endpoint
    let discoverUrl;
    try {
      const url = new URL(peer.remote_url);
      discoverUrl = `${url.protocol}//${url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '8091')}/peer/discover`;
    } catch {
      return { id: peer.id, name: peer.name, url: peer.remote_url, status: 'unknown', last_seen_at: peer.updated_at };
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const r = await fetch(discoverUrl, {
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
  peer.api_key = maskApiKey(peer.api_key);
  res.json(peer);
});

// Create a new peer — returns the full API key ONCE
router.post('/', (req, res) => {
  const { name, allowed_path_prefix, storage_limit_bytes } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }

  const prefix = normalizePath(allowed_path_prefix || '/');
  if (!prefix) {
    return res.status(400).json({ error: 'allowed_path_prefix must be a valid absolute path' });
  }

  const limitBytes = Math.max(0, parseInt(storage_limit_bytes) || 0);

  const apiKey = generateApiKey();
  const result = db.prepare(`
    INSERT INTO authorized_peers (name, api_key, allowed_path_prefix, storage_limit_bytes)
    VALUES (?, ?, ?, ?)
  `).run(name.trim(), apiKey, prefix, limitBytes);

  const peer = db.prepare('SELECT * FROM authorized_peers WHERE id = ?').get(result.lastInsertRowid);

  // Return full key only on creation
  res.status(201).json({
    ...peer,
    api_key: apiKey,
    _key_warning: 'This API key will not be shown again. Copy it now.',
  });
});

// Update a peer (name, allowed_path_prefix, enabled)
router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM authorized_peers WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Peer not found' });

  const { name, allowed_path_prefix, enabled, storage_limit_bytes } = req.body;

  const prefix = allowed_path_prefix !== undefined
    ? normalizePath(allowed_path_prefix)
    : existing.allowed_path_prefix;

  if (allowed_path_prefix !== undefined && !prefix) {
    return res.status(400).json({ error: 'allowed_path_prefix must be a valid absolute path' });
  }

  const limitBytes = storage_limit_bytes !== undefined
    ? Math.max(0, parseInt(storage_limit_bytes) || 0)
    : existing.storage_limit_bytes;

  db.prepare(`
    UPDATE authorized_peers SET
      name = ?, allowed_path_prefix = ?, enabled = ?, storage_limit_bytes = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    name?.trim() || existing.name,
    prefix,
    enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled,
    limitBytes,
    req.params.id,
  );

  const updated = db.prepare('SELECT * FROM authorized_peers WHERE id = ?').get(req.params.id);
  updated.api_key = maskApiKey(updated.api_key);
  res.json(updated);
});

// Delete a peer
router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM authorized_peers WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Peer not found' });

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
  db.prepare('UPDATE authorized_peers SET api_key = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(newKey, req.params.id);

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

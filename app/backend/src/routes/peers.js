// Authorized Peers routes — manage per-peer API keys for Hyper Backup

import { Router } from 'express';
import { randomBytes } from 'crypto';
import db from '../db.js';
import { normalizePath } from '../middleware/validation.js';
const router = Router();

function generateApiKey() {
  return randomBytes(32).toString('hex');
}

function maskApiKey(key) {
  if (!key || key.length < 12) return '••••••••';
  return '••••••••' + key.slice(-8);
}

// List all authorized peers (keys masked)
router.get('/', (req, res) => {
  const peers = db.prepare('SELECT * FROM authorized_peers ORDER BY created_at DESC').all();
  const safe = peers.map(p => ({ ...p, api_key: maskApiKey(p.api_key) }));
  res.json(safe);
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

  db.prepare('DELETE FROM authorized_peers WHERE id = ?').run(req.params.id);
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

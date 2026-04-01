// Settings routes — key-value store for app configuration

import { Router } from 'express';
import db from '../db.js';
import {
  sendTestNtfy, sendTestBrowser,
  addBrowserSubscriber, removeBrowserSubscriber,
} from '../services/notify.js';
import { getSshStatus, generateKey, authorizeLocalhost, testSshConnection } from '../services/sshManager.js';

const router = Router();

const SENSITIVE_KEYS = ['ntfy_token', 'ntfy_auth_token', 'ntfy_password', 'peer_api_key', 'immich_api_key'];

// Get all settings
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  for (const row of rows) {
    if (SENSITIVE_KEYS.includes(row.key)) {
      settings[row.key] = row.value ? '••••••••' : '';
    } else {
      settings[row.key] = row.value;
    }
  }
  res.json(settings);
});

// Update one or more settings
router.put('/', (req, res) => {
  const updates = req.body;
  if (!updates || typeof updates !== 'object') {
    return res.status(400).json({ error: 'Request body must be an object of key-value pairs' });
  }

  const upsert = db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);

  const updateAll = db.transaction(() => {
    for (const [key, value] of Object.entries(updates)) {
      // Don't overwrite sensitive values with masked placeholders
      if (SENSITIVE_KEYS.includes(key) && value === '••••••••') continue;
      upsert.run(key, String(value));
    }
  });

  updateAll();
  res.json({ success: true });
});

// Test ntfy notification
router.post('/ntfy-test', async (req, res) => {
  try {
    const ok = await sendTestNtfy();
    res.json({ success: ok, error: ok ? null : 'Failed to send — check server URL and credentials' });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Test browser notification
router.post('/browser-notify-test', (req, res) => {
  sendTestBrowser();
  res.json({ success: true });
});

// ===== SSH Key Management =====

router.get('/ssh/status', (req, res) => {
  res.json(getSshStatus());
});

router.post('/ssh/generate', async (req, res) => {
  try {
    const result = await generateKey();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/ssh/authorize-localhost', (req, res) => {
  try {
    const result = authorizeLocalhost();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/ssh/test', async (req, res) => {
  const { host, user, port } = req.body;
  if (!host) return res.status(400).json({ error: 'host is required' });
  const result = await testSshConnection(host, user || 'root', port || 22);
  res.json(result);
});

// SSE stream for browser notifications
router.get('/notifications/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const id = addBrowserSubscriber((event) => {
    res.write(`data: ${event}\n\n`);
  });

  // Send heartbeat every 30s to keep connection alive
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 30000);

  req.on('close', () => {
    removeBrowserSubscriber(id);
    clearInterval(heartbeat);
  });
});

export default router;

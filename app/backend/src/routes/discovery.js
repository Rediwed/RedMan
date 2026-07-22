// Discovery routes — network scanning for RedMan peers and Immich instances

import { Router } from 'express';
import { discoverPeers, discoverImmich, clearDiscoveryCache, getDetectedSubnets } from '../services/discovery.js';

const router = Router();

// Get detected/configured subnet info
router.get('/subnets', async (req, res) => {
  try {
    const info = await getDetectedSubnets(req.query.refresh === 'true');
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Discover RedMan peers on detected subnets
router.get('/peers', async (req, res) => {
  try {
    const results = await discoverPeers({ forceRefresh: req.query.refresh === 'true' });
    if (results.error) {
      return res.status(400).json(results);
    }
    res.json(results);
  } catch (err) {
    console.error('[discovery] Peer scan failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Discover Immich instances on configured subnets
router.get('/immich', async (req, res) => {
  try {
    const results = await discoverImmich({ forceRefresh: req.query.refresh === 'true' });
    if (results.error) {
      return res.status(400).json(results);
    }
    res.json(results);
  } catch (err) {
    console.error('[discovery] Immich scan failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Clear discovery cache
router.post('/clear-cache', (req, res) => {
  clearDiscoveryCache();
  res.json({ success: true });
});

export default router;

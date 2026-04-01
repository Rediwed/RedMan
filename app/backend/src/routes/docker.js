// Docker routes — container list, actions, stats, metrics

import { Router } from 'express';
import { listContainers, containerAction, getContainerStats, getMetrics, isDockerAvailable } from '../services/docker.js';

const router = Router();

// Check Docker availability
router.get('/status', async (req, res) => {
  const available = await isDockerAvailable();
  res.json({ available });
});

// List all containers
router.get('/containers', async (req, res) => {
  try {
    const containers = await listContainers();
    res.json(containers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Container action (start/stop/restart)
router.post('/containers/:id/:action', async (req, res) => {
  try {
    const result = await containerAction(req.params.id, req.params.action);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Real-time stats for a container (single snapshot)
router.get('/containers/:id/stats', async (req, res) => {
  try {
    const stats = await getContainerStats(req.params.id);
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Historical metrics for a container
router.get('/containers/:id/metrics', (req, res) => {
  const hours = Math.min(168, Math.max(1, parseInt(req.query.hours) || 24));
  const metrics = getMetrics(req.params.id, hours);
  res.json(metrics);
});

export default router;

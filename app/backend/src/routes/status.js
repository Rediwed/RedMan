// System status board — current state across every subsystem RedMan can see.

import { Router } from 'express';
import { getSystemStatus } from '../services/systemStatus.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    res.json(await getSystemStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

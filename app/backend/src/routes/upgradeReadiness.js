import { Router } from 'express';
import db from '../db.js';
import { requireBridgeAdmin } from '../middleware/auth.js';
import {
  assessUpgradeReadiness,
  createFinalConfiguration,
  createHostPreparationPlan,
  createUpgradeBackup,
  remediateUpgradeIssue,
  saveFinalConfiguration,
} from '../services/upgradeReadiness.js';

const router = Router();

router.get('/', (req, res) => {
  try {
    res.json(assessUpgradeReadiness(db));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/backup', requireBridgeAdmin, async (req, res) => {
  try {
    const backup = await createUpgradeBackup(db);
    res.json({ success: true, backup });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.post('/remediate', requireBridgeAdmin, (req, res) => {
  try {
    res.json({ success: true, result: remediateUpgradeIssue(db, req.body?.issueId) });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.post('/host-plan', requireBridgeAdmin, (req, res) => {
  try {
    res.json(createHostPreparationPlan(req.body));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.post('/final-config', requireBridgeAdmin, (req, res) => {
  try {
    res.json(saveFinalConfiguration(db, req.body));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

export default router;

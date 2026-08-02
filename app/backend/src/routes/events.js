// Event history routes — the durable counterpart to the live SSE feed.

import { Router } from 'express';
import { listEvents, getEventSummary, listEventCategories, SEVERITIES } from '../services/events.js';

const router = Router();

router.get('/', (req, res) => {
  res.json(listEvents({
    severity: req.query.severity || null,
    category: req.query.category || null,
    type: req.query.type || null,
    since: req.query.since || null,
    page: req.query.page,
    limit: req.query.limit,
  }));
});

router.get('/summary', (req, res) => {
  res.json({
    ...getEventSummary({ since: req.query.since || '-24 hours' }),
    categories: listEventCategories(),
    severities: SEVERITIES,
  });
});

export default router;

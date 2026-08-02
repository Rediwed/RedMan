// External job routes — heartbeat ingest (public, token-authenticated) and
// management (behind the main API auth chain).

import { Router } from 'express';
import db from '../db.js';
import {
  listExternalJobs,
  getExternalJob,
  createExternalJob,
  updateExternalJob,
  deleteExternalJob,
  regenerateIngestToken,
  recordHeartbeat,
  listExternalJobRuns,
} from '../services/externalJobs.js';

function bearerToken(req) {
  const header = req.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

// Mounted before the main auth middleware: cron jobs on other hosts cannot
// present an Authelia session, so they authenticate with a per-job token.
export const heartbeatRouter = Router();

heartbeatRouter.post('/:slug', (req, res) => {
  const token = bearerToken(req);
  if (!token) return res.status(401).json({ error: 'Missing bearer token' });

  const result = recordHeartbeat(db, req.params.slug, token, req.body || {});
  // Unknown slug and wrong token return the same response so the endpoint
  // cannot be used to enumerate configured jobs.
  if (!result) return res.status(401).json({ error: 'Unauthorized' });

  res.status(202).json({ accepted: true, status: result.status });
});

const router = Router();

router.get('/', (req, res) => {
  res.json({ jobs: listExternalJobs(db) });
});

router.get('/runs', (req, res) => {
  res.json(listExternalJobRuns(db, {
    jobId: req.query.job_id ? Number(req.query.job_id) : null,
    page: req.query.page,
    limit: req.query.limit,
  }));
});

router.post('/', (req, res) => {
  if (!req.body?.name && !req.body?.slug) {
    return res.status(400).json({ error: 'A name or slug is required' });
  }
  try {
    const { job, token } = createExternalJob(db, req.body);
    res.status(201).json({ job, token });
  } catch (err) {
    const conflict = /UNIQUE constraint/i.test(err.message);
    res.status(conflict ? 409 : 400).json({
      error: conflict ? 'A job with that slug already exists' : err.message,
    });
  }
});

router.get('/:id', (req, res) => {
  const job = getExternalJob(db, Number(req.params.id));
  if (!job) return res.status(404).json({ error: 'Not found' });
  res.json(job);
});

router.put('/:id', (req, res) => {
  const job = updateExternalJob(db, Number(req.params.id), req.body || {});
  if (!job) return res.status(404).json({ error: 'Not found' });
  res.json(job);
});

router.delete('/:id', (req, res) => {
  if (!deleteExternalJob(db, Number(req.params.id))) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.json({ deleted: true });
});

router.post('/:id/regenerate-token', (req, res) => {
  const token = regenerateIngestToken(db, Number(req.params.id));
  if (!token) return res.status(404).json({ error: 'Not found' });
  res.json({ token });
});

export default router;

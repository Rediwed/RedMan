// Overview routes — aggregated dashboard data

import { Router } from 'express';
import db from '../db.js';
import { getNextRun, getActiveJobCount } from '../services/scheduler.js';

const router = Router();

// Dashboard summary — last runs + next scheduled for each feature
router.get('/summary', (req, res) => {
  const features = ['ssd-backup', 'hyper-backup', 'rclone'];
  const summary = {};

  for (const feature of features) {
    const lastRun = db.prepare(`
      SELECT id, status, started_at, completed_at, files_copied, files_failed,
        bytes_transferred, duration_seconds
      FROM backup_runs WHERE feature = ?
      ORDER BY started_at DESC LIMIT 1
    `).get(feature);

    const recentRuns = db.prepare(`
      SELECT status, COUNT(*) as count FROM backup_runs
      WHERE feature = ? AND started_at >= datetime('now', '-7 days')
      GROUP BY status
    `).all(feature);

    // Count active configs/jobs
    let configCount = 0;
    let enabledCount = 0;
    let nextScheduled = null;

    if (feature === 'ssd-backup') {
      const stats = db.prepare('SELECT COUNT(*) as total, SUM(enabled) as enabled FROM ssd_backup_configs').get();
      configCount = stats.total;
      enabledCount = stats.enabled || 0;
      const nextConfig = db.prepare('SELECT cron_expression FROM ssd_backup_configs WHERE enabled = 1 ORDER BY id LIMIT 1').get();
      if (nextConfig) nextScheduled = getNextRun(nextConfig.cron_expression);
    } else if (feature === 'hyper-backup') {
      const stats = db.prepare('SELECT COUNT(*) as total, SUM(enabled) as enabled FROM hyper_backup_jobs').get();
      configCount = stats.total;
      enabledCount = stats.enabled || 0;
      const nextJob = db.prepare('SELECT cron_expression FROM hyper_backup_jobs WHERE enabled = 1 ORDER BY id LIMIT 1').get();
      if (nextJob) nextScheduled = getNextRun(nextJob.cron_expression);
    } else if (feature === 'rclone') {
      const stats = db.prepare('SELECT COUNT(*) as total, SUM(enabled) as enabled FROM rclone_jobs').get();
      configCount = stats.total;
      enabledCount = stats.enabled || 0;
      const nextJob = db.prepare('SELECT cron_expression FROM rclone_jobs WHERE enabled = 1 ORDER BY id LIMIT 1').get();
      if (nextJob) nextScheduled = getNextRun(nextJob.cron_expression);
    }

    summary[feature] = {
      lastRun,
      recentRuns: Object.fromEntries(recentRuns.map(r => [r.status, r.count])),
      configCount,
      enabledCount,
      nextScheduled,
    };
  }

  summary.activeJobs = getActiveJobCount();
  res.json(summary);
});

export default router;

// System status board — one normalized shape for every subsystem RedMan can
// already see, so the UI does not need to know how each one reports.
//
// Deliberately separate from services/events.js: that records what *happened*,
// this answers what is true *now*. Mixing them produces either a timeline full
// of "still fine" or a board where last week's failure stays red forever.

import db from '../db.js';
import { getJobHealth } from './jobHealth.js';
import { listExternalJobs } from './externalJobs.js';
import { listContainers, isDockerAvailable } from './docker.js';
import { getPeerConnectivity } from './peerConnectivity.js';
import { getRelayStatus } from './ntfyRelay.js';

// Ordered worst-first so a rollup is a simple minimum.
const SEVERITY_ORDER = ['fail', 'warn', 'unknown', 'paused', 'ok'];

function check({ id, category, subject, state, summary, at = null, detail = null, since = null, link = null }) {
  // `at` stays a separate field rather than being formatted into the summary:
  // the UI renders timestamps in the operator's configured format.
  return { id, category, subject, state, summary, at, detail, since, link };
}

const FEATURES = [
  { feature: 'ssd-backup', table: 'ssd_backup_configs', label: 'SSD Backup', link: '/ssd-backup' },
  { feature: 'hyper-backup', table: 'hyper_backup_jobs', label: 'Hyper Backup', link: '/hyper-backup' },
  { feature: 'rclone', table: 'rclone_jobs', label: 'Cloud Backup', link: '/rclone' },
];

function backupChecks(now) {
  const checks = [];
  for (const { feature, table, label, link } of FEATURES) {
    let rows = [];
    try {
      rows = db.prepare(`SELECT id, name, cron_expression, enabled FROM ${table}`).all();
    } catch {
      continue; // feature table absent on a partial schema
    }
    for (const row of rows) {
      const health = getJobHealth(db, {
        feature,
        configId: row.id,
        cronExpression: row.cron_expression,
        enabled: !!row.enabled,
        now,
      });
      const state = health.state === 'attention'
        ? (health.stale ? 'warn' : 'fail')
        : health.state === 'paused' ? 'paused'
          : health.state === 'running' ? 'ok' : 'ok';
      let summary = 'Last run succeeded';
      let at = null;
      if (health.state === 'paused') summary = 'Schedule paused';
      else if (health.state === 'running') summary = 'Running now';
      else if (health.stale) { summary = 'Overdue since'; at = health.expectedAfterLastSuccess; }
      // Only when the issue is the current reason: a failure that a later
      // success already overtook must not be shown on a healthy job.
      else if (state === 'fail' && health.lastIssue) {
        summary = health.lastIssue.error_message || `Last run ${health.lastIssue.status}`;
      } else if (!health.lastSuccess) summary = 'No successful run recorded';

      checks.push(check({
        id: `backup:${feature}:${row.id}`,
        category: label,
        subject: row.name,
        state,
        summary,
        at,
        since: health.lastSuccess?.completed_at || null,
        link,
        detail: { nextRun: health.nextRun, lastSuccess: health.lastSuccess?.completed_at || null },
      }));
    }
  }
  return checks;
}

function externalJobChecks(now) {
  return listExternalJobs(db, { now }).map(job => {
    const h = job.health;
    const state = !job.enabled ? 'paused'
      : h.neverReported ? 'unknown'
        : h.state === 'attention' ? (h.stale ? 'warn' : 'fail')
          : 'ok';
    let summary = 'Reported success';
    let at = null;
    let failure = null;
    if (!job.enabled) summary = 'Watching paused';
    else if (h.neverReported) summary = 'Never reported in';
    else if (h.stale) { summary = 'No report since'; at = h.overdueSince; }
    else if (state === 'fail' && h.lastIssue) {
      // The code travels as a fact; turning it into a sentence is the reader's side.
      failure = { exitCode: h.lastIssue.exit_code ?? null, message: h.lastIssue.message || null };
      summary = h.lastIssue.message || `Exit code ${h.lastIssue.exit_code ?? 'unknown'}`;
    }

    return check({
      id: `external:${job.slug}`,
      category: 'External jobs',
      subject: job.host ? `${job.name} (${job.host})` : job.name,
      state,
      summary,
      at,
      since: job.last_reported_at,
      link: '/status?tab=jobs',
      detail: { schedule: job.cron_expression, nextRun: h.nextRun, failure },
    });
  });
}

async function containerChecks() {
  if (!(await isDockerAvailable())) {
    return [check({
      id: 'docker:unavailable',
      category: 'Containers',
      subject: 'Docker',
      state: 'unknown',
      summary: 'Docker socket not reachable',
      link: '/',
    })];
  }
  const containers = await listContainers();
  return containers.map(c => {
    // A container can be "running" and still failing its own healthcheck —
    // exactly the case a reachability probe reports as fine.
    let state = 'ok';
    let summary = c.status;
    // A clean exit means the container finished or was stopped deliberately; a
    // non-zero exit is unambiguously a fault. The restart policy would be the
    // better signal, but the hardened socket proxy denies inspect on purpose.
    const cleanExit = c.exitCode === 0;

    if (c.health === 'unhealthy') { state = 'fail'; summary = `Running but unhealthy — ${c.status}`; }
    else if (c.state === 'restarting') { state = 'warn'; summary = 'Restarting'; }
    else if (c.state === 'exited' && cleanExit) { state = 'paused'; summary = `Stopped — ${c.status}`; }
    else if (c.state === 'exited') { state = 'warn'; summary = `Exited abnormally — ${c.status}`; }
    else if (c.state === 'paused') { state = 'paused'; summary = 'Paused'; }
    else if (c.health === 'starting') { state = 'unknown'; summary = 'Healthcheck starting'; }
    else if (c.state !== 'running') { state = 'unknown'; summary = c.status; }

    return check({
      id: `container:${c.name}`,
      category: 'Containers',
      subject: c.name,
      state,
      summary,
      link: '/',
      detail: { image: c.image, state: c.state, health: c.health, exitCode: c.exitCode },
    });
  });
}

async function peerChecks() {
  let peers = [];
  try {
    peers = await getPeerConnectivity();
  } catch {
    return [];
  }
  return peers.map(p => check({
    id: `peer:${p.id}`,
    category: 'Peers',
    subject: p.name || p.url,
    state: p.status === 'online' ? 'ok' : p.status === 'unreachable' ? 'fail' : 'unknown',
    summary: p.status === 'online'
      ? `Online — ${p.instance || p.hostname || 'reachable'}`
      : p.status === 'unreachable' ? 'Did not answer the discovery probe' : 'Address could not be validated',
    since: p.last_seen_at,
    link: '/settings',
    detail: { url: p.url, version: p.version || null },
  }));
}

/**
 * The relay's own health.
 *
 * Without this, a broker RedMan cannot reach looks identical to every relayed
 * schedule failing at once. One honest "the collector is down" beats a board
 * full of misattributed blame.
 */
function relayChecks(now) {
  const relay = getRelayStatus();
  if (!relay.configured) return [];

  const lastSuccess = relay.lastSuccessAt ? new Date(relay.lastSuccessAt) : null;
  const silentMinutes = lastSuccess ? (now.getTime() - lastSuccess.getTime()) / 60000 : null;

  let state = 'ok';
  let summary = 'Collecting heartbeats';
  let at = relay.lastSuccessAt;

  if (!relay.running) {
    state = 'paused';
    summary = 'Collector not running';
    at = null;
  } else if (!lastSuccess) {
    state = 'unknown';
    summary = relay.lastError ? `No successful poll yet — ${relay.lastError}` : 'No successful poll yet';
    at = null;
  } else if (relay.lastError) {
    state = 'warn';
    summary = `Last poll failed — ${relay.lastError}`;
  } else if (silentMinutes > 30) {
    state = 'warn';
    summary = 'No successful poll since';
  }

  return [check({
    id: 'relay:ntfy',
    category: 'Relay',
    // The topic name is deliberately not shown: on a public broker it is the
    // capability, and this board is readable by anyone with read access.
    subject: 'ntfy heartbeat topic',
    state,
    summary,
    at,
    since: relay.lastSuccessAt,
    link: '/settings',
    detail: { consecutiveFailures: relay.consecutiveFailures, lastRecorded: relay.lastRecorded },
  })];
}

function worst(states) {
  for (const level of SEVERITY_ORDER) {
    if (states.includes(level)) return level;
  }
  return 'ok';
}

/**
 * Collect every subsystem check. Failures in one collector never take the board
 * down: a broken Docker socket should not hide backup health.
 */
export async function getSystemStatus({ now = new Date() } = {}) {
  const collectors = [
    { name: 'backups', run: async () => backupChecks(now) },
    { name: 'external', run: async () => externalJobChecks(now) },
    { name: 'containers', run: containerChecks },
    { name: 'peers', run: peerChecks },
    { name: 'relay', run: async () => relayChecks(now) },
  ];

  const settled = await Promise.allSettled(collectors.map(c => c.run()));
  const checks = [];
  const failedCollectors = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') checks.push(...result.value);
    else failedCollectors.push({ collector: collectors[index].name, error: result.reason?.message || 'unknown' });
  });

  const byCategory = {};
  for (const item of checks) {
    (byCategory[item.category] ||= []).push(item);
  }

  const counts = checks.reduce((acc, item) => {
    acc[item.state] = (acc[item.state] || 0) + 1;
    return acc;
  }, {});

  return {
    generatedAt: now.toISOString(),
    overall: worst(checks.map(c => c.state)),
    counts,
    categories: Object.entries(byCategory)
      .map(([name, items]) => ({
        name,
        state: worst(items.map(i => i.state)),
        checks: items.sort((a, b) => SEVERITY_ORDER.indexOf(a.state) - SEVERITY_ORDER.indexOf(b.state)),
      }))
      .sort((a, b) => SEVERITY_ORDER.indexOf(a.state) - SEVERITY_ORDER.indexOf(b.state)),
    failedCollectors,
  };
}

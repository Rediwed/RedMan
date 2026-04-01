// Docker service — container management + metrics collection
// Connects to Docker Engine API via socket

import Docker from 'dockerode';
import db from '../db.js';

let docker = null;
let pollInterval = null;

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row?.value || '';
}

function getDocker() {
  if (!docker) {
    const socketPath = getSetting('docker_socket') || '/var/run/docker.sock';
    docker = new Docker({ socketPath });
  }
  return docker;
}

// List all containers with basic info
export async function listContainers() {
  try {
    const containers = await getDocker().listContainers({ all: true });
    return containers.map(c => ({
      id: c.Id.slice(0, 12),
      name: c.Names[0]?.replace(/^\//, '') || c.Id.slice(0, 12),
      image: c.Image,
      state: c.State,
      status: c.Status,
      created: new Date(c.Created * 1000).toISOString(),
      ports: c.Ports.map(p => ({
        private: p.PrivatePort,
        public: p.PublicPort,
        type: p.Type,
      })),
    }));
  } catch (err) {
    console.error('[docker] Failed to list containers:', err.message);
    return [];
  }
}

// Execute container action (start/stop/restart)
const ALLOWED_ACTIONS = ['start', 'stop', 'restart'];

export async function containerAction(containerId, action) {
  if (!ALLOWED_ACTIONS.includes(action)) {
    throw new Error(`Action '${action}' not allowed. Allowed: ${ALLOWED_ACTIONS.join(', ')}`);
  }

  const container = getDocker().getContainer(containerId);
  await container[action]();
  return { success: true, action, containerId };
}

// Get real-time stats for a container (single snapshot)
export async function getContainerStats(containerId) {
  const container = getDocker().getContainer(containerId);
  const stats = await container.stats({ stream: false });
  return parseStats(stats, containerId);
}

function parseStats(stats, containerId) {
  // CPU calculation
  const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - (stats.precpu_stats?.cpu_usage?.total_usage || 0);
  const systemDelta = stats.cpu_stats.system_cpu_usage - (stats.precpu_stats?.system_cpu_usage || 0);
  const numCpus = stats.cpu_stats.online_cpus || stats.cpu_stats.cpu_usage.percpu_usage?.length || 1;
  const cpuPercent = systemDelta > 0 ? (cpuDelta / systemDelta) * numCpus * 100 : 0;

  // Memory
  const memUsage = stats.memory_stats.usage - (stats.memory_stats.stats?.cache || 0);
  const memLimit = stats.memory_stats.limit;

  return {
    containerId,
    cpuPercent: Math.round(cpuPercent * 100) / 100,
    memoryUsage: memUsage,
    memoryLimit: memLimit,
    memoryPercent: memLimit > 0 ? Math.round((memUsage / memLimit) * 10000) / 100 : 0,
  };
}

// Background metrics poller
export function startMetricsPoller() {
  const intervalSec = parseInt(getSetting('metrics_poll_interval') || '30');
  const retentionHours = parseInt(getSetting('metrics_retention_hours') || '24');

  console.log(`[docker] Starting metrics poller (${intervalSec}s interval, ${retentionHours}h retention)`);

  const insertMetric = db.prepare(`
    INSERT INTO container_metrics (container_id, container_name, cpu_percent, memory_usage, memory_limit)
    VALUES (?, ?, ?, ?, ?)
  `);

  const purgeOld = db.prepare(`
    DELETE FROM container_metrics WHERE recorded_at < datetime('now', ? || ' hours')
  `);

  async function poll() {
    try {
      const containers = await getDocker().listContainers({ filters: { status: ['running'] } });

      for (const c of containers) {
        try {
          const stats = await getContainerStats(c.Id.slice(0, 12));
          const name = c.Names[0]?.replace(/^\//, '') || c.Id.slice(0, 12);
          insertMetric.run(c.Id.slice(0, 12), name, stats.cpuPercent, stats.memoryUsage, stats.memoryLimit);
        } catch {
          // Container might have stopped between list and stats
        }
      }

      // Purge old metrics
      purgeOld.run(`-${retentionHours}`);
    } catch (err) {
      // Docker not available — silently skip (common in dev)
    }
  }

  // Initial poll after a short delay
  setTimeout(poll, 5000);
  pollInterval = setInterval(poll, intervalSec * 1000);
}

export function stopMetricsPoller() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

// Get historical metrics from SQLite
export function getMetrics(containerId, hours = 24) {
  return db.prepare(`
    SELECT container_id, container_name, cpu_percent, memory_usage, memory_limit, recorded_at
    FROM container_metrics
    WHERE container_id = ? AND recorded_at >= datetime('now', ? || ' hours')
    ORDER BY recorded_at ASC
  `).all(containerId, `-${hours}`);
}

// Check if Docker is reachable
export async function isDockerAvailable() {
  try {
    await getDocker().ping();
    return true;
  } catch {
    return false;
  }
}

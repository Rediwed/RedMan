// Docker service — container management + metrics collection
// Connects to Docker Engine API via socket

import db from '../db.js';
import { createDockerClient, executeDockerControlAction } from './dockerClient.js';

let docker = null;
let dockerControl = null;
let pollInterval = null;
let initialPollTimer = null;

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row?.value || '';
}

export function getDockerClient() {
  if (!docker) {
    const endpoint = getSetting('docker_socket') || process.env.DOCKER_HOST || '';
    if (!endpoint) throw new Error('Docker monitoring is not configured');
    docker = createDockerClient(endpoint);
  }
  return docker;
}

function getDockerControlClient() {
  if (!dockerControl) {
    const endpoint = process.env.DOCKER_CONTROL_HOST || '';
    if (!endpoint) throw new Error('Docker container control is not configured');
    dockerControl = createDockerClient(endpoint);
  }
  return dockerControl;
}

// List all containers with basic info
export async function listContainers() {
  try {
    const containers = await getDockerClient().listContainers({ all: true });
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

export async function containerAction(containerId, action) {
  return executeDockerControlAction(
    getDockerClient(),
    getDockerControlClient(),
    containerId,
    action,
  );
}

// Get real-time stats for a container (single snapshot)
export async function getContainerStats(containerId) {
  const container = getDockerClient().getContainer(containerId);
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

  console.log(`[docker] Starting metrics poller (${intervalSec}s interval)`);

  const insertMetric = db.prepare(`
    INSERT INTO container_metrics (container_id, container_name, cpu_percent, memory_usage, memory_limit)
    VALUES (?, ?, ?, ?, ?)
  `);

  async function poll() {
    try {
      const containers = await getDockerClient().listContainers({ filters: { status: ['running'] } });

      for (const c of containers) {
        try {
          const stats = await getContainerStats(c.Id.slice(0, 12));
          const name = c.Names[0]?.replace(/^\//, '') || c.Id.slice(0, 12);
          insertMetric.run(c.Id.slice(0, 12), name, stats.cpuPercent, stats.memoryUsage, stats.memoryLimit);
        } catch {
          // Container might have stopped between list and stats
        }
      }

    } catch (err) {
      // Docker not available — silently skip (common in dev)
    }
  }

  // Initial poll after a short delay
  initialPollTimer = setTimeout(poll, 5000);
  pollInterval = setInterval(poll, intervalSec * 1000);
}

export function stopMetricsPoller() {
  if (initialPollTimer) {
    clearTimeout(initialPollTimer);
    initialPollTimer = null;
  }
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
    await getDockerClient().ping();
    return true;
  } catch {
    return false;
  }
}

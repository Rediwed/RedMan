// Network discovery service — auto-detects LAN subnets and scans for
// RedMan peers and Immich instances. Zero configuration required.
//
// Detection strategies (tried in order):
// 1. os.networkInterfaces() — works directly on host or in --net=host containers
// 2. Docker macvlan/ipvlan networks — reveals LAN subnets from network config
// 3. Temporary host-network container — runs a one-liner to read host interfaces
// 4. Manual override — discovery_subnets setting (for VPN ranges, etc.)

import os from 'os';
import { existsSync } from 'fs';
import Dockerode from 'dockerode';
import db from '../db.js';

const REDMAN_PEER_PORT = 8091;
const IMMICH_DEFAULT_PORT = 2283;
const SCAN_TIMEOUT_MS = 800;
const BATCH_SIZE = 100;

// Cache to avoid rescanning too frequently
let peerCache = { results: [], timestamp: 0 };
let immichCache = { results: [], timestamp: 0 };
const CACHE_TTL_MS = 30_000; // 30 seconds

// Auto-detected subnets cache (longer TTL — host network doesn't change often)
let subnetCache = { subnets: null, source: null, timestamp: 0 };
const SUBNET_CACHE_TTL_MS = 5 * 60_000; // 5 minutes

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row?.value || '';
}

// ── Subnet parsing ────────────────────────────────────────────────

function parseSubnets(raw) {
  if (!raw || !raw.trim()) return [];
  return raw.split(/[,\s]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function isValidPrivateIp(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) return false;
  // Allow RFC1918 private ranges + CGNAT (100.64/10 for Tailscale) + link-local
  if (parts[0] === 10) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true; // CGNAT / Tailscale
  if (parts[0] === 169 && parts[1] === 254) return true; // Link-local
  return false;
}

function isDockerInternalIp(ip) {
  const parts = ip.split('.').map(Number);
  // Docker default bridge: 172.17.0.0/16, user bridges: 172.18-31.x
  return parts[0] === 172 && parts[1] >= 17 && parts[1] <= 31;
}

function ipTo24Subnet(ip) {
  const parts = ip.split('.');
  return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
}

function isInDocker() {
  return existsSync('/.dockerenv');
}

// ── Auto-detection ────────────────────────────────────────────────

// Detect LAN subnets automatically. Merges auto-detected with manual config.
async function getSubnets(forceRefresh = false) {
  // Check cache
  if (!forceRefresh && subnetCache.subnets && Date.now() - subnetCache.timestamp < SUBNET_CACHE_TTL_MS) {
    return subnetCache;
  }

  const subnets = new Set();
  let source = 'none';

  // Manual subnets always included
  const manual = parseSubnets(getSetting('discovery_subnets'));
  for (const s of manual) subnets.add(s);

  // Auto-detect
  const auto = await autoDetectSubnets();
  for (const s of auto.subnets) subnets.add(s);
  if (auto.source !== 'none') source = auto.source;
  if (manual.length > 0) source = source === 'none' ? 'manual' : `${source}+manual`;

  const result = { subnets: [...subnets], source, auto: auto.subnets, manual, timestamp: Date.now() };
  subnetCache = result;
  return result;
}

async function autoDetectSubnets() {
  const subnets = new Set();

  // Strategy 1: OS network interfaces (works in host mode or bare metal)
  const ifaces = os.networkInterfaces();
  for (const addrs of Object.values(ifaces)) {
    for (const a of addrs) {
      if (a.family === 'IPv4' && !a.internal) {
        if (isValidPrivateIp(a.address) && !isDockerInternalIp(a.address)) {
          subnets.add(ipTo24Subnet(a.address));
        }
      }
    }
  }

  // If we found LAN subnets and we're not in Docker, we're done
  if (subnets.size > 0 && !isInDocker()) {
    return { subnets: [...subnets], source: 'interfaces' };
  }

  // In Docker — the interfaces are Docker-internal. Try Docker API.
  try {
    const docker = new Dockerode();

    // Strategy 2: Docker macvlan/ipvlan networks (reveals LAN subnets)
    const networks = await docker.listNetworks();
    for (const net of networks) {
      if (['macvlan', 'ipvlan'].includes(net.Driver)) {
        try {
          const detail = await docker.getNetwork(net.Id).inspect();
          for (const config of (detail.IPAM?.Config || [])) {
            if (config.Subnet) {
              const baseIp = config.Subnet.split('/')[0];
              if (isValidPrivateIp(baseIp) && !isDockerInternalIp(baseIp)) {
                subnets.add(config.Subnet);
              }
            }
          }
        } catch { /* skip */ }
      }
    }

    if (subnets.size > 0) {
      return { subnets: [...subnets], source: 'docker-networks' };
    }

    // Strategy 3: Temporary host-network container to read the host's interfaces
    const hostSubnets = await detectViaHostContainer(docker);
    if (hostSubnets.length > 0) {
      return { subnets: hostSubnets, source: 'docker-host' };
    }
  } catch (err) {
    console.warn('[discovery] Docker auto-detect unavailable:', err.message);
  }

  return { subnets: [...subnets], source: subnets.size > 0 ? 'interfaces' : 'none' };
}

async function detectViaHostContainer(docker) {
  const subnets = [];
  let container;

  // Tiny Node.js one-liner that outputs the host's IPv4 interfaces as JSON
  const script = `
    const r=[];
    for(const a of Object.values(require('os').networkInterfaces()).flat())
      if(a.family==='IPv4'&&!a.internal)r.push(a.address);
    process.stdout.write(JSON.stringify(r));
  `.replace(/\n/g, '');

  try {
    container = await docker.createContainer({
      Image: 'node:20-alpine',
      Cmd: ['node', '-e', script],
      Tty: true,
      HostConfig: { NetworkMode: 'host' },
    });

    await container.start();
    await container.wait({ condition: 'not-running' });

    const logBuffer = await container.logs({ stdout: true, stderr: false });
    const text = logBuffer.toString('utf-8').trim();

    // Find the JSON array in the output (skip any Docker log headers)
    const match = text.match(/\[.*\]/);
    if (match) {
      const ips = JSON.parse(match[0]);
      for (const ip of ips) {
        if (isValidPrivateIp(ip) && !isDockerInternalIp(ip)) {
          subnets.push(ipTo24Subnet(ip));
        }
      }
      console.log(`[discovery] Detected host LAN subnets: ${subnets.join(', ') || '(none)'}`);
    }
  } catch (err) {
    console.warn('[discovery] Host container detection failed:', err.message);
  } finally {
    if (container) {
      try { await container.remove({ force: true }); } catch { /* ignore */ }
    }
  }

  return subnets;
}

// Public: get currently detected subnet info (for Settings page display)
export async function getDetectedSubnets(forceRefresh = false) {
  return getSubnets(forceRefresh);
}

function cidrToIps(entry) {
  // Single IP (no CIDR)
  if (!entry.includes('/')) {
    if (isValidPrivateIp(entry)) return [entry];
    return [];
  }

  const [base, bitsStr] = entry.split('/');
  const mask = parseInt(bitsStr);
  if (isNaN(mask) || mask < 16 || mask > 30) return []; // Don't scan anything larger than /16

  if (!isValidPrivateIp(base)) return [];

  const parts = base.split('.').map(Number);
  const baseNum = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  const hostBits = 32 - mask;
  const count = 1 << hostBits;
  const networkAddr = (baseNum & (0xFFFFFFFF << hostBits) >>> 0) >>> 0;

  const ips = [];
  for (let i = 1; i < count - 1; i++) { // Skip network and broadcast
    const ip = networkAddr + i;
    ips.push(`${(ip >>> 24) & 255}.${(ip >>> 16) & 255}.${(ip >>> 8) & 255}.${ip & 255}`);
  }
  return ips;
}

// ── HTTP probing ──────────────────────────────────────────────────

async function probeUrl(url, timeoutMs = SCAN_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    clearTimeout(timer);
    return null;
  }
}

async function scanIps(ips, probeFn) {
  const results = [];
  for (let i = 0; i < ips.length; i += BATCH_SIZE) {
    const batch = ips.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.allSettled(
      batch.map(ip => probeFn(ip))
    );
    for (const r of batchResults) {
      if (r.status === 'fulfilled' && r.value) {
        results.push(r.value);
      }
    }
  }
  return results;
}

// ── RedMan peer discovery ─────────────────────────────────────────

export async function discoverPeers(options = {}) {
  const { forceRefresh = false } = options;

  if (!forceRefresh && peerCache.results.length > 0 && Date.now() - peerCache.timestamp < CACHE_TTL_MS) {
    return peerCache.results;
  }

  const { subnets } = await getSubnets(forceRefresh);
  if (subnets.length === 0) {
    return { error: 'no_subnets', message: 'Could not detect any LAN subnets. Add them manually in Settings → Infrastructure.' };
  }

  const ips = subnets.flatMap(s => cidrToIps(s));

  console.log(`[discovery] Scanning ${ips.length} IPs for RedMan peers...`);

  const myHostname = os.hostname();

  const results = await scanIps(ips, async (ip) => {
    const data = await probeUrl(`http://${ip}:${REDMAN_PEER_PORT}/peer/discover`);
    if (data && data.service === 'redman') {
      // Filter out ourselves by comparing hostnames (container IDs)
      if (data.hostname && data.hostname === myHostname) return null;

      return {
        ip,
        url: `http://${ip}:${REDMAN_PEER_PORT}`,
        instance: data.instance || 'RedMan',
        version: data.version || 'unknown',
        hostname: data.hostname || ip,
      };
    }
    return null;
  });

  console.log(`[discovery] Found ${results.length} RedMan peer(s)`);
  peerCache = { results, timestamp: Date.now() };
  return results;
}

// ── Immich discovery ──────────────────────────────────────────────

export async function discoverImmich(options = {}) {
  const { forceRefresh = false } = options;

  if (!forceRefresh && immichCache.results.length > 0 && Date.now() - immichCache.timestamp < CACHE_TTL_MS) {
    return immichCache.results;
  }

  const { subnets } = await getSubnets(forceRefresh);
  if (subnets.length === 0) {
    return { error: 'no_subnets', message: 'Could not detect any LAN subnets. Add them manually in Settings → Infrastructure.' };
  }

  const ips = subnets.flatMap(s => cidrToIps(s));

  console.log(`[discovery] Scanning ${ips.length} IPs for Immich instances...`);

  const results = await scanIps(ips, async (ip) => {
    const ping = await probeUrl(`http://${ip}:${IMMICH_DEFAULT_PORT}/api/server/ping`);
    if (ping && ping.res === 'pong') {
      // Try to get version
      let versionStr = 'unknown';
      try {
        const ver = await probeUrl(`http://${ip}:${IMMICH_DEFAULT_PORT}/api/server/about`);
        if (ver && ver.version) versionStr = ver.version;
      } catch { /* version is optional */ }

      return {
        ip,
        url: `http://${ip}:${IMMICH_DEFAULT_PORT}`,
        version: versionStr,
      };
    }
    return null;
  });

  console.log(`[discovery] Found ${results.length} Immich instance(s)`);
  immichCache = { results, timestamp: Date.now() };
  return results;
}

export function clearDiscoveryCache() {
  peerCache = { results: [], timestamp: 0 };
  immichCache = { results: [], timestamp: 0 };
}

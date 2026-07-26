// Callback address resolution — figures out which URL a remote peer should use
// to call this instance back during pairing.
//
// Resolution order (first match wins):
//   1. `peer_api_url` setting      — explicit operator override
//   2. `PEER_HOST` runtime config  — the private IP already declared as peer-reachable
//   3. Host network interfaces     — bare metal, host networking, and macvlan
//
// Step 2 exists because a container on a Docker bridge network only ever sees its
// own 172.x bridge address, which is useless to a peer on another host. Discovery
// already survives that case (it falls back to the Docker API), so pairing must
// not be the only feature that hard-fails there.

import os from 'os';
import { validatePrivatePeerBaseUrl } from './peerUrlPolicy.js';
import { runtimeConfig } from './runtimeConfig.js';

function isDockerBridgeIp(parts) {
  return parts[0] === 172 && parts[1] >= 17 && parts[1] <= 31;
}

function isLinkLocalIp(parts) {
  return parts[0] === 169 && parts[1] === 254;
}

// Pick the first non-loopback, non-Docker-bridge IPv4 the host itself exposes.
export function detectInterfaceCallbackIp(interfaces = os.networkInterfaces()) {
  for (const addrs of Object.values(interfaces || {})) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const parts = String(a.address).split('.').map(Number);
      if (parts.length !== 4 || parts.some(p => !Number.isInteger(p))) continue;
      if (isDockerBridgeIp(parts)) continue;
      if (isLinkLocalIp(parts)) continue;
      return a.address;
    }
  }
  return null;
}

function callbackPort(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return 8091;
  if (!/^\d+$/.test(raw)) throw new Error('Peer API port must be an integer between 1 and 65535');
  const parsed = Number(raw);
  if (parsed < 1 || parsed > 65535) throw new Error('Peer API port must be an integer between 1 and 65535');
  return parsed;
}

function toBaseUrl(host, port) {
  const literal = host.includes(':') ? `[${host}]` : host;
  return validatePrivatePeerBaseUrl(`http://${literal}:${port}`, 'Peer callback URL');
}

// Resolve the base URL this instance advertises to a peer during pairing.
export function resolveCallbackUrl(options = {}) {
  const {
    peerPort,
    explicitUrl = '',
    peerHost = runtimeConfig.peerHost,
    interfaces,
  } = options;

  if (explicitUrl) {
    return validatePrivatePeerBaseUrl(String(explicitUrl).trim(), 'Peer API URL');
  }

  const port = callbackPort(peerPort);

  if (peerHost) return toBaseUrl(peerHost, port);

  const interfaceIp = detectInterfaceCallbackIp(interfaces);
  if (interfaceIp) return toBaseUrl(interfaceIp, port);

  throw new Error(
    'Could not determine a private callback IP. RedMan only sees a Docker bridge address. '
    + 'Set PEER_HOST to this host\'s private IP, or fill in '
    + 'Settings → Infrastructure → Peer API URL (for example http://10.10.0.9:8091).',
  );
}

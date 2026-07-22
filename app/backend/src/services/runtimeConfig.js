import { validatePrivatePeerHost } from './peerUrlPolicy.js';

function port(value, fallback, name) {
  const raw = String(value ?? fallback).trim();
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer between 1 and 65535`);
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return parsed;
}

function sshUser(value) {
  const user = String(value || 'redman-backup').trim();
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(user) || user.startsWith('-') || user.toLowerCase() === 'root') {
    throw new Error('SSH_USER must be a non-root account containing only letters, digits, dot, dash, or underscore');
  }
  return user;
}

function peerHost(value, required) {
  const host = String(value || '').trim();
  if (!host) {
    if (required) throw new Error('PEER_HOST must be set in production to the numeric private SSH IP reachable by peers');
    return null;
  }
  if (['0.0.0.0', '::', '[::]'].includes(host)) {
    throw new Error('PEER_HOST cannot be a wildcard address; set the numeric private SSH IP reachable by peers');
  }
  return validatePrivatePeerHost(host, 'PEER_HOST');
}

export function getRuntimeConfig(env = process.env) {
  const mainPort = port(env.PORT, 8090, 'PORT');
  const peerApiPort = port(env.PEER_API_PORT, 8091, 'PEER_API_PORT');
  if (mainPort === peerApiPort) throw new Error('PORT and PEER_API_PORT must use different ports');

  return Object.freeze({
    mainPort,
    peerApiPort,
    peerHost: peerHost(env.PEER_HOST, env.NODE_ENV === 'production'),
    sshUser: sshUser(env.SSH_USER),
    sshPort: port(env.SSH_PORT, 22, 'SSH_PORT'),
  });
}

export function requirePeerHost(config = runtimeConfig) {
  if (!config.peerHost) {
    const error = new Error('Peer backup is unavailable until PEER_HOST is set to a numeric private SSH IP reachable by peers');
    error.status = 503;
    throw error;
  }
  return config.peerHost;
}

export const runtimeConfig = getRuntimeConfig();
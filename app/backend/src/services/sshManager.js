// SSH key management service for Hyper Backup
// Handles key generation, public key retrieval, connection testing, and localhost authorization

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'fs';
import { join, dirname } from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import {
  buildRestrictedAuthorizedKey,
  normalizeSshPublicKey,
  removeAuthorizedKeyContent,
  upsertAuthorizedKeyContent,
} from './sshKeyValidation.js';
import { validateSshConnectionTarget } from './sshConnectionPolicy.js';

// Persist SSH keys in the data volume so they survive container rebuilds
const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DB_PATH
  ? dirname(process.env.DB_PATH)
  : join(__dirname, '..', '..', 'data');
const SSH_DIR = join(DATA_DIR, '.ssh');
const KEY_PATH = join(SSH_DIR, 'id_ed25519');
const PUB_KEY_PATH = KEY_PATH + '.pub';
const AUTHORIZED_KEYS = join(SSH_DIR, 'authorized_keys');

// Check if an SSH key pair exists
export function hasKey() {
  return existsSync(KEY_PATH) && existsSync(PUB_KEY_PATH);
}

// Get the public key contents
export function getPublicKey() {
  if (!existsSync(PUB_KEY_PATH)) return null;
  return readFileSync(PUB_KEY_PATH, 'utf-8').trim();
}

// Generate a new ed25519 key pair
export function generateKey() {
  return new Promise((resolve, reject) => {
    mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 });

    if (existsSync(KEY_PATH)) {
      reject(new Error('SSH key already exists. Delete it first if you want to regenerate.'));
      return;
    }

    const proc = spawn('ssh-keygen', [
      '-t', 'ed25519',
      '-f', KEY_PATH,
      '-N', '',  // empty passphrase
      '-C', 'redman@' + (process.env.HOSTNAME || 'homelab'),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ publicKey: getPublicKey(), keyPath: KEY_PATH });
      } else {
        reject(new Error(`ssh-keygen failed: ${stderr}`));
      }
    });

    proc.on('error', err => reject(new Error(`Failed to run ssh-keygen: ${err.message}`)));
  });
}

// Add public key to local authorized_keys (for localhost SSH testing)
export function authorizeLocalhost() {
  const pubKey = getPublicKey();
  if (!pubKey) throw new Error('No public key found. Generate a key first.');
  return authorizeKey(pubKey);
}

// Host SSH authorized_keys — mounted from the host for peer key authorization
const HOST_AUTHORIZED_KEYS = '/host-ssh/authorized_keys';

// Add any public key string to authorized_keys (container + host)
export function authorizeKey(pubKey, restriction = null) {
  const normalizedKey = normalizeSshPublicKey(pubKey);
  const authorizedEntry = restriction
    ? buildRestrictedAuthorizedKey(
      normalizedKey,
      restriction.allowedPathPrefix,
      restriction.sourceIp,
      process.env.RRSYNC_PATH || '/usr/bin/rrsync',
    )
    : normalizedKey;

  mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 });

  const containerExisting = existsSync(AUTHORIZED_KEYS) ? readFileSync(AUTHORIZED_KEYS, 'utf-8') : '';
  const containerUpdated = upsertAuthorizedKeyContent(containerExisting, authorizedEntry, normalizedKey);
  const containerAlready = containerUpdated === containerExisting;
  writeFileSync(AUTHORIZED_KEYS, containerUpdated);
  chmodSync(AUTHORIZED_KEYS, 0o600);

  // Also authorize on the host so rsync-over-SSH works
  let hostAlready = false;
  if (existsSync(HOST_AUTHORIZED_KEYS)) {
    const hostExisting = readFileSync(HOST_AUTHORIZED_KEYS, 'utf-8');
    const hostUpdated = upsertAuthorizedKeyContent(hostExisting, authorizedEntry, normalizedKey);
    hostAlready = hostUpdated === hostExisting;
    if (!hostAlready) {
      writeFileSync(HOST_AUTHORIZED_KEYS, hostUpdated, { mode: 0o600 });
      console.log('[sshManager] Added peer SSH key to host authorized_keys');
    }
  } else if (restriction) {
    throw new Error('Host authorized_keys is not mounted; peer SSH access cannot be managed safely');
  }

  return {
    alreadyAuthorized: containerAlready && (restriction ? hostAlready : true),
    restricted: !!restriction,
    hostManaged: existsSync(HOST_AUTHORIZED_KEYS),
  };
}

function updateAuthorizedKeyFile(filePath, update, label) {
  if (!existsSync(filePath)) return false;
  try {
    const existing = readFileSync(filePath, 'utf-8');
    const next = update(existing);
    if (next !== existing) writeFileSync(filePath, next, { mode: 0o600 });
    return true;
  } catch (err) {
    throw new Error(`Could not update ${label} authorized_keys: ${err.message}`);
  }
}

export function revokeKey(pubKey) {
  if (!existsSync(HOST_AUTHORIZED_KEYS)) {
    throw new Error('Host authorized_keys is not mounted; peer SSH access cannot be revoked safely');
  }
  const normalizedKey = normalizeSshPublicKey(pubKey);
  const remove = content => removeAuthorizedKeyContent(content, normalizedKey);
  const containerUpdated = updateAuthorizedKeyFile(AUTHORIZED_KEYS, remove, 'container');
  const hostUpdated = updateAuthorizedKeyFile(HOST_AUTHORIZED_KEYS, remove, 'host');
  return { revoked: containerUpdated || hostUpdated, hostManaged: hostUpdated };
}

export function replaceKeyAuthorization(previousKey, nextKey, restriction) {
  const normalizedNext = normalizeSshPublicKey(nextKey);
  if (previousKey) {
    const normalizedPrevious = normalizeSshPublicKey(previousKey);
    if (normalizedPrevious !== normalizedNext) revokeKey(normalizedPrevious);
  }
  const result = authorizeKey(normalizedNext, restriction);
  if (restriction && !result.hostManaged) {
    throw new Error('Host authorized_keys was not updated');
  }
  return result;
}

// Test SSH connection to a host (non-interactive, times out after 10s)
export function testSshConnection(host, user = 'redman-backup', port = 22) {
  const target = validateSshConnectionTarget(host, user, port);
  return new Promise((resolve) => {
    const proc = spawn('ssh', [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=10',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-p', String(target.port),
      `${target.user}@${target.host}`,
      'echo', 'SSH_OK',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    const timeout = setTimeout(() => {
      proc.kill();
      resolve({ ok: false, error: 'Connection timed out (10s)' });
    }, 15000);

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0 && stdout.includes('SSH_OK')) {
        resolve({ ok: true });
      } else {
        // Parse common SSH errors into friendly messages
        let error = stderr.trim() || `Exit code ${code}`;
        if (error.includes('Connection refused')) error = 'Connection refused — is SSH/Remote Login enabled on the target?';
        else if (error.includes('Permission denied')) error = 'Permission denied — public key not authorized on the target host';
        else if (error.includes('No route to host')) error = 'No route to host — check network/VPN connectivity';
        else if (error.includes('Could not resolve hostname')) error = `Could not resolve hostname "${target.host}"`;
        resolve({ ok: false, error });
      }
    });

    proc.on('error', err => {
      clearTimeout(timeout);
      resolve({ ok: false, error: `Failed to run ssh: ${err.message}` });
    });
  });
}

// Get SSH status summary
export function getSshStatus() {
  const keyExists = hasKey();
  return {
    keyExists,
    publicKey: keyExists ? getPublicKey() : null,
    keyPath: keyExists ? KEY_PATH : null,
  };
}

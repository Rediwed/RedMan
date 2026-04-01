// SSH key management service for Hyper Backup
// Handles key generation, public key retrieval, connection testing, and localhost authorization

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawn } from 'child_process';

const SSH_DIR = join(homedir(), '.ssh');
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
      return reject(new Error('SSH key already exists. Delete it first if you want to regenerate.'));
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

  mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 });

  // Check if already authorized
  if (existsSync(AUTHORIZED_KEYS)) {
    const existing = readFileSync(AUTHORIZED_KEYS, 'utf-8');
    if (existing.includes(pubKey)) {
      return { alreadyAuthorized: true };
    }
  }

  appendFileSync(AUTHORIZED_KEYS, '\n' + pubKey + '\n');
  chmodSync(AUTHORIZED_KEYS, 0o600);
  return { alreadyAuthorized: false };
}

// Test SSH connection to a host (non-interactive, times out after 10s)
export function testSshConnection(host, user = 'root', port = 22) {
  return new Promise((resolve) => {
    const proc = spawn('ssh', [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=10',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-p', String(port),
      `${user}@${host}`,
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
        else if (error.includes('Could not resolve hostname')) error = `Could not resolve hostname "${host}"`;
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

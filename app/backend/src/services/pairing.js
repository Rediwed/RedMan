// Peer pairing service — Noise XX-style handshake with accept/decline flow
//
// Flow:
// 1. Initiator clicks "Connect" on a discovered peer
// 2. Initiator generates ephemeral X25519 keypair, signs with static Ed25519 identity
// 3. POSTs { ephemeral_pubkey, static_pubkey, signature, token } to remote /peer/pair/request
// 4. Remote validates signature, stores request as "pending", sends SSE notification
// 5. Remote user clicks Accept → generates own ephemeral keypair, computes ECDH shared secret
// 6. Derives API key + encryption key via HKDF, encrypts callback payload with secretbox
// 7. Sends callback: { ephemeral_pubkey, static_pubkey, signature, encrypted_payload, nonce }
// 8. Initiator verifies, computes same ECDH, derives same API key — no key ever sent in cleartext
//
// Security properties:
//   - Forward secrecy: ephemeral X25519 keys are single-use
//   - Mutual authentication: Ed25519 signatures on both sides
//   - No key transmission: API key derived via ECDH + HKDF, never crosses the wire
//   - Replay prevention: ephemeral keys + token nonce ensure uniqueness

import { randomBytes } from 'crypto';
import db from '../db.js';
import { hasKey, getPublicKey, generateKey, replaceKeyAuthorization } from './sshManager.js';
import { assertFingerprintConfirmed, findExistingPeer, isPairingExpired } from './pairingState.js';
import { validatePrivatePeerBaseUrl } from './peerUrlPolicy.js';
import { resolveCallbackUrl } from './callbackAddress.js';
import { fetchWithoutRedirect } from './httpPolicy.js';
import { storeIncomingPairingRequest } from './pairingIngress.js';
import {
  encryptPeerApiKey,
  hashPeerApiKey,
  hashedPeerKeyMarker,
} from './peerSecrets.js';
import {
  prepareRequest, validateRequest, prepareCallback, processCallback,
  getFingerprint, getStaticPubKey, HANDSHAKE_VERSION,
} from './handshake.js';

const PAIRING_TIMEOUT_MS = 10 * 60_000; // 10 minutes

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row?.value || '';
}

// ── Initiator side ────────────────────────────────────────────────

// Start a pairing request to a remote peer (called from main API)
export async function initiatePairing(remoteUrl) {
  remoteUrl = validatePrivatePeerBaseUrl(remoteUrl);
  // Ensure we have an SSH key
  if (!hasKey()) {
    await generateKey();
  }

  const token = randomBytes(32).toString('hex');
  const instanceName = getSetting('instance_name') || 'RedMan';
  const sshPubKey = getPublicKey();

  // Determine our callback URL — explicit setting, the declared PEER_HOST, then
  // the host's own interfaces.
  const callbackUrl = resolveCallbackUrl({
    peerPort: getSetting('peer_api_port') || '8091',
    explicitUrl: getSetting('peer_api_url'),
  });

  const { requestBody, ephemeralSecret } = prepareRequest(
    instanceName,
    token,
    sshPubKey,
    callbackUrl,
  );

  // Store outgoing request with ephemeral secret (needed to process callback later)
  const result = db.prepare(`
    INSERT INTO pairing_requests (direction, token, remote_instance, remote_url, status,
      handshake_version, ephemeral_secret)
    VALUES ('outgoing', ?, ?, ?, 'pending', ?, ?)
  `).run(token, '(discovering)', remoteUrl, HANDSHAKE_VERSION,
    Buffer.from(ephemeralSecret).toString('base64'));

  const requestId = result.lastInsertRowid;

  // POST to the remote's peer API
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);

    const res = await fetchWithoutRedirect(`${remoteUrl}/peer/pair/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify(requestBody),
    });

    clearTimeout(timer);

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      db.prepare('UPDATE pairing_requests SET status = ?, error = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run('failed', err.error || 'Remote rejected request', requestId);
      return { id: requestId, status: 'failed', error: err.error };
    }

    const data = await res.json();
    // Update with remote instance name
    db.prepare('UPDATE pairing_requests SET remote_instance = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(data.remote_instance || '(unknown)', requestId);

    return {
      id: requestId,
      status: 'pending',
      remote_instance: data.remote_instance,
      local_fingerprint: getFingerprint(requestBody.static_pubkey),
    };
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'Connection timed out' : err.message;
    db.prepare('UPDATE pairing_requests SET status = ?, error = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run('failed', msg, requestId);
    return { id: requestId, status: 'failed', error: msg };
  }
}

// Get status of an outgoing pairing request (polled by frontend)
export function getOutgoingPairingStatus(id) {
  const req = db.prepare('SELECT * FROM pairing_requests WHERE id = ? AND direction = ?').get(id, 'outgoing');
  if (!req) return null;

  // Check expiry
  if (req.status === 'pending' && new Date(req.expires_at + 'Z') < new Date()) {
    req.status = 'expired';
    req.error = 'Pairing request expired (10 minutes)';
  }

  // Mask the token, api_key, and ephemeral_secret in the response
    return {
      ...req,
      token: undefined,
      api_key: undefined,
      api_key_encrypted: req.api_key_encrypted ? '••••••••' : null,
      ephemeral_secret: undefined,
    };
}

// Handle the callback from the remote peer when they accept (called from peer API)
// V2: Verifies signature, computes ECDH, derives API key — no key transmitted
export function handlePairingCallback(callbackBody) {
  const { token } = callbackBody;
  const req = db.prepare('SELECT * FROM pairing_requests WHERE token = ? AND direction = ?').get(token, 'outgoing');
  if (!req) return { error: 'Unknown pairing token' };
  if (req.status !== 'pending') return { error: `Pairing already ${req.status}` };

  // Check expiry
  if (new Date(req.expires_at + 'Z') < new Date()) {
    return { error: 'Pairing request expired' };
  }

  // Recover our ephemeral secret key
  if (!req.ephemeral_secret) {
    return { error: 'Missing ephemeral secret — cannot complete handshake' };
  }
  const ourEphemeralSecret = new Uint8Array(Buffer.from(req.ephemeral_secret, 'base64'));

  // Verify signature, compute ECDH, derive API key, decrypt payload
  const result = processCallback(callbackBody, ourEphemeralSecret, token, getStaticPubKey());
  if (!result.valid) {
    db.prepare('UPDATE pairing_requests SET status = ?, error = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run('failed', result.error, req.id);
    return { error: result.error };
  }

  // Payload contains: { ssh_public_key, instance, storage_limit_bytes, allowed_path_prefix }
  const { apiKey, payload, fingerprint } = result;
  const encryptedApiKey = encryptPeerApiKey(apiKey);

  // Store the derived API key (for making requests TO the remote) — zeroise ephemeral secret
  db.prepare(`
    UPDATE pairing_requests SET
      status = 'accepted', api_key = NULL, api_key_encrypted = ?, remote_ssh_pubkey = ?,
      remote_instance = COALESCE(?, remote_instance),
      remote_storage_limit = ?, remote_allowed_path = ?,
      remote_static_pubkey = ?, remote_fingerprint = ?,
      ephemeral_secret = NULL,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(encryptedApiKey, payload.ssh_public_key, payload.instance,
    payload.storage_limit_bytes || 0, payload.allowed_path_prefix || '/',
    result.remoteStaticPubKey, fingerprint, req.id);

  console.log(`[pairing] Handshake complete with "${payload.instance}" (${fingerprint}) — API key derived, never transmitted`);
  return { ok: true };
}

// ── Receiver side ─────────────────────────────────────────────────

// Receive an incoming pairing request (called from peer API, unauthenticated)
// V3: validates the full signed request transcript against the static identity.
export function receiveRequest(body, callbackUrl, ip) {
  const instanceName = getSetting('instance_name') || 'RedMan';

  // Validate handshake: verify signature on ephemeral key
  const validation = validateRequest(body);
  if (!validation.valid) {
    if (validation.error === 'upgrade_required') {
      return { error: `Handshake version ${HANDSHAKE_VERSION} required — upgrade RedMan`, status: 426 };
    }
    return { error: validation.error, status: 400 };
  }

  const stored = storeIncomingPairingRequest(db, {
    token: body.token,
    instance: body.instance,
    callbackUrl,
    sshPublicKey: body.ssh_public_key,
    handshakeVersion: HANDSHAKE_VERSION,
    ephemeralPublicKey: body.ephemeral_pubkey,
    staticPublicKey: body.static_pubkey,
    fingerprint: validation.fingerprint,
  });
  if (stored.error) return stored;

  console.log(`[pairing] Incoming v${HANDSHAKE_VERSION} pairing request from "${body.instance}" (${ip}, fingerprint: ${validation.fingerprint})`);

  return { ok: true, remote_instance: instanceName };
}

// List pending incoming requests (for the UI)
export function getPendingIncoming() {
  return db.prepare(`
    SELECT id, remote_instance, remote_url, status, remote_fingerprint, created_at, expires_at
    FROM pairing_requests
    WHERE direction = 'incoming' AND status = 'pending' AND expires_at >= datetime('now')
    ORDER BY created_at DESC
  `).all();
}

// Get all pairing requests (for settings/history)
export function getAllPairingRequests() {
  return db.prepare(`
    SELECT id, direction, remote_instance, remote_url, status, error, created_at, updated_at
    FROM pairing_requests ORDER BY created_at DESC LIMIT 20
  `).all();
}

// Accept an incoming pairing request
// V3: signs the full callback transcript, derives the API key, and encrypts the payload.
export async function acceptPairing(id, access, confirmedFingerprint) {
  const req = db.prepare('SELECT * FROM pairing_requests WHERE id = ? AND direction = ?').get(id, 'incoming');
  if (!req) return { error: 'Pairing request not found' };
  if (req.status !== 'pending') return { error: `Already ${req.status}` };
  try {
    assertFingerprintConfirmed(req.remote_fingerprint, confirmedFingerprint);
  } catch (err) {
    return { error: err.message };
  }

  // Check expiry
  if (isPairingExpired(req.expires_at)) {
    return { error: 'Pairing request expired' };
  }

  // Mark as accepting after validation to prevent a double-click race.
  db.prepare('UPDATE pairing_requests SET status = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run('accepting', id);

  let callbackBody;
  let derivedApiKey;
  let peerId;

  try {

  // Ensure we have an SSH key
  if (!hasKey()) {
    await generateKey();
  }

  // Prepare the handshake callback — ECDH + HKDF derives the API key
  const sshPubKey = getPublicKey();
  const instanceName = getSetting('instance_name') || 'RedMan';

  if (!req.remote_ephemeral_pubkey || !req.token) {
    db.prepare('UPDATE pairing_requests SET status = ?, error = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run('failed', 'Missing handshake data — peer may need to re-send the pairing request', id);
    return { error: 'Missing handshake data — peer may need to re-send the pairing request' };
  }

  const callbackPayload = {
    ssh_public_key: sshPubKey,
    instance: instanceName,
    storage_limit_bytes: access.storageLimitBytes,
    allowed_path_prefix: access.allowedPathPrefix,
  };

  ({ callbackBody, derivedApiKey } = prepareCallback(req, callbackPayload));
  const derivedApiKeyHash = hashPeerApiKey(derivedApiKey);

  // Create or replace authorized peer with the derived API key
  const remoteIp = extractIp(req.remote_url);
  const existingPeer = findExistingPeer(db, req.remote_static_pubkey, req.remote_instance);

  if (req.remote_ssh_pubkey) {
    try {
      replaceKeyAuthorization(existingPeer?.ssh_public_key, req.remote_ssh_pubkey, {
        allowedPathPrefix: access.allowedPathPrefix,
        sourceIp: remoteIp,
      });
    } catch (err) {
      db.prepare('UPDATE pairing_requests SET status = ?, error = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run('failed', `SSH key restriction failed: ${err.message}`, id);
      return { error: `SSH key restriction failed: ${err.message}` };
    }
  }

  if (existingPeer) {
    db.prepare(`
      UPDATE authorized_peers SET api_key = ?, last_seen_ip = ?, enabled = 1,
        api_key_hash = ?, static_pubkey = ?, allowed_path_prefix = ?, storage_limit_bytes = ?,
        ssh_public_key = COALESCE(?, ssh_public_key),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(hashedPeerKeyMarker(derivedApiKeyHash), remoteIp, derivedApiKeyHash, req.remote_static_pubkey,
      access.allowedPathPrefix, access.storageLimitBytes, req.remote_ssh_pubkey || null, existingPeer.id);
    peerId = existingPeer.id;
    console.log(`[pairing] Replaced existing peer "${req.remote_instance}" (#${peerId}) with ECDH-derived key`);
  } else {
    const peerResult = db.prepare(`
      INSERT INTO authorized_peers
        (name, api_key, api_key_hash, allowed_path_prefix, storage_limit_bytes, last_seen_ip, static_pubkey, ssh_public_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.remote_instance, hashedPeerKeyMarker(derivedApiKeyHash), derivedApiKeyHash,
      access.allowedPathPrefix, access.storageLimitBytes, remoteIp, req.remote_static_pubkey,
      req.remote_ssh_pubkey || null);
    peerId = peerResult.lastInsertRowid;
  }

  } catch (err) {
    const msg = err.message || 'Pairing acceptance failed';
    db.prepare('UPDATE pairing_requests SET status = ?, error = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run('failed', msg, id);
    return { error: msg };
  }

  // Send encrypted callback to the initiator
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);

    const callbackBase = validatePrivatePeerBaseUrl(req.remote_url, 'Stored callback URL');
    const res = await fetchWithoutRedirect(`${callbackBase}/peer/pair/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify(callbackBody),
    });

    clearTimeout(timer);

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Callback failed' }));
      db.prepare('UPDATE pairing_requests SET status = ?, error = ?, peer_id = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run('failed', `Callback failed: ${err.error}`, peerId, id);
      return { error: `Callback to initiator failed: ${err.error}` };
    }

    db.prepare('UPDATE pairing_requests SET status = ?, peer_id = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run('accepted', peerId, id);

    console.log(`[pairing] Accepted pairing from "${req.remote_instance}" (${req.remote_fingerprint}) — peer #${peerId}, key derived via ECDH`);
    return { ok: true, peer_id: peerId };
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'Callback timed out' : err.message;
    db.prepare('UPDATE pairing_requests SET status = ?, error = ?, peer_id = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run('failed', msg, peerId, id);
    return { error: msg };
  }
}

// Decline an incoming pairing request
export function declinePairing(id) {
  const req = db.prepare('SELECT * FROM pairing_requests WHERE id = ? AND direction = ?').get(id, 'incoming');
  if (!req) return { error: 'Pairing request not found' };
  if (req.status !== 'pending') return { error: `Already ${req.status}` };

  db.prepare('UPDATE pairing_requests SET status = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run('declined', id);

  console.log(`[pairing] Declined pairing from "${req.remote_instance}"`);
  return { ok: true };
}

// ── Helpers ───────────────────────────────────────────────────────

function extractIp(url) {
  try {
    const u = new URL(url);
    return u.hostname;
  } catch {
    return null;
  }
}

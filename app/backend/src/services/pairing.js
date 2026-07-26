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
import { validatePairingAccess } from './peerAccessPolicy.js';
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
// `reciprocalOffer` optionally grants the remote backup space on this instance in the
// same handshake, so the operators do not have to repeat the flow in the other direction.
export async function initiatePairing(remoteUrl, reciprocalOffer = null) {
  remoteUrl = validatePrivatePeerBaseUrl(remoteUrl);
  // Ensure we have an SSH key
  if (!hasKey()) {
    await generateKey();
  }

  const offer = reciprocalOffer
    ? validatePairingAccess(reciprocalOffer.allowed_path_prefix, reciprocalOffer.storage_limit_bytes)
    : null;

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
    offer && { allowed_path_prefix: offer.allowedPathPrefix, storage_limit_bytes: offer.storageLimitBytes },
  );

  // Store outgoing request with ephemeral secret (needed to process callback later)
  const result = db.prepare(`
    INSERT INTO pairing_requests (direction, token, remote_instance, remote_url, status,
      handshake_version, ephemeral_secret, reciprocal_path, reciprocal_limit_bytes)
    VALUES ('outgoing', ?, ?, ?, 'pending', ?, ?, ?, ?)
  `).run(token, '(discovering)', remoteUrl, HANDSHAKE_VERSION,
    Buffer.from(ephemeralSecret).toString('base64'),
    offer?.allowedPathPrefix || null, offer?.storageLimitBytes || null);

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

  // Payload contains: { ssh_public_key, instance, storage_limit_bytes, allowed_path_prefix, reciprocal_accepted }
  const { apiKey, reverseApiKey, payload, fingerprint } = result;
  const encryptedApiKey = encryptPeerApiKey(apiKey);

  // Honour our own signed offer — only when we actually made one and they took it up
  let reciprocalGranted = false;
  if (payload.reciprocal_accepted === true && req.reciprocal_path && req.reciprocal_limit_bytes > 0) {
    try {
      grantReciprocalAccess(req, payload, reverseApiKey, result.remoteStaticPubKey);
      reciprocalGranted = true;
    } catch (err) {
      db.prepare('UPDATE pairing_requests SET status = ?, error = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run('failed', `Reciprocal access grant failed: ${err.message}`, req.id);
      return { error: `Reciprocal access grant failed: ${err.message}` };
    }
  }

  // Store the derived API key (for making requests TO the remote) — zeroise ephemeral secret
  db.prepare(`
    UPDATE pairing_requests SET
      status = 'accepted', api_key = NULL, api_key_encrypted = ?, remote_ssh_pubkey = ?,
      remote_instance = COALESCE(?, remote_instance),
      remote_storage_limit = ?, remote_allowed_path = ?,
      remote_static_pubkey = ?, remote_fingerprint = ?,
      ephemeral_secret = NULL, reciprocal_accepted = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(encryptedApiKey, payload.ssh_public_key, payload.instance,
    payload.storage_limit_bytes || 0, payload.allowed_path_prefix || '/',
    result.remoteStaticPubKey, fingerprint, reciprocalGranted ? 1 : 0, req.id);

  console.log(`[pairing] Handshake complete with "${payload.instance}" (${fingerprint}) — API key derived, never transmitted${reciprocalGranted ? '; reverse access granted' : ''}`);
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
    reciprocalPath: body.reciprocal_offer?.allowed_path_prefix,
    reciprocalLimitBytes: body.reciprocal_offer?.storage_limit_bytes,
  });
  if (stored.error) return stored;

  console.log(`[pairing] Incoming v${HANDSHAKE_VERSION} pairing request from "${body.instance}" (${ip}, fingerprint: ${validation.fingerprint})`);

  return { ok: true, remote_instance: instanceName };
}

// List pending incoming requests (for the UI)
export function getPendingIncoming() {
  return db.prepare(`
    SELECT id, remote_instance, remote_url, status, remote_fingerprint, created_at, expires_at,
           reciprocal_path, reciprocal_limit_bytes
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
export async function acceptPairing(id, access, confirmedFingerprint, acceptReciprocal = false) {
  const req = db.prepare('SELECT * FROM pairing_requests WHERE id = ? AND direction = ?').get(id, 'incoming');
  if (!req) return { error: 'Pairing request not found' };
  if (req.status !== 'pending') return { error: `Already ${req.status}` };
  try {
    assertFingerprintConfirmed(req.remote_fingerprint, confirmedFingerprint);
  } catch (err) {
    return { error: err.message };
  }

  // Only honour a reciprocal offer that the peer actually signed into its request
  const offered = Boolean(req.reciprocal_path && req.reciprocal_limit_bytes > 0);
  const reciprocal = Boolean(acceptReciprocal) && offered;
  if (acceptReciprocal && !offered) {
    return { error: 'This peer did not offer backup space in return' };
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
  let derivedReverseApiKey;
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
    reciprocal_accepted: reciprocal,
  };

  ({ callbackBody, derivedApiKey, derivedReverseApiKey } = prepareCallback(req, callbackPayload));
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

    db.prepare('UPDATE pairing_requests SET status = ?, peer_id = ?, reciprocal_accepted = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run('accepted', peerId, reciprocal ? 1 : 0, id);

    // The initiator registered our reverse grant while handling the callback, so only
    // now is it safe to record the destination it offered us.
    if (reciprocal) {
      try {
        recordReciprocalDestination(req, derivedReverseApiKey);
      } catch (err) {
        console.error(`[pairing] Reverse destination for "${req.remote_instance}" could not be stored:`, err.message);
      }
    }

    console.log(`[pairing] Accepted pairing from "${req.remote_instance}" (${req.remote_fingerprint}) — peer #${peerId}, key derived via ECDH${reciprocal ? ', reverse direction enabled' : ''}`);
    return { ok: true, peer_id: peerId, reciprocal };
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

// Receiver side: record the backup space the initiator granted us as a destination.
// Destinations live as accepted outgoing pairing rows, so no extra table is needed.
function recordReciprocalDestination(req, reverseApiKey) {
  db.prepare(`
    INSERT INTO pairing_requests (direction, token, remote_instance, remote_url, status,
      handshake_version, api_key_encrypted, remote_ssh_pubkey, remote_static_pubkey,
      remote_fingerprint, remote_allowed_path, remote_storage_limit, reciprocal_accepted)
    VALUES ('outgoing', ?, ?, ?, 'accepted', ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    randomBytes(32).toString('hex'),
    req.remote_instance,
    req.remote_url,
    HANDSHAKE_VERSION,
    encryptPeerApiKey(reverseApiKey),
    req.remote_ssh_pubkey,
    req.remote_static_pubkey,
    req.remote_fingerprint,
    req.reciprocal_path,
    req.reciprocal_limit_bytes,
  );
  console.log(`[pairing] Reverse destination stored for "${req.remote_instance}" (${req.reciprocal_path})`);
}

// Initiator side: honour the offer we signed by authorising the remote to back up here.
function grantReciprocalAccess(req, payload, reverseApiKey, remoteStaticPubKey) {
  const access = validatePairingAccess(req.reciprocal_path, req.reciprocal_limit_bytes);
  const reverseKeyHash = hashPeerApiKey(reverseApiKey);
  const remoteIp = extractIp(req.remote_url);
  const existingPeer = findExistingPeer(db, remoteStaticPubKey, req.remote_instance);

  if (payload.ssh_public_key) {
    replaceKeyAuthorization(existingPeer?.ssh_public_key, payload.ssh_public_key, {
      allowedPathPrefix: access.allowedPathPrefix,
      sourceIp: remoteIp,
    });
  }

  if (existingPeer) {
    db.prepare(`
      UPDATE authorized_peers SET api_key = ?, last_seen_ip = ?, enabled = 1,
        api_key_hash = ?, static_pubkey = ?, allowed_path_prefix = ?, storage_limit_bytes = ?,
        ssh_public_key = COALESCE(?, ssh_public_key),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(hashedPeerKeyMarker(reverseKeyHash), remoteIp, reverseKeyHash, remoteStaticPubKey,
      access.allowedPathPrefix, access.storageLimitBytes, payload.ssh_public_key || null, existingPeer.id);
    return existingPeer.id;
  }

  const inserted = db.prepare(`
    INSERT INTO authorized_peers
      (name, api_key, api_key_hash, allowed_path_prefix, storage_limit_bytes, last_seen_ip, static_pubkey, ssh_public_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(payload.instance || req.remote_instance, hashedPeerKeyMarker(reverseKeyHash), reverseKeyHash,
    access.allowedPathPrefix, access.storageLimitBytes, remoteIp, remoteStaticPubKey,
    payload.ssh_public_key || null);
  return Number(inserted.lastInsertRowid);
}

function extractIp(url) {
  try {
    const u = new URL(url);
    return u.hostname;
  } catch {
    return null;
  }
}

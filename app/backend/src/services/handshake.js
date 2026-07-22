// Noise XX-style handshake for peer pairing
//
// Eliminates cleartext API key transmission by deriving shared secrets via ECDH.
// Uses X25519 for ephemeral key exchange, Ed25519 for static identity signatures.
//
// Protocol:
//   1. Initiator → Receiver: signed canonical request transcript
//   2. Receiver accepts in UI, computes ECDH shared secret, derives api_key
//   3. Receiver → Initiator: signed canonical callback transcript + encrypted payload
//   4. Initiator verifies, computes same shared secret, derives same api_key
//
// Security properties:
//   - Forward secrecy: ephemeral keys are single-use, discarded after derivation
//   - Mutual authentication: both sides sign ephemeral keys with static identity
//   - No key transmission: api_key is HKDF-derived from ECDH, never sent over the wire
//   - Replay prevention: ephemeral keys + token nonce ensure uniqueness per attempt

import nacl from 'tweetnacl';
import { hkdfSync, randomBytes } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

const IDENTITY_FILENAME = 'identity.json';
const HANDSHAKE_VERSION = 3;
const MAX_INSTANCE_LENGTH = 128;
const MAX_CALLBACK_URL_LENGTH = 512;
const MAX_SSH_PUBLIC_KEY_LENGTH = 2_048;
const MAX_ENCRYPTED_PAYLOAD_BYTES = 8_192;

function boundedText(value, maximum, { minimum = 1, trim = true } = {}) {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) return false;
  if (trim && value !== value.trim()) return false;
  return !/[\u0000-\u001f\u007f]/.test(value);
}

function exactHex(value, bytes) {
  return typeof value === 'string' && new RegExp(`^[a-f0-9]{${bytes * 2}}$`).test(value);
}

function canonicalBase64(value, { exactBytes, maximumBytes = exactBytes } = {}) {
  if (typeof value !== 'string' || value.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) return false;
  if (exactBytes !== undefined && decoded.length !== exactBytes) return false;
  return maximumBytes === undefined || decoded.length <= maximumBytes;
}

export function validatePairingRequestEnvelope(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Pairing request must be a JSON object';
  if (!Number.isInteger(body.version) || body.version !== HANDSHAKE_VERSION || body.role !== 'initiator') {
    return 'Unsupported handshake version or role';
  }
  if (!boundedText(body.instance, MAX_INSTANCE_LENGTH)) return 'Invalid pairing instance';
  if (!exactHex(body.token, 32)) return 'Invalid pairing token';
  if (!boundedText(body.callback_url, MAX_CALLBACK_URL_LENGTH)) return 'Invalid pairing callback URL';
  if (!boundedText(body.ssh_public_key, MAX_SSH_PUBLIC_KEY_LENGTH, { trim: false })) return 'Invalid SSH public key';
  if (!canonicalBase64(body.ephemeral_pubkey, { exactBytes: 32 })) return 'Invalid ephemeral public key';
  if (!canonicalBase64(body.static_pubkey, { exactBytes: 32 })) return 'Invalid static public key';
  if (!canonicalBase64(body.signature, { exactBytes: 64 })) return 'Invalid pairing signature';
  return null;
}

export function validatePairingCallbackEnvelope(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Pairing callback must be a JSON object';
  if (!Number.isInteger(body.version) || body.version !== HANDSHAKE_VERSION || body.role !== 'receiver') {
    return 'Unsupported handshake version or role';
  }
  if (!exactHex(body.token, 32)) return 'Invalid pairing token';
  if (!canonicalBase64(body.request_static_pubkey, { exactBytes: 32 })) return 'Invalid initiator public key';
  if (!canonicalBase64(body.ephemeral_pubkey, { exactBytes: 32 })) return 'Invalid ephemeral public key';
  if (!canonicalBase64(body.static_pubkey, { exactBytes: 32 })) return 'Invalid static public key';
  if (!canonicalBase64(body.signature, { exactBytes: 64 })) return 'Invalid pairing signature';
  if (!canonicalBase64(body.encrypted_payload, { maximumBytes: MAX_ENCRYPTED_PAYLOAD_BYTES })) return 'Invalid encrypted payload';
  if (!canonicalBase64(body.nonce, { exactBytes: 24 })) return 'Invalid pairing nonce';
  return null;
}

// ── Identity key management ──────────────────────────────────────

function getIdentityPath() {
  const dataDir = process.env.DB_PATH
    ? dirname(process.env.DB_PATH)
    : join(dirname(new URL(import.meta.url).pathname), '..', '..', 'data');
  return join(dataDir, IDENTITY_FILENAME);
}

/** Generate a new Ed25519 static identity keypair. */
export function generateIdentity() {
  const path = getIdentityPath();
  if (existsSync(path)) {
    throw new Error('Identity key already exists. Delete it first to regenerate.');
  }

  mkdirSync(dirname(path), { recursive: true });
  const kp = nacl.sign.keyPair();

  writeFileSync(path, JSON.stringify({
    publicKey: Buffer.from(kp.publicKey).toString('base64'),
    secretKey: Buffer.from(kp.secretKey).toString('base64'),
  }), { mode: 0o600 });

  console.log(`[handshake] Generated static identity key: ${getFingerprint(kp.publicKey)}`);
  return { publicKey: kp.publicKey, secretKey: kp.secretKey };
}

/** Load the static identity keypair, generating if it doesn't exist. */
export function getIdentity() {
  const path = getIdentityPath();
  if (!existsSync(path)) {
    return generateIdentity();
  }

  const data = JSON.parse(readFileSync(path, 'utf-8'));
  return {
    publicKey: new Uint8Array(Buffer.from(data.publicKey, 'base64')),
    secretKey: new Uint8Array(Buffer.from(data.secretKey, 'base64')),
  };
}

/** Get the static public key as base64. */
export function getStaticPubKey() {
  return Buffer.from(getIdentity().publicKey).toString('base64');
}

/** Compute a human-readable fingerprint of a public key (first 16 hex chars). */
export function getFingerprint(pubKeyBytes) {
  const bytes = pubKeyBytes instanceof Uint8Array
    ? pubKeyBytes
    : new Uint8Array(Buffer.from(pubKeyBytes, 'base64'));
  return Buffer.from(bytes.slice(0, 8)).toString('hex').toUpperCase().match(/.{4}/g).join(':');
}

/** Check if the static identity key exists. */
export function hasIdentity() {
  return existsSync(getIdentityPath());
}

// ── Ephemeral key generation ─────────────────────────────────────

/** Generate an ephemeral X25519 keypair for a single handshake. */
export function generateEphemeral() {
  const kp = nacl.box.keyPair();
  return { publicKey: kp.publicKey, secretKey: kp.secretKey };
}

// ── Canonical transcript signing ─────────────────────────────────

function encodeTranscript(fields) {
  return new TextEncoder().encode(JSON.stringify(fields));
}

export function buildRequestTranscript(body) {
  return encodeTranscript([
    'redman-pairing-v3',
    'request',
    body.version,
    body.token,
    body.instance,
    body.callback_url,
    body.ssh_public_key || '',
    body.ephemeral_pubkey,
    body.static_pubkey,
  ]);
}

export function buildCallbackTranscript(body) {
  return encodeTranscript([
    'redman-pairing-v3',
    'callback',
    body.version,
    body.token,
    body.request_static_pubkey,
    body.ephemeral_pubkey,
    body.static_pubkey,
    body.encrypted_payload,
    body.nonce,
  ]);
}

export function signPairingTranscript(transcript, staticSecretKey) {
  return nacl.sign.detached(transcript, staticSecretKey);
}

export function verifyPairingTranscript(transcript, signature, staticPubKey) {
  const sig = signature instanceof Uint8Array
    ? signature
    : new Uint8Array(Buffer.from(signature, 'base64'));
  const sPub = staticPubKey instanceof Uint8Array
    ? staticPubKey
    : new Uint8Array(Buffer.from(staticPubKey, 'base64'));
  return nacl.sign.detached.verify(transcript, sig, sPub);
}

// ── ECDH + Key derivation ────────────────────────────────────────

/**
 * Compute X25519 ECDH shared secret from our ephemeral private key
 * and the remote's ephemeral public key.
 */
export function computeSharedSecret(ourEphemeralSecretKey, remoteEphemeralPubKey) {
  const remote = remoteEphemeralPubKey instanceof Uint8Array
    ? remoteEphemeralPubKey
    : new Uint8Array(Buffer.from(remoteEphemeralPubKey, 'base64'));

  return nacl.scalarMult(ourEphemeralSecretKey, remote);
}

/**
 * Derive keys from the ECDH shared secret using HKDF-SHA256.
 * Returns { apiKey, encryptionKey } — both as hex/Uint8Array.
 *
 * @param {Uint8Array} sharedSecret — raw X25519 output (32 bytes)
 * @param {string} token — pairing token (hex string, used as salt)
 * @returns {{ apiKey: string, encryptionKey: Uint8Array }}
 */
export function deriveKeys(sharedSecret, token) {
  const salt = Buffer.from(token, 'hex');

  // Derive API key (32 bytes → 64-char hex string, matches existing key format)
  const apiKeyBuf = hkdfSync('sha256', sharedSecret, salt, 'redman-api-key-v2', 32);
  const apiKey = Buffer.from(apiKeyBuf).toString('hex');

  // Derive encryption key for secretbox (32 bytes)
  const encKeyBuf = hkdfSync('sha256', sharedSecret, salt, 'redman-payload-key-v2', 32);
  const encryptionKey = new Uint8Array(encKeyBuf);

  return { apiKey, encryptionKey };
}

// ── Secretbox encryption ─────────────────────────────────────────

/**
 * Encrypt a JSON payload using NaCl secretbox (XSalsa20-Poly1305).
 * Returns { ciphertext, nonce } as base64 strings.
 */
export function encryptPayload(payload, encryptionKey) {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const message = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = nacl.secretbox(message, nonce, encryptionKey);

  return {
    ciphertext: Buffer.from(ciphertext).toString('base64'),
    nonce: Buffer.from(nonce).toString('base64'),
  };
}

/**
 * Decrypt a secretbox-encrypted payload.
 * Returns the parsed JSON object, or null if decryption fails.
 */
export function decryptPayload(ciphertextB64, nonceB64, encryptionKey) {
  const ciphertext = new Uint8Array(Buffer.from(ciphertextB64, 'base64'));
  const nonce = new Uint8Array(Buffer.from(nonceB64, 'base64'));

  const plaintext = nacl.secretbox.open(ciphertext, nonce, encryptionKey);
  if (!plaintext) return null;

  return JSON.parse(new TextDecoder().decode(plaintext));
}

// ── High-level handshake helpers ─────────────────────────────────

/**
 * Prepare the initiator's pairing request payload.
 * Generates ephemeral X25519 keypair, signs it with static Ed25519 identity.
 *
 * @param {string} instanceName — our instance name
 * @param {string} token — random hex pairing token
 * @param {string|null} sshPubKey — our SSH public key (sent plaintext, it's public)
 * @returns {{ requestBody: object, ephemeralSecret: Uint8Array }}
 */
export function prepareRequest(instanceName, token, sshPubKey, callbackUrl) {
  const identity = getIdentity();
  const ephemeral = generateEphemeral();

  const requestBody = {
    version: HANDSHAKE_VERSION,
    role: 'initiator',
    instance: instanceName,
    token,
    callback_url: callbackUrl,
    ephemeral_pubkey: Buffer.from(ephemeral.publicKey).toString('base64'),
    static_pubkey: Buffer.from(identity.publicKey).toString('base64'),
    ssh_public_key: sshPubKey,
  };
  requestBody.signature = Buffer.from(
    signPairingTranscript(buildRequestTranscript(requestBody), identity.secretKey),
  ).toString('base64');

  return { requestBody, ephemeralSecret: ephemeral.secretKey };
}

/**
 * Process an incoming pairing request (receiver side).
 * Validates the request format and signature.
 *
 * @param {object} body — the request body
 * @returns {{ valid: boolean, error?: string, remoteStaticPubKey?: string, fingerprint?: string }}
 */
export function validateRequest(body) {
  if (!body.version || body.version < HANDSHAKE_VERSION) {
    return { valid: false, error: 'upgrade_required' };
  }
  const envelopeError = validatePairingRequestEnvelope(body);
  if (envelopeError) return { valid: false, error: envelopeError };

  let signatureValid = false;
  try {
    signatureValid = verifyPairingTranscript(buildRequestTranscript(body), body.signature, body.static_pubkey);
  } catch {}
  if (!signatureValid) {
    return { valid: false, error: 'Pairing request transcript signature verification failed' };
  }

  const fingerprint = getFingerprint(body.static_pubkey);
  return { valid: true, remoteStaticPubKey: body.static_pubkey, fingerprint };
}

/**
 * Prepare the receiver's callback response after accepting a pairing request.
 * Generates ephemeral keypair, computes ECDH, derives keys, encrypts payload.
 *
 * @param {object} pairingRequest — the stored pairing request (with remote ephemeral_pubkey, token)
 * @param {object} callbackPayload — data to encrypt { ssh_public_key, instance, storage_limit_bytes, allowed_path_prefix }
 * @returns {{ callbackBody: object, derivedApiKey: string }}
 */
export function prepareCallback(pairingRequest, callbackPayload) {
  const identity = getIdentity();
  const ephemeral = generateEphemeral();

  // ECDH: our ephemeral private × remote ephemeral public
  const sharedSecret = computeSharedSecret(
    ephemeral.secretKey,
    pairingRequest.remote_ephemeral_pubkey,
  );

  // Derive API key + encryption key from shared secret
  const { apiKey, encryptionKey } = deriveKeys(sharedSecret, pairingRequest.token);

  // Encrypt the callback payload
  const { ciphertext, nonce } = encryptPayload(callbackPayload, encryptionKey);

  const callbackBody = {
    version: HANDSHAKE_VERSION,
    role: 'receiver',
    token: pairingRequest.token,
    request_static_pubkey: pairingRequest.remote_static_pubkey,
    ephemeral_pubkey: Buffer.from(ephemeral.publicKey).toString('base64'),
    static_pubkey: Buffer.from(identity.publicKey).toString('base64'),
    encrypted_payload: ciphertext,
    nonce,
  };
  callbackBody.signature = Buffer.from(
    signPairingTranscript(buildCallbackTranscript(callbackBody), identity.secretKey),
  ).toString('base64');

  return { callbackBody, derivedApiKey: apiKey };
}

/**
 * Process the callback on the initiator side.
 * Verifies signatures, computes ECDH, derives keys, decrypts payload.
 *
 * @param {object} callbackBody — the callback response from the receiver
 * @param {Uint8Array} ourEphemeralSecret — our ephemeral private key (saved from prepareRequest)
 * @param {string} expectedToken — the token we sent in the original request
 * @returns {{ valid: boolean, error?: string, apiKey?: string, payload?: object, fingerprint?: string }}
 */
export function processCallback(callbackBody, ourEphemeralSecret, expectedToken, expectedStaticPubKey) {
  if (!callbackBody.version || callbackBody.version < HANDSHAKE_VERSION) {
    return { valid: false, error: 'upgrade_required' };
  }

  const envelopeError = validatePairingCallbackEnvelope(callbackBody);
  if (envelopeError) return { valid: false, error: envelopeError };
  if (callbackBody.token !== expectedToken) {
    return { valid: false, error: 'Token mismatch' };
  }
  if (callbackBody.request_static_pubkey !== expectedStaticPubKey) {
    return { valid: false, error: 'Callback is not bound to this initiator identity' };
  }

  let signatureValid = false;
  try {
    signatureValid = verifyPairingTranscript(buildCallbackTranscript(callbackBody), callbackBody.signature, callbackBody.static_pubkey);
  } catch {}
  if (!signatureValid) {
    return { valid: false, error: 'Pairing callback transcript signature verification failed' };
  }

  // ECDH: our ephemeral private × their ephemeral public
  const sharedSecret = computeSharedSecret(ourEphemeralSecret, callbackBody.ephemeral_pubkey);

  // Derive the same keys
  const { apiKey, encryptionKey } = deriveKeys(sharedSecret, expectedToken);

  // Decrypt the payload
  let payload = null;
  try {
    payload = decryptPayload(callbackBody.encrypted_payload, callbackBody.nonce, encryptionKey);
  } catch {}
  if (!payload) {
    return { valid: false, error: 'Failed to decrypt callback payload — key mismatch' };
  }

  const fingerprint = getFingerprint(callbackBody.static_pubkey);
  return { valid: true, apiKey, payload, fingerprint, remoteStaticPubKey: callbackBody.static_pubkey };
}

export { HANDSHAKE_VERSION };

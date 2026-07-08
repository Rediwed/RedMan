// Noise XX-style handshake for peer pairing
//
// Eliminates cleartext API key transmission by deriving shared secrets via ECDH.
// Uses X25519 for ephemeral key exchange, Ed25519 for static identity signatures.
//
// Protocol:
//   1. Initiator → Receiver: { ephemeral_pubkey, static_pubkey, signature }
//   2. Receiver accepts in UI, computes ECDH shared secret, derives api_key
//   3. Receiver → Initiator: { ephemeral_pubkey, static_pubkey, signature, encrypted_payload }
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
const HANDSHAKE_VERSION = 2;

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

// ── Signing ──────────────────────────────────────────────────────

/**
 * Sign an ephemeral X25519 public key with our static Ed25519 identity key.
 * Returns the detached signature as Uint8Array.
 */
export function signEphemeral(ephemeralPubKey, staticSecretKey) {
  // Sign the raw ephemeral public key bytes
  const fullSig = nacl.sign(ephemeralPubKey, staticSecretKey);
  // Extract just the signature (first 64 bytes of nacl.sign output)
  return fullSig.slice(0, nacl.sign.signatureLength);
}

/**
 * Verify that an ephemeral public key was signed by the given static identity.
 * Returns true if valid.
 */
export function verifyEphemeral(ephemeralPubKey, signature, staticPubKey) {
  const ePub = ephemeralPubKey instanceof Uint8Array
    ? ephemeralPubKey
    : new Uint8Array(Buffer.from(ephemeralPubKey, 'base64'));
  const sig = signature instanceof Uint8Array
    ? signature
    : new Uint8Array(Buffer.from(signature, 'base64'));
  const sPub = staticPubKey instanceof Uint8Array
    ? staticPubKey
    : new Uint8Array(Buffer.from(staticPubKey, 'base64'));

  // Reconstruct the signed message (signature + message) for nacl.sign.open
  const signedMsg = new Uint8Array(sig.length + ePub.length);
  signedMsg.set(sig);
  signedMsg.set(ePub, sig.length);

  return nacl.sign.open(signedMsg, sPub) !== null;
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
export function prepareRequest(instanceName, token, sshPubKey) {
  const identity = getIdentity();
  const ephemeral = generateEphemeral();
  const signature = signEphemeral(ephemeral.publicKey, identity.secretKey);

  const requestBody = {
    version: HANDSHAKE_VERSION,
    instance: instanceName,
    token,
    ephemeral_pubkey: Buffer.from(ephemeral.publicKey).toString('base64'),
    static_pubkey: Buffer.from(identity.publicKey).toString('base64'),
    signature: Buffer.from(signature).toString('base64'),
    ssh_public_key: sshPubKey,
  };

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

  const required = ['ephemeral_pubkey', 'static_pubkey', 'signature', 'token'];
  for (const field of required) {
    if (!body[field]) {
      return { valid: false, error: `Missing required field: ${field}` };
    }
  }

  // Verify the ephemeral key was signed by the claimed static identity
  if (!verifyEphemeral(body.ephemeral_pubkey, body.signature, body.static_pubkey)) {
    return { valid: false, error: 'Ephemeral key signature verification failed' };
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
  const signature = signEphemeral(ephemeral.publicKey, identity.secretKey);

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
    token: pairingRequest.token,
    ephemeral_pubkey: Buffer.from(ephemeral.publicKey).toString('base64'),
    static_pubkey: Buffer.from(identity.publicKey).toString('base64'),
    signature: Buffer.from(signature).toString('base64'),
    encrypted_payload: ciphertext,
    nonce,
  };

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
export function processCallback(callbackBody, ourEphemeralSecret, expectedToken) {
  if (!callbackBody.version || callbackBody.version < HANDSHAKE_VERSION) {
    return { valid: false, error: 'upgrade_required' };
  }

  if (callbackBody.token !== expectedToken) {
    return { valid: false, error: 'Token mismatch' };
  }

  const required = ['ephemeral_pubkey', 'static_pubkey', 'signature', 'encrypted_payload', 'nonce'];
  for (const field of required) {
    if (!callbackBody[field]) {
      return { valid: false, error: `Missing required field: ${field}` };
    }
  }

  // Verify the receiver's ephemeral key was signed by their static identity
  if (!verifyEphemeral(callbackBody.ephemeral_pubkey, callbackBody.signature, callbackBody.static_pubkey)) {
    return { valid: false, error: 'Callback signature verification failed' };
  }

  // ECDH: our ephemeral private × their ephemeral public
  const sharedSecret = computeSharedSecret(ourEphemeralSecret, callbackBody.ephemeral_pubkey);

  // Derive the same keys
  const { apiKey, encryptionKey } = deriveKeys(sharedSecret, expectedToken);

  // Decrypt the payload
  const payload = decryptPayload(callbackBody.encrypted_payload, callbackBody.nonce, encryptionKey);
  if (!payload) {
    return { valid: false, error: 'Failed to decrypt callback payload — key mismatch' };
  }

  const fingerprint = getFingerprint(callbackBody.static_pubkey);
  return { valid: true, apiKey, payload, fingerprint, remoteStaticPubKey: callbackBody.static_pubkey };
}

export { HANDSHAKE_VERSION };

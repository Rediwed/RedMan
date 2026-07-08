#!/usr/bin/env node
// Standalone handshake crypto test — simulates the full Noise XX-style pairing flow
// between two peers using only the primitive functions (no DB, no filesystem identity).
//
// Run: node test/test_handshake.mjs

import { createRequire } from 'module';
import { hkdfSync, randomBytes } from 'crypto';

// Resolve tweetnacl from the app workspace where it's installed
const require = createRequire(new URL('../app/', import.meta.url));
const nacl = require('tweetnacl');

// ── Inline the pure crypto functions (no filesystem deps) ────────

function signEphemeral(ephemeralPubKey, staticSecretKey) {
  const fullSig = nacl.sign(ephemeralPubKey, staticSecretKey);
  return fullSig.slice(0, nacl.sign.signatureLength);
}

function verifyEphemeral(ephemeralPubKeyB64, signatureB64, staticPubKeyB64) {
  const ePub = new Uint8Array(Buffer.from(ephemeralPubKeyB64, 'base64'));
  const sig = new Uint8Array(Buffer.from(signatureB64, 'base64'));
  const sPub = new Uint8Array(Buffer.from(staticPubKeyB64, 'base64'));
  const signedMsg = new Uint8Array(sig.length + ePub.length);
  signedMsg.set(sig);
  signedMsg.set(ePub, sig.length);
  return nacl.sign.open(signedMsg, sPub) !== null;
}

function deriveKeys(sharedSecret, token) {
  const salt = Buffer.from(token, 'hex');
  const apiKeyBuf = hkdfSync('sha256', sharedSecret, salt, 'redman-api-key-v2', 32);
  const apiKey = Buffer.from(apiKeyBuf).toString('hex');
  const encKeyBuf = hkdfSync('sha256', sharedSecret, salt, 'redman-payload-key-v2', 32);
  const encryptionKey = new Uint8Array(encKeyBuf);
  return { apiKey, encryptionKey };
}

function encryptPayload(payload, encryptionKey) {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const message = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = nacl.secretbox(message, nonce, encryptionKey);
  return {
    ciphertext: Buffer.from(ciphertext).toString('base64'),
    nonce: Buffer.from(nonce).toString('base64'),
  };
}

function decryptPayload(ciphertextB64, nonceB64, encryptionKey) {
  const ciphertext = new Uint8Array(Buffer.from(ciphertextB64, 'base64'));
  const nonce = new Uint8Array(Buffer.from(nonceB64, 'base64'));
  const plaintext = nacl.secretbox.open(ciphertext, nonce, encryptionKey);
  if (!plaintext) return null;
  return JSON.parse(new TextDecoder().decode(plaintext));
}

function getFingerprint(pubKeyB64) {
  const bytes = new Uint8Array(Buffer.from(pubKeyB64, 'base64'));
  return Buffer.from(bytes.slice(0, 8)).toString('hex').toUpperCase().match(/.{4}/g).join(':');
}

// ── Test runner ──────────────────────────────────────────────────

let pass = 0;
let fail = 0;

function assert(condition, label) {
  if (condition) {
    pass++;
    console.log(`  ✅ ${label}`);
  } else {
    fail++;
    console.error(`  ❌ ${label}`);
  }
}

// ── Test 1: Full handshake flow ──────────────────────────────────

console.log('\n🔐 Test 1: Full Noise XX handshake flow\n');

// Both peers have static Ed25519 identity keys
const peerA = { static: nacl.sign.keyPair(), name: 'Unraid-Home' };
const peerB = { static: nacl.sign.keyPair(), name: 'Unraid-Offsite' };

// Shared pairing token (normally random, using deterministic for test vectors)
const token = randomBytes(32).toString('hex');
console.log(`  Token: ${token.slice(0, 16)}...`);

// ── Step 1: Initiator (A) prepares request ──

const ephA = nacl.box.keyPair();
const sigA = signEphemeral(ephA.publicKey, peerA.static.secretKey);

const requestBody = {
  version: 2,
  instance: peerA.name,
  token,
  ephemeral_pubkey: Buffer.from(ephA.publicKey).toString('base64'),
  static_pubkey: Buffer.from(peerA.static.publicKey).toString('base64'),
  signature: Buffer.from(sigA).toString('base64'),
  ssh_public_key: 'ssh-ed25519 AAAA... redman@home',
};

console.log(`  A fingerprint: ${getFingerprint(requestBody.static_pubkey)}`);
console.log(`  B fingerprint: ${getFingerprint(Buffer.from(peerB.static.publicKey).toString('base64'))}`);

// ── Step 2: Receiver (B) validates request ──

assert(
  verifyEphemeral(requestBody.ephemeral_pubkey, requestBody.signature, requestBody.static_pubkey),
  'B verifies A\'s ephemeral signature'
);

// ── Step 3: Receiver (B) accepts — generates ephemeral, computes ECDH ──

const ephB = nacl.box.keyPair();
const sigB = signEphemeral(ephB.publicKey, peerB.static.secretKey);

// ECDH: B's ephemeral private × A's ephemeral public
const sharedSecretB = nacl.scalarMult(ephB.secretKey, new Uint8Array(Buffer.from(requestBody.ephemeral_pubkey, 'base64')));
const { apiKey: apiKeyB, encryptionKey: encKeyB } = deriveKeys(sharedSecretB, token);

// Encrypt callback payload
const callbackPayload = {
  ssh_public_key: 'ssh-ed25519 BBBB... redman@offsite',
  instance: peerB.name,
  storage_limit_bytes: 0,
  allowed_path_prefix: '/',
};
const { ciphertext, nonce } = encryptPayload(callbackPayload, encKeyB);

const callbackBody = {
  version: 2,
  token,
  ephemeral_pubkey: Buffer.from(ephB.publicKey).toString('base64'),
  static_pubkey: Buffer.from(peerB.static.publicKey).toString('base64'),
  signature: Buffer.from(sigB).toString('base64'),
  encrypted_payload: ciphertext,
  nonce,
};

console.log(`  API key (B derived): ${apiKeyB.slice(0, 16)}...`);

// ── Step 4: Initiator (A) processes callback ──

assert(
  verifyEphemeral(callbackBody.ephemeral_pubkey, callbackBody.signature, callbackBody.static_pubkey),
  'A verifies B\'s ephemeral signature'
);
assert(callbackBody.token === token, 'Token matches');

// ECDH: A's ephemeral private × B's ephemeral public
const sharedSecretA = nacl.scalarMult(ephA.secretKey, new Uint8Array(Buffer.from(callbackBody.ephemeral_pubkey, 'base64')));
const { apiKey: apiKeyA, encryptionKey: encKeyA } = deriveKeys(sharedSecretA, token);

assert(apiKeyA === apiKeyB, 'Both sides derive the same API key');
assert(
  Buffer.from(encKeyA).toString('hex') === Buffer.from(encKeyB).toString('hex'),
  'Both sides derive the same encryption key'
);

// Decrypt the payload
const decrypted = decryptPayload(callbackBody.encrypted_payload, callbackBody.nonce, encKeyA);
assert(decrypted !== null, 'A decrypts B\'s payload');
assert(decrypted.instance === 'Unraid-Offsite', 'Decrypted instance name matches');
assert(decrypted.ssh_public_key === callbackPayload.ssh_public_key, 'Decrypted SSH key matches');

console.log(`  API key (A derived): ${apiKeyA.slice(0, 16)}...`);
console.log(`  Decrypted payload: ${JSON.stringify(decrypted)}`);

// ── Test 2: Signature verification rejects tampering ─────────────

console.log('\n🔐 Test 2: Tampered signature detection\n');

// Modify ephemeral key but keep original signature → should fail
const tamperedRequest = { ...requestBody };
const fakeEph = nacl.box.keyPair();
tamperedRequest.ephemeral_pubkey = Buffer.from(fakeEph.publicKey).toString('base64');

assert(
  !verifyEphemeral(tamperedRequest.ephemeral_pubkey, tamperedRequest.signature, tamperedRequest.static_pubkey),
  'Tampered ephemeral key rejected'
);

// Wrong static pubkey → should fail
assert(
  !verifyEphemeral(requestBody.ephemeral_pubkey, requestBody.signature, Buffer.from(peerB.static.publicKey).toString('base64')),
  'Wrong static identity rejected'
);

// ── Test 3: Wrong key can't decrypt payload ──────────────────────

console.log('\n🔐 Test 3: Wrong key cannot decrypt\n');

const wrongKey = nacl.randomBytes(32);
const failedDecrypt = decryptPayload(callbackBody.encrypted_payload, callbackBody.nonce, wrongKey);
assert(failedDecrypt === null, 'Decryption with wrong key returns null');

// ── Test 4: Replay — different token produces different keys ─────

console.log('\n🔐 Test 4: Different token produces different keys\n');

const otherToken = randomBytes(32).toString('hex');
const { apiKey: replayApiKey } = deriveKeys(sharedSecretA, otherToken);
assert(replayApiKey !== apiKeyA, 'Different token → different API key');

// ── Test 5: Forward secrecy — different ephemeral = different key ─

console.log('\n🔐 Test 5: Forward secrecy\n');

const ephA2 = nacl.box.keyPair();
const sharedSecretA2 = nacl.scalarMult(ephA2.secretKey, new Uint8Array(Buffer.from(callbackBody.ephemeral_pubkey, 'base64')));
const { apiKey: fsApiKey } = deriveKeys(sharedSecretA2, token);
assert(fsApiKey !== apiKeyA, 'New ephemeral keys → different API key (forward secrecy)');

// ── Test 6: Fingerprint format ───────────────────────────────────

console.log('\n🔐 Test 6: Fingerprint format\n');

const fpA = getFingerprint(requestBody.static_pubkey);
assert(/^[A-F0-9]{4}(:[A-F0-9]{4}){3}$/.test(fpA), `Fingerprint format valid: ${fpA}`);

// ── Test 7: Old-style request rejected ───────────────────────────

console.log('\n🔐 Test 7: Old-style (v1) request detection\n');

const oldStyleRequest = { instance: 'OldPeer', token: 'abc123', callback_url: 'http://1.2.3.4:8091' };
const hasVersion = oldStyleRequest.version && oldStyleRequest.version >= 2;
assert(!hasVersion, 'Old-style request without version field detected');

const v1Request = { ...oldStyleRequest, version: 1 };
assert(v1Request.version < 2, 'v1 request detected as needing upgrade');

// ── Test 8: Deterministic test vector ────────────────────────────

console.log('\n🔐 Test 8: Deterministic HKDF test vector\n');

// Fixed inputs for reproducible output
const fixedSecret = new Uint8Array(32);
fixedSecret.fill(0x42);
const fixedToken = '00'.repeat(32);

const { apiKey: fixedApiKey, encryptionKey: fixedEncKey } = deriveKeys(fixedSecret, fixedToken);

// These values should be the same on every run (deterministic HKDF)
console.log(`  Fixed API key:    ${fixedApiKey}`);
console.log(`  Fixed enc key:    ${Buffer.from(fixedEncKey).toString('hex')}`);

assert(fixedApiKey.length === 64, 'API key is 64 hex chars (256 bits)');
assert(fixedEncKey.length === 32, 'Encryption key is 32 bytes');

// Verify determinism by computing again
const { apiKey: fixedApiKey2 } = deriveKeys(fixedSecret, fixedToken);
assert(fixedApiKey === fixedApiKey2, 'HKDF is deterministic');

// ── Summary ──────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(50)}`);
console.log(`  Results: ${pass} passed, ${fail} failed`);
console.log(`${'═'.repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  buildCallbackTranscript,
  buildRequestTranscript,
  computeSharedSecret,
  deriveKeys,
  encryptPayload,
  generateEphemeral,
  getFingerprint,
  HANDSHAKE_VERSION,
  processCallback,
  signPairingTranscript,
  validatePairingCallbackEnvelope,
  validatePairingRequestEnvelope,
  validateRequest,
  validateReciprocalOffer,
  verifyPairingTranscript,
} from '../app/backend/src/services/handshake.js';

const require = createRequire(new URL('../app/', import.meta.url));
const nacl = require('tweetnacl');
const toBase64 = value => Buffer.from(value).toString('base64');

const initiator = nacl.sign.keyPair();
const receiver = nacl.sign.keyPair();
const initiatorEphemeral = generateEphemeral();
const receiverEphemeral = generateEphemeral();
const token = '42'.repeat(32);

const request = {
  version: HANDSHAKE_VERSION,
  role: 'initiator',
  instance: 'Site A',
  token,
  callback_url: 'http://10.0.0.10:8091',
  ssh_public_key: `ssh-ed25519 ${Buffer.from('initiator-key').toString('base64')} redman@site-a`,
  ephemeral_pubkey: toBase64(initiatorEphemeral.publicKey),
  static_pubkey: toBase64(initiator.publicKey),
};
request.signature = toBase64(signPairingTranscript(buildRequestTranscript(request), initiator.secretKey));

assert.equal(validateRequest(request).valid, true);
assert.equal(validatePairingRequestEnvelope(request), null);
assert.equal(
  verifyPairingTranscript(buildRequestTranscript(request), request.signature, request.static_pubkey),
  true,
);

const requestMutations = {
  version: HANDSHAKE_VERSION + 1,
  role: 'receiver',
  instance: 'Attacker',
  token: '43'.repeat(32),
  callback_url: 'http://100.90.128.99:8091',
  ssh_public_key: `ssh-ed25519 ${Buffer.from('attacker-key').toString('base64')} attacker@host`,
  ephemeral_pubkey: toBase64(generateEphemeral().publicKey),
  static_pubkey: toBase64(receiver.publicKey),
};
for (const [field, value] of Object.entries(requestMutations)) {
  assert.equal(validateRequest({ ...request, [field]: value }).valid, false, `Request mutation accepted: ${field}`);
}
for (const [field, value] of Object.entries({
  instance: 'x'.repeat(129),
  token: '42'.repeat(31),
  callback_url: `http://10.0.0.10/${'x'.repeat(512)}`,
  ssh_public_key: `ssh-ed25519 ${'A'.repeat(2048)}`,
  ephemeral_pubkey: toBase64(nacl.randomBytes(31)),
  static_pubkey: toBase64(nacl.randomBytes(33)),
  signature: toBase64(nacl.randomBytes(63)),
})) {
  assert.notEqual(validatePairingRequestEnvelope({ ...request, [field]: value }), null, `Oversized/malformed request field accepted: ${field}`);
}

const sharedByReceiver = computeSharedSecret(receiverEphemeral.secretKey, request.ephemeral_pubkey);
const { apiKey: receiverApiKey, encryptionKey } = deriveKeys(sharedByReceiver, token);
const payload = {
  instance: 'Site B',
  ssh_public_key: `ssh-ed25519 ${Buffer.from('receiver-key').toString('base64')} redman@site-b`,
  storage_limit_bytes: 1073741824,
  allowed_path_prefix: '/srv/redman-backups/site-a',
};
const encrypted = encryptPayload(payload, encryptionKey);
const callback = {
  version: HANDSHAKE_VERSION,
  role: 'receiver',
  token,
  request_static_pubkey: request.static_pubkey,
  ephemeral_pubkey: toBase64(receiverEphemeral.publicKey),
  static_pubkey: toBase64(receiver.publicKey),
  encrypted_payload: encrypted.ciphertext,
  nonce: encrypted.nonce,
};
callback.signature = toBase64(signPairingTranscript(buildCallbackTranscript(callback), receiver.secretKey));
assert.equal(validatePairingCallbackEnvelope(callback), null);

const processed = processCallback(
  callback,
  initiatorEphemeral.secretKey,
  token,
  request.static_pubkey,
);
assert.equal(processed.valid, true);
assert.equal(processed.apiKey, receiverApiKey);
assert.deepEqual(processed.payload, payload);
assert.equal(processed.fingerprint, getFingerprint(callback.static_pubkey));

const callbackMutations = {
  version: HANDSHAKE_VERSION + 1,
  role: 'initiator',
  token: '44'.repeat(32),
  request_static_pubkey: toBase64(receiver.publicKey),
  ephemeral_pubkey: toBase64(generateEphemeral().publicKey),
  static_pubkey: request.static_pubkey,
  encrypted_payload: toBase64(nacl.randomBytes(64)),
  nonce: toBase64(nacl.randomBytes(24)),
};
for (const [field, value] of Object.entries(callbackMutations)) {
  const tampered = processCallback(
    { ...callback, [field]: value },
    initiatorEphemeral.secretKey,
    token,
    request.static_pubkey,
  );
  assert.equal(tampered.valid, false, `Callback mutation accepted: ${field}`);
}
for (const [field, value] of Object.entries({
  token: '42'.repeat(31),
  request_static_pubkey: toBase64(nacl.randomBytes(31)),
  ephemeral_pubkey: toBase64(nacl.randomBytes(33)),
  static_pubkey: toBase64(nacl.randomBytes(31)),
  signature: toBase64(nacl.randomBytes(63)),
  encrypted_payload: toBase64(nacl.randomBytes(8193)),
  nonce: toBase64(nacl.randomBytes(23)),
})) {
  assert.notEqual(validatePairingCallbackEnvelope({ ...callback, [field]: value }), null, `Oversized/malformed callback field accepted: ${field}`);
}

const sharedByInitiator = computeSharedSecret(initiatorEphemeral.secretKey, callback.ephemeral_pubkey);
assert.deepEqual(Buffer.from(sharedByInitiator), Buffer.from(sharedByReceiver));
assert.notEqual(deriveKeys(sharedByInitiator, '45'.repeat(32)).apiKey, receiverApiKey);

// ── Reciprocal offer (v4) ────────────────────────────────────────

const offer = { allowed_path_prefix: '/mnt/user/backups/site-b', storage_limit_bytes: 1024 ** 4 };

function signedRequest(fields) {
  const body = {
    version: HANDSHAKE_VERSION,
    role: 'initiator',
    instance: 'Site A',
    token,
    callback_url: 'http://10.0.0.10:8091',
    ssh_public_key: `ssh-ed25519 ${Buffer.from('initiator-key').toString('base64')} redman@site-a`,
    ephemeral_pubkey: toBase64(initiatorEphemeral.publicKey),
    static_pubkey: toBase64(initiator.publicKey),
    ...fields,
  };
  body.signature = toBase64(signPairingTranscript(buildRequestTranscript(body), initiator.secretKey));
  return body;
}

assert.equal(validateRequest(signedRequest({ reciprocal_offer: offer })).valid, true);
assert.equal(validateRequest(signedRequest({})).valid, true, 'a request without an offer stays valid');

// The offer is inside the signed transcript, so neither adding nor editing it survives
const withoutOffer = signedRequest({});
assert.equal(
  validateRequest({ ...withoutOffer, reciprocal_offer: offer }).valid, false,
  'an offer injected after signing must be rejected',
);
const withOffer = signedRequest({ reciprocal_offer: offer });
for (const mutation of [
  { allowed_path_prefix: '/mnt/user/backups/attacker', storage_limit_bytes: offer.storage_limit_bytes },
  { allowed_path_prefix: offer.allowed_path_prefix, storage_limit_bytes: 1024 ** 5 },
]) {
  assert.equal(
    validateRequest({ ...withOffer, reciprocal_offer: mutation }).valid, false,
    `Mutated reciprocal offer accepted: ${JSON.stringify(mutation)}`,
  );
}
assert.equal(validateRequest({ ...withOffer, reciprocal_offer: undefined }).valid, false, 'stripping the offer must be rejected');

assert.equal(validateReciprocalOffer(undefined), null);
assert.equal(validateReciprocalOffer(null), null);
assert.equal(validateReciprocalOffer(offer), null);
for (const bad of [
  {},
  { allowed_path_prefix: '/mnt/user/b' },
  { storage_limit_bytes: 1 },
  { allowed_path_prefix: '/mnt/user/b', storage_limit_bytes: 1, extra: true },
  { allowed_path_prefix: 'mnt/user/b', storage_limit_bytes: 1 },
  { allowed_path_prefix: '/mnt/user/b', storage_limit_bytes: 0 },
  { allowed_path_prefix: '/mnt/user/b', storage_limit_bytes: -1 },
  { allowed_path_prefix: '/mnt/user/b', storage_limit_bytes: 1.5 },
  { allowed_path_prefix: '/mnt/user/b', storage_limit_bytes: Number.MAX_SAFE_INTEGER + 2 },
  { allowed_path_prefix: '/'.padEnd(600, 'x'), storage_limit_bytes: 1 },
  [],
  'nope',
]) {
  assert.notEqual(validateReciprocalOffer(bad), null, `Invalid reciprocal offer accepted: ${JSON.stringify(bad)}`);
}

// The reverse-direction key is derived from the same secret under a distinct label
const forward = deriveKeys(sharedByInitiator, token);
const mirrored = deriveKeys(sharedByReceiver, token);
assert.equal(forward.apiKey, mirrored.apiKey, 'both sides derive the same forward key');
assert.equal(forward.reverseApiKey, mirrored.reverseApiKey, 'both sides derive the same reverse key');
assert.notEqual(forward.apiKey, forward.reverseApiKey, 'the reverse key must differ from the forward key');
assert.equal(forward.reverseApiKey.length, 64);
assert.notEqual(deriveKeys(sharedByInitiator, '45'.repeat(32)).reverseApiKey, forward.reverseApiKey);

console.log('Handshake v4 production transcript: full flow, reciprocal offer binding, and tamper checks passed');
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import { getIdentity } from './handshake.js';

const ENCRYPTED_MARKER = 'encrypted:v1';
export const PEER_SECRET_MIGRATION_MAX_ROWS = 10_000;
export const PEER_SECRET_MIGRATION_MIN_FREE_BYTES = 1024 ** 3;
const PEER_SECRET_MIGRATION_BATCH_SIZE = 100;

function encryptionKey() {
  return createHash('sha256').update(Buffer.from(getIdentity().secretKey)).digest();
}

export function hashPeerApiKey(apiKey) {
  if (!apiKey || typeof apiKey !== 'string') throw new Error('Peer API key is required');
  return createHash('sha256').update(apiKey).digest('hex');
}

export function encryptedPeerKeyMarker() {
  return ENCRYPTED_MARKER;
}

export function hashedPeerKeyMarker(hash) {
  return `hashed:${hash}`;
}

export function encryptPeerApiKey(apiKey) {
  if (!apiKey || typeof apiKey !== 'string') throw new Error('Peer API key is required');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
}

export function decryptPeerApiKey(encrypted) {
  if (!encrypted) return null;
  const [version, ivB64, tagB64, ciphertextB64] = String(encrypted).split(':');
  if (version !== 'v1' || !ivB64 || !tagB64 || !ciphertextB64) {
    throw new Error('Unsupported encrypted peer key format');
  }
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

export function assertPeerSecretMigrationBounded(db, options = {}) {
  const maxRows = options.maxRows ?? PEER_SECRET_MIGRATION_MAX_ROWS;
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > PEER_SECRET_MIGRATION_MAX_ROWS) {
    throw new Error(`Peer secret migration limit must be between 1 and ${PEER_SECRET_MIGRATION_MAX_ROWS}`);
  }
  const checks = [
    ['authorized_peers', `api_key_hash IS NULL AND api_key IS NOT NULL AND api_key NOT LIKE 'hashed:%'`, []],
    ['pairing_requests', 'api_key IS NOT NULL AND api_key_encrypted IS NULL', []],
    ['hyper_backup_jobs', 'remote_api_key_encrypted IS NULL AND remote_api_key IS NOT NULL AND remote_api_key != ?', [ENCRYPTED_MARKER]],
  ];
  let qualifyingRows = 0;
  for (const [table, predicate, parameters] of checks) {
    const remaining = maxRows - qualifyingRows;
    const count = Number(db.prepare(`
      SELECT COUNT(*) AS count FROM (
        SELECT 1 FROM ${table} WHERE ${predicate} LIMIT ?
      )
    `).get(...parameters, remaining + 1).count);
    qualifyingRows += count;
    if (qualifyingRows > maxRows) {
      throw new Error(`Credential conversion exceeds the aggregate ${maxRows}-row startup limit; use a controlled offline migration`);
    }
  }

  let availableBytes = options.availableBytes ?? null;
  if (availableBytes === null && db.name && db.name !== ':memory:') {
    const filesystem = statfsSync(dirname(db.name), { bigint: true });
    availableBytes = Number(filesystem.bavail * filesystem.bsize);
  }
  if (availableBytes !== null
      && (!Number.isFinite(availableBytes) || availableBytes < PEER_SECRET_MIGRATION_MIN_FREE_BYTES)) {
    throw new Error('Credential conversion requires at least 1 GiB free for bounded WAL amplification');
  }
  return { qualifyingRows, availableBytes };
}

function migrateInBatches(db, selectSql, selectParameters, updateRow) {
  const select = db.prepare(selectSql);
  const updateBatch = db.transaction(rows => {
    for (const row of rows) updateRow(row);
  });
  let lastId = 0;
  let migrated = 0;
  while (true) {
    const rows = select.all(...selectParameters, lastId, PEER_SECRET_MIGRATION_BATCH_SIZE);
    if (rows.length === 0) return migrated;
    updateBatch(rows);
    migrated += rows.length;
    lastId = rows.at(-1).id;
  }
}

export function migratePeerSecrets(db, options = {}) {
  assertPeerSecretMigrationBounded(db, options);
  const updateIncoming = db.prepare('UPDATE authorized_peers SET api_key = ?, api_key_hash = ? WHERE id = ?');
  const incoming = migrateInBatches(db, `
    SELECT id, api_key FROM authorized_peers
    WHERE api_key_hash IS NULL AND api_key IS NOT NULL AND api_key NOT LIKE 'hashed:%'
      AND id > ? ORDER BY id LIMIT ?
  `, [], peer => {
    const hash = hashPeerApiKey(peer.api_key);
    updateIncoming.run(hashedPeerKeyMarker(hash), hash, peer.id);
  });

  const updatePairing = db.prepare('UPDATE pairing_requests SET api_key = NULL, api_key_encrypted = ? WHERE id = ?');
  const pairings = migrateInBatches(db, `
    SELECT id, api_key FROM pairing_requests
    WHERE api_key IS NOT NULL AND api_key_encrypted IS NULL
      AND id > ? ORDER BY id LIMIT ?
  `, [], pairing => {
    updatePairing.run(encryptPeerApiKey(pairing.api_key), pairing.id);
  });

  const updateJob = db.prepare(`
    UPDATE hyper_backup_jobs SET remote_api_key = ?, remote_api_key_encrypted = ? WHERE id = ?
  `);
  const jobs = migrateInBatches(db, `
    SELECT id, remote_api_key FROM hyper_backup_jobs
    WHERE remote_api_key_encrypted IS NULL
      AND remote_api_key IS NOT NULL
      AND remote_api_key != ?
      AND id > ? ORDER BY id LIMIT ?
  `, [ENCRYPTED_MARKER], job => {
    updateJob.run(ENCRYPTED_MARKER, encryptPeerApiKey(job.remote_api_key), job.id);
  });

  return { incoming, pairings, jobs };
}
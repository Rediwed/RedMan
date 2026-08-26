import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  readFileSync,
} from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveExistingPathWithinPrefix } from './pathConfinement.js';

const VERIFIED_OUTCOMES = new Set(['uploaded', 'duplicate']);
export function classifyImmichLogOutcome(line) {
  return parseImmichLogEvent(line)?.outcome || null;
}

function parseImmichLogEvent(line) {
  const uploaded = line.match(/\b(?:uploaded successfully|server asset upgraded)\b.*?\bfile=(.+?)(?:\s+[a-z_]+=[^\s]+)*$/i);
  if (uploaded) return { outcome: 'uploaded', fileReference: uploaded[1].trim(), error: null };

  const duplicate = line.match(/\bserver has (?:duplicate|same|better)\b.*?\bfile=(.+?)(?:\s+[a-z_]+=[^\s]+)*$/i);
  if (duplicate) return { outcome: 'duplicate', fileReference: duplicate[1].trim(), error: null };

  const failed = line.match(/\b(?:server error|upload failed|file access error|incomplete processing)\b.*?\bfile=(.+?)(?:\s+error=(.+))?$/i);
  if (failed) {
    return {
      outcome: 'error',
      fileReference: failed[1].trim(),
      error: failed[2]?.trim() || 'Immich import failed',
    };
  }
  return null;
}

function sourcePathFromReference(fileReference, mountPath) {
  const colonIndex = fileReference.indexOf(':');
  const relativePath = colonIndex >= 0 ? fileReference.slice(colonIndex + 1) : fileReference;
  if (!relativePath || relativePath.startsWith('/')) return null;
  try {
    return resolveExistingPathWithinPrefix(join(mountPath, relativePath), mountPath).path;
  } catch {
    return null;
  }
}

async function fingerprintFile(filePath) {
  const before = await stat(filePath);
  if (!before.isFile()) throw new Error('Source is not a regular file');
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  const after = await stat(filePath);
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    throw new Error('Source changed while fingerprinting');
  }
  return {
    size: after.size,
    mtime: after.mtime.toISOString(),
    sha256: hash.digest('hex'),
  };
}

export async function parseImmichLogLine(line, mountPath) {
  const event = parseImmichLogEvent(line);
  const { fileReference, outcome, error } = event || {};

  if (!outcome || !fileReference) return null;
  const sourcePath = sourcePathFromReference(fileReference, mountPath);
  if (!sourcePath) return null;

  let fingerprint = { size: null, mtime: null, sha256: null };
  try {
    fingerprint = await fingerprintFile(sourcePath);
  } catch (err) {
    if (VERIFIED_OUTCOMES.has(outcome)) {
      outcome = 'error';
      error = `Could not fingerprint verified source: ${err.message}`;
    }
  }

  return { sourcePath, outcome, error, ...fingerprint };
}

export async function buildMediaImportLedger(logPaths, mountPath, concurrency = 4) {
  const lines = [];
  for (const logPath of logPaths) {
    if (!logPath || !existsSync(logPath)) continue;
    lines.push(...readFileSync(logPath, 'utf8').split('\n'));
  }

  const entries = new Array(lines.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < lines.length) {
      const index = nextIndex++;
      entries[index] = await parseImmichLogLine(lines[index], mountPath);
    }
  }
  const workerCount = Math.min(Math.max(1, concurrency), lines.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const finalEntries = new Map();
  for (const entry of entries) if (entry) finalEntries.set(entry.sourcePath, entry);
  return [...finalEntries.values()];
}

export function persistMediaImportLedger(db, runId, entries) {
  const clearLedger = db.prepare('DELETE FROM media_import_ledger WHERE run_id = ?');
  const clearRunFiles = db.prepare('DELETE FROM backup_run_files WHERE run_id = ?');
  const insertLedger = db.prepare(`
    INSERT INTO media_import_ledger
      (run_id, source_path, outcome, source_size, source_mtime, source_sha256, error, verified_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertRunFile = db.prepare(`
    INSERT INTO backup_run_files (run_id, file_path, action, size, error, file_date)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    clearLedger.run(runId);
    clearRunFiles.run(runId);
    for (const entry of entries) {
      const verifiedAt = VERIFIED_OUTCOMES.has(entry.outcome) && entry.sha256
        ? new Date().toISOString()
        : null;
      insertLedger.run(runId, entry.sourcePath, entry.outcome, entry.size, entry.mtime,
        entry.sha256, entry.error, verifiedAt);
      insertRunFile.run(runId, entry.sourcePath, entry.outcome, entry.size || 0,
        entry.error, entry.mtime);
    }
  })();
  return entries;
}

export async function deleteVerifiedMediaSources(db, runId, mountPath) {
  const candidates = db.prepare(`
    SELECT * FROM media_import_ledger
    WHERE run_id = ? AND outcome IN ('uploaded', 'duplicate')
      AND verified_at IS NOT NULL AND deleted_at IS NULL
    ORDER BY source_path
  `).all(runId);
  const markDeleted = db.prepare(`
    UPDATE media_import_ledger SET deleted_at = datetime('now'), deletion_error = NULL WHERE id = ?
  `);
  const markError = db.prepare(`UPDATE media_import_ledger SET deletion_error = ? WHERE id = ?`);

  let deleted = 0;
  let preserved = 0;
  for (const candidate of candidates) {
    try {
      const confined = resolveExistingPathWithinPrefix(candidate.source_path, mountPath).path;
      const current = await fingerprintFile(confined);
      if (current.size !== candidate.source_size
          || current.mtime !== candidate.source_mtime
          || current.sha256 !== candidate.source_sha256) {
        throw new Error('Source changed after Immich verification');
      }
      await unlink(confined);
      markDeleted.run(candidate.id);
      deleted++;
    } catch (err) {
      markError.run(err.message, candidate.id);
      preserved++;
    }
  }
  return { deleted, preserved, candidates: candidates.length };
}
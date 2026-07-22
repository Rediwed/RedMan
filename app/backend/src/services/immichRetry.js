import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function createImmichRetryDirectory(runId, parentDirectory = tmpdir()) {
  const normalizedRunId = Number.parseInt(runId, 10);
  if (!Number.isInteger(normalizedRunId) || normalizedRunId < 1) {
    throw new Error('Immich retry run ID must be a positive integer');
  }
  return mkdtemp(join(parentDirectory, `redman-immich-retry-${normalizedRunId}-`));
}

export async function removeImmichRetryDirectory(directory) {
  if (!directory) return;
  await rm(directory, { recursive: true, force: true });
}
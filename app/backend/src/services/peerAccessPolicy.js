import { normalizePath } from '../middleware/validation.js';

export function validatePairingAccess(allowedPathPrefix, storageLimitBytes) {
  const normalizedPrefix = normalizePath(allowedPathPrefix);
  if (!normalizedPrefix || normalizedPrefix === '/') {
    throw new Error('Pairing requires an explicit backup directory below the filesystem root');
  }

  const normalizedLimit = Number(storageLimitBytes);
  if (!Number.isSafeInteger(normalizedLimit) || normalizedLimit <= 0) {
    throw new Error('Pairing requires a finite storage limit greater than zero');
  }

  return {
    allowedPathPrefix: normalizedPrefix,
    storageLimitBytes: normalizedLimit,
  };
}
export function isCancelledRun(currentStatus, exitCode) {
  return currentStatus === 'cancelled'
    || exitCode === null
    || exitCode === 143
    || exitCode === -15;
}

export function resolveMediaImportStatus(currentStatus, exitCode, progress) {
  if (isCancelledRun(currentStatus, exitCode)) return 'cancelled';
  if (exitCode === 0) return 'completed';
  if (progress.uploaded > 0 && progress.errors < progress.uploaded) return 'partial';
  return 'failed';
}
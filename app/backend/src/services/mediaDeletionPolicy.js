export const DELETE_AFTER_IMPORT_AVAILABLE = true;

export function validateDeleteAfterImportSetting(value) {
  const enabled = value === true || value === 1 || value === '1';
  if (enabled && !DELETE_AFTER_IMPORT_AVAILABLE) {
    throw new Error('Delete after import is unavailable until per-file import verification is implemented');
  }
  return enabled ? 1 : 0;
}
export function formatBytes(bytes, { zero = '0 B', unavailable = '—' } = {}) {
  if (bytes === undefined || bytes === null || Number.isNaN(Number(bytes))) return unavailable;
  const value = Number(bytes);
  if (value === 0) return zero;
  if (!Number.isFinite(value) || value < 0) return unavailable;
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const unitIndex = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / (1024 ** unitIndex)).toFixed(1)} ${units[unitIndex]}`;
}
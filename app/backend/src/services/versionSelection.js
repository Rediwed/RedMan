const VERSION_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/;

export function getNewerVersions(versionNames, timestamp) {
  return versionNames
    .filter(name => VERSION_TIMESTAMP_PATTERN.test(name) && name > timestamp)
    .sort((a, b) => a.localeCompare(b));
}

export function applyVersionOverlay(entries, name, entry) {
  if (entries.get(name)?.source === 'version') return false;
  entries.set(name, entry);
  return true;
}

export function parseVersionTimestamp(timestamp) {
  const isoTimestamp = timestamp.replace(/T(\d{2})-(\d{2})-(\d{2})$/, 'T$1:$2:$3Z');
  return new Date(isoTimestamp);
}
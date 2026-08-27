// A Google Photos takeout is not just a folder of files: each photo sits beside
// a JSON sidecar holding the date, GPS fix, and album membership that Google
// stripped from the file itself. Reading one with `from-folder` uploads the
// pixels and silently discards all of that, so the mode is part of the source
// definition rather than a preference.
const UPLOAD_MODES = {
  folder: {
    command: 'from-folder',
    extraArgs: [],
  },
  'google-photos': {
    command: 'from-google-photos',
    // Without this, any photo whose sidecar is missing is skipped entirely
    // rather than falling back to its own EXIF data.
    extraArgs: ['--include-unmatched'],
  },
};

export function isSupportedImmichUploadMode(mode) {
  return Object.prototype.hasOwnProperty.call(UPLOAD_MODES, mode);
}

export function buildImmichUploadInvocation({ serverUrl, apiKey, logPath, sourcePath, sourcePaths, mode = 'folder', dryRun = false }) {
  const sources = Array.isArray(sourcePaths) && sourcePaths.length > 0
    ? sourcePaths
    : (sourcePath ? [sourcePath] : []);
  if (!serverUrl || !apiKey || !logPath || sources.length === 0) {
    throw new Error('Immich upload invocation requires server, API key, log path, and source path');
  }
  if (!isSupportedImmichUploadMode(mode)) {
    throw new Error(`Unsupported Immich upload mode: ${mode}`);
  }
  const profile = UPLOAD_MODES[mode];
  return {
    args: [
      'upload', profile.command,
      `--server=${serverUrl}`,
      `--log-file=${logPath}`,
      '--log-level=INFO',
      '--no-ui',
      '--on-errors', 'continue',
      ...(dryRun ? ['--dry-run'] : []),
      ...profile.extraArgs,
      ...sources,
    ],
    env: {
      IMMICH_GO_UPLOAD_API_KEY: apiKey,
    },
  };
}
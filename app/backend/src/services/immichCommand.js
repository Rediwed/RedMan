export function buildImmichUploadInvocation({ serverUrl, apiKey, logPath, sourcePath }) {
  if (!serverUrl || !apiKey || !logPath || !sourcePath) {
    throw new Error('Immich upload invocation requires server, API key, log path, and source path');
  }
  return {
    args: [
      'upload', 'from-folder',
      `--server=${serverUrl}`,
      `--log-file=${logPath}`,
      '--log-level=INFO',
      '--no-ui',
      '--on-errors', 'continue',
      sourcePath,
    ],
    env: {
      IMMICH_GO_UPLOAD_API_KEY: apiKey,
    },
  };
}
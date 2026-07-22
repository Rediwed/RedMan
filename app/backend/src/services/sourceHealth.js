import { readdir, stat } from 'node:fs/promises';

export async function assertLocalSourceHasEntries(sourcePath, label = 'Source') {
  let info;
  try {
    info = await stat(sourcePath);
  } catch {
    throw new Error(`${label} path is inaccessible: ${sourcePath}`);
  }

  if (!info.isDirectory()) return;

  const entries = await readdir(sourcePath);
  if (entries.length === 0) {
    throw new Error(`${label} path is empty: ${sourcePath}. Aborting destructive sync because the source may be unmounted.`);
  }
}

export function assertRemoteSourceHasEntries(entries, label = 'Remote source') {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`${label} is empty. Aborting destructive sync because the source may be unavailable.`);
  }
}
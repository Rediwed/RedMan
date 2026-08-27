import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, renameSync, statSync, statfsSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import db from '../db.js';
import { isWithinPrefix, normalizePath } from '../middleware/validation.js';
import { storageConfig } from './storageConfig.js';
import { ensureDirectoryWithinPrefix, resolveExistingPathWithinPrefix } from './pathConfinement.js';
import { downloadRemoteFile, listRemoteTakeoutArchives, terminateRcloneProcess } from './rclone.js';
import { cancelImport, uploadTakeoutArchive } from './immichImport.js';
import { summarizeImmichGoFailure } from './immichFailureSummary.js';

const activeOnlineImports = new Map();
const cancelledOnlineImports = new Set();
const MIN_FREE_RESERVE_BYTES = 512 * 1024 * 1024;

function resolveStagingRoot(path, databasePath = db.name) {
  const normalized = normalizePath(String(path || '').trim());
  if (!normalized || normalized === '/') throw new Error('A dedicated local staging folder is required');
  const dataRoot = dirname(databasePath);
  const defaultRoot = join(dirname(databasePath), 'media-import-staging');
  if (normalized === defaultRoot || !isWithinPrefix(normalized, defaultRoot)) {
    throw new Error('Online import staging must use RedMan persistent data');
  }
  chmodSync(dataRoot, 0o700);
  ensureDirectoryWithinPrefix(defaultRoot, dataRoot);
  chmodSync(defaultRoot, 0o700);
  return defaultRoot;
}

function validateStagingPath(path, databasePath = db.name) {
  const root = resolveStagingRoot(path, databasePath);
  const stagingPath = ensureDirectoryWithinPrefix(path, root).path;
  chmodSync(stagingPath, 0o700);
  return stagingPath;
}

function revalidateStagingPath(path) {
  const root = resolveStagingRoot(path);
  const dataRoot = dirname(db.name);
  if ((statSync(dataRoot).mode & 0o777) !== 0o700 || (statSync(root).mode & 0o777) !== 0o700) {
    throw new Error('RedMan persistent data or staging permissions changed; expected private mode 0700');
  }
  const stagingPath = resolveExistingPathWithinPrefix(path, root).path;
  const mode = statSync(stagingPath).mode & 0o777;
  if (mode !== 0o700) throw new Error('The staging folder permissions changed; expected private mode 0700');
  return stagingPath;
}

export function assertStagedArchiveSafe(archivePath, stagingPath, expectedSize) {
  const info = lstatSync(archivePath);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error('The staged Takeout archive is not a regular file');
  }
  const resolved = resolveExistingPathWithinPrefix(archivePath, stagingPath).path;
  if (resolved !== archivePath) throw new Error('The staged Takeout archive resolves elsewhere');
  if (info.size !== expectedSize) {
    throw new Error(`Downloaded Takeout archive size changed: expected ${expectedSize} bytes, received ${info.size}`);
  }
  return resolved;
}

export function defaultOnlineStagingPath(remoteName, remotePath, databasePath = db.name) {
  const fingerprint = createHash('sha256')
    .update(`${remoteName}\0${remotePath}`)
    .digest('hex')
    .slice(0, 16);
  return join(dirname(databasePath), 'media-import-staging', fingerprint);
}

export function validateOnlineMediaSourceInput(input = {}, options = {}) {
  const name = String(input.name || '').trim();
  if (!name || name.length > 100) throw new Error('A name between 1 and 100 characters is required');
  const remoteName = String(input.remote_name || '').trim();
  const remotePath = String(input.remote_path || '').trim().replace(/^\/+|\/+$/g, '');
  if (!/^[a-zA-Z0-9_-]+$/.test(remoteName)) throw new Error('Select a valid Rclone remote');
  if (!remotePath || /[\n\r\0]/.test(remotePath) || /(^|\/)\.\.(\/|$)/.test(remotePath)) {
    throw new Error('Select a valid Google Takeout folder on the remote');
  }
  const databasePath = options.databasePath || db.name;
  const requestedPath = defaultOnlineStagingPath(remoteName, remotePath, databasePath);
  return {
    name,
    remoteName,
    remotePath,
    stagingPath: validateStagingPath(requestedPath, databasePath),
  };
}

export function getActiveOnlineImport(runId) {
  return activeOnlineImports.get(runId);
}

export async function cancelOnlineImport(runId, timeoutMs = 10000) {
  if (!activeOnlineImports.has(runId)) return false;
  cancelledOnlineImports.add(runId);
  activeOnlineImports.get(runId).status = 'cancelling';
  const terminations = await Promise.all([
    terminateRcloneProcess(`media-online:${runId}`, timeoutMs),
    cancelImport(runId, timeoutMs),
  ]);
  return !terminations.includes(false);
}

function localArchivePaths(source, remoteArchive, namePrefix = '') {
  const fingerprint = createHash('sha256').update(remoteArchive.path).digest('hex').slice(0, 12);
  const safeName = basename(remoteArchive.path).replace(/[^a-zA-Z0-9._-]/g, '_');
  const finalPath = join(source.mount_path, `${namePrefix}${fingerprint}-${safeName}`);
  return { finalPath, partialPath: `${finalPath}.partial` };
}

export function requiredOnlineImportBytes(archiveSize) {
  if (!Number.isFinite(archiveSize) || archiveSize < 0) throw new Error('Archive size must be a non-negative number');
  return archiveSize + Math.max(MIN_FREE_RESERVE_BYTES, Math.ceil(archiveSize * 0.1));
}

function assertEnoughSpace(stagingPath, archiveSize) {
  const filesystem = statfsSync(stagingPath, { bigint: true });
  const available = Number(filesystem.bavail * filesystem.bsize);
  const required = requiredOnlineImportBytes(archiveSize);
  if (!Number.isFinite(available) || available < required) {
    throw new Error(`Not enough free space for the next Takeout archive: ${Math.ceil(required / 1024 ** 3)} GiB required, ${Math.floor(available / 1024 ** 3)} GiB available`);
  }
  return { available, required };
}

function isCancelled(runId) {
  return cancelledOnlineImports.has(runId)
    || ['cancelling', 'cancelled'].includes(
      db.prepare('SELECT status FROM backup_runs WHERE id = ?').get(runId)?.status,
    );
}

export async function startOnlineImport(sourceId, { dryRun = false } = {}) {
  const source = db.prepare("SELECT * FROM media_drives WHERE id = ? AND source_kind = 'online'").get(sourceId);
  if (!source) throw new Error('Online import source not found');
  if ([...activeOnlineImports.values()].some(item => (
    item.sourceId === source.id && ['running', 'cancelling'].includes(item.status)
  ))) {
    throw new Error('An import is already running for this online source');
  }
  source.mount_path = revalidateStagingPath(source.mount_path);

  const result = db.prepare("INSERT INTO backup_runs (feature, config_id, status, dry_run) VALUES ('media-import', ?, 'running', ?)")
    .run(source.id, dryRun ? 1 : 0);
  const runId = Number(result.lastInsertRowid);
  const progress = {
    runId, sourceId: source.id, driveId: source.id, status: 'running', phase: 'listing',
    archivesTotal: 0, archivesCompleted: 0, currentArchive: null, percent: 0,
    assetsFound: 0, scanned: 0, uploaded: 0, duplicates: 0, errors: 0, bytesTransferred: 0,
    dryRun,
    startedAt: Date.now(),
  };
  activeOnlineImports.set(runId, progress);
  runOnlineImport(source, runId, progress).catch(error => {
    console.error(`[online-media-import] Run ${runId} failed: ${error.message}`);
  });
  return { runId, status: 'running', dryRun };
}

async function runOnlineImport(source, runId, progress) {
  const startedAt = Date.now();
  const completedAssets = { scanned: 0, found: 0, uploaded: 0, duplicates: 0, errors: 0 };
  const dryRunArtifacts = new Set();
  try {
    const archives = await listRemoteTakeoutArchives(source.remote_name, source.remote_path, {
      processKey: `media-online:${runId}`,
    });
    if (archives.length === 0) throw new Error('No .zip, .tgz, or .tar.gz Takeout archives were found in this Google Drive folder');
    const completed = new Set(db.prepare(`
      SELECT remote_path || char(0) || remote_size || char(0) || remote_modtime AS archive_key
      FROM media_online_import_archives WHERE source_id = ?
    `).all(source.id).map(row => row.archive_key));
    const pending = archives.filter(archive => !completed.has(`${archive.path}\0${archive.size}\0${archive.modTime}`));
    progress.archivesTotal = archives.length;
    progress.archivesCompleted = archives.length - pending.length;

    for (const archive of pending) {
      if (isCancelled(runId)) throw new Error('Cancelled by user');
      source.mount_path = revalidateStagingPath(source.mount_path);
      progress.currentArchive = archive.path;
      progress.phase = 'checking-space';
      const { finalPath, partialPath } = localArchivePaths(
        source,
        archive,
        progress.dryRun ? `dry-run-${runId}-` : '',
      );
      let reusable = false;
      let downloadedForDryRun = false;
      if (!progress.dryRun && existsSync(finalPath)) {
        try {
          assertStagedArchiveSafe(finalPath, source.mount_path, archive.size);
          reusable = true;
        } catch {
          unlinkSync(finalPath);
        }
      }
      if (!reusable) {
        if (existsSync(partialPath)) {
          const partialInfo = lstatSync(partialPath);
          if (partialInfo.isDirectory() && !partialInfo.isSymbolicLink()) {
            throw new Error('The partial Takeout archive path was replaced by a directory');
          }
          unlinkSync(partialPath);
        }
        const space = assertEnoughSpace(source.mount_path, archive.size);
        progress.freeBytes = space.available;
        progress.requiredBytes = space.required;
        progress.phase = 'downloading';
        if (progress.dryRun) dryRunArtifacts.add(partialPath);
        await downloadRemoteFile(source.remote_name, `${source.remote_path}/${archive.path}`, partialPath, archive.size, `media-online:${runId}`, update => {
          progress.archivePercent = update.percent;
          progress.bytesTransferred = update.bytesTransferred;
        });
        source.mount_path = revalidateStagingPath(source.mount_path);
        try {
          assertStagedArchiveSafe(partialPath, source.mount_path, archive.size);
        } catch (error) {
          unlinkSync(partialPath);
          throw error;
        }
        renameSync(partialPath, finalPath);
        if (progress.dryRun) {
          dryRunArtifacts.delete(partialPath);
          dryRunArtifacts.add(finalPath);
          downloadedForDryRun = true;
        }
      }

      if (isCancelled(runId)) throw new Error('Cancelled by user');
      source.mount_path = revalidateStagingPath(source.mount_path);
      assertStagedArchiveSafe(finalPath, source.mount_path, archive.size);
      progress.phase = 'importing';
      progress.archivePercent = 0;
      const archiveProgress = { assetsFound: 0, scanned: 0, uploaded: 0, duplicates: 0, errors: 0, percent: 0 };
      const logPath = join(dirname(db.name), 'import-logs', `run-${runId}-archive-${progress.archivesCompleted + 1}.log`);
      mkdirSync(dirname(logPath), { recursive: true });
      const upload = await uploadTakeoutArchive({
        archivePath: finalPath, runId, progress: archiveProgress, logPath, dryRun: progress.dryRun,
        onProgress(update) {
          progress.archivePercent = update.percent;
          progress.assetsFound = completedAssets.found + update.assetsFound;
          progress.scanned = completedAssets.scanned + update.scanned;
          progress.uploaded = completedAssets.uploaded + update.uploaded;
          progress.duplicates = completedAssets.duplicates + update.duplicates;
          progress.errors = completedAssets.errors + update.errors;
        },
      });
      if (upload.exitCode !== 0 || archiveProgress.errors > 0) {
        throw new Error(summarizeImmichGoFailure(upload.errorOutput) || `Immich could not completely import ${archive.path}`);
      }

      if (!progress.dryRun) {
        db.prepare(`
          INSERT OR IGNORE INTO media_online_import_archives
            (source_id, remote_path, remote_size, remote_modtime, status)
          VALUES (?, ?, ?, ?, 'completed')
        `).run(source.id, archive.path, archive.size, archive.modTime);
      }
      db.prepare('INSERT INTO backup_run_files (run_id, file_path, action, size) VALUES (?, ?, ?, ?)')
        .run(runId, archive.path, progress.dryRun ? 'dry-run' : 'imported', archive.size);
      source.mount_path = revalidateStagingPath(source.mount_path);
      assertStagedArchiveSafe(finalPath, source.mount_path, archive.size);
      progress.phase = 'cleanup';
      if (!progress.dryRun || downloadedForDryRun) {
        unlinkSync(finalPath);
        dryRunArtifacts.delete(finalPath);
      }
      completedAssets.found += archiveProgress.assetsFound;
      completedAssets.scanned += archiveProgress.scanned;
      completedAssets.uploaded += archiveProgress.uploaded;
      completedAssets.duplicates += archiveProgress.duplicates;
      completedAssets.errors += archiveProgress.errors;
      progress.archivesCompleted += 1;
      progress.percent = Math.round((progress.archivesCompleted / progress.archivesTotal) * 100);
      progress.assetsFound = completedAssets.found;
      progress.scanned = completedAssets.scanned;
      progress.uploaded = completedAssets.uploaded;
      progress.duplicates = completedAssets.duplicates;
      progress.errors = completedAssets.errors;
      progress.currentArchive = null;
    }

    const duration = (Date.now() - startedAt) / 1000;
    db.prepare(`
      UPDATE backup_runs SET status = 'completed', completed_at = datetime('now'), files_total = ?,
        files_copied = ?, files_failed = 0, duration_seconds = ? WHERE id = ?
    `).run(archives.length, progress.dryRun ? completedAssets.uploaded : progress.archivesCompleted, duration, runId);
    if (!progress.dryRun) {
      db.prepare("UPDATE media_drives SET last_import_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(source.id);
    }
    progress.status = 'completed';
    progress.phase = 'completed';
    progress.percent = 100;
  } catch (error) {
    const cancelled = isCancelled(runId);
    const status = cancelled ? 'cancelled' : 'failed';
    db.prepare(`
      UPDATE backup_runs SET status = ?, completed_at = datetime('now'), files_total = ?, files_copied = ?,
        files_failed = ?, duration_seconds = ?, error_message = ? WHERE id = ?
    `).run(status, progress.archivesTotal, progress.archivesCompleted, cancelled ? 0 : 1,
      (Date.now() - startedAt) / 1000, cancelled ? 'Cancelled by user' : error.message, runId);
    progress.status = status;
    progress.phase = status;
  } finally {
    for (const artifactPath of dryRunArtifacts) {
      try {
        source.mount_path = revalidateStagingPath(source.mount_path);
        const artifact = lstatSync(artifactPath);
        if (!artifact.isSymbolicLink() && artifact.isFile()
          && isWithinPrefix(normalizePath(artifactPath), source.mount_path)) {
          unlinkSync(artifactPath);
        }
      } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') {
          console.warn(`[online-media-import] Could not remove dry-run staging artifact: ${cleanupError.message}`);
        }
      }
    }
    cancelledOnlineImports.delete(runId);
    setTimeout(() => activeOnlineImports.delete(runId), 5 * 60 * 1000);
  }
}
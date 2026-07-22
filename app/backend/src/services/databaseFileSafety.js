import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BACKEND_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DATABASE_VALIDATION_TIMEOUT_MS = 10 * 60_000;
const DATABASE_COPY_TIMEOUT_MS = 30 * 60_000;

const PENDING_SUFFIX = '.restore-pending';

function removeIfExists(filePath) {
  if (existsSync(filePath)) rmSync(filePath, { force: true });
}

function removeDatabaseSidecars(filePath) {
  removeIfExists(`${filePath}-wal`);
  removeIfExists(`${filePath}-shm`);
}

function integrityResult(filePath) {
  const candidate = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    return candidate.pragma('integrity_check', { simple: true });
  } finally {
    candidate.close();
  }
}

export function validateSqliteDatabase(filePath) {
  if (!existsSync(filePath)) throw new Error(`SQLite database not found: ${filePath}`);
  const result = integrityResult(filePath);
  if (result !== 'ok') throw new Error(`SQLite integrity check failed: ${result}`);
  return true;
}

export async function validateSqliteDatabaseAsync(filePath, options = {}) {
  const timeoutMs = typeof options === 'number'
    ? options
    : options.timeoutMs ?? DATABASE_VALIDATION_TIMEOUT_MS;
  const signal = typeof options === 'number' ? undefined : options.signal;
  if (!existsSync(filePath)) throw new Error(`SQLite database not found: ${filePath}`);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > DATABASE_VALIDATION_TIMEOUT_MS) {
    throw new Error(`SQLite validation timeout must be between 1000 and ${DATABASE_VALIDATION_TIMEOUT_MS} milliseconds`);
  }
  signal?.throwIfAborted();
  const script = `
    import Database from 'better-sqlite3';
    const database = new Database(process.argv[1], { readonly: true, fileMustExist: true });
    let result;
    try { result = database.pragma('integrity_check', { simple: true }); }
    finally { database.close(); }
    if (result !== 'ok') {
      console.error(String(result));
      process.exit(2);
    }
  `;
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script, filePath], {
      cwd: BACKEND_DIR,
      stdio: 'ignore',
    });
    let settled = false;
    const stopChild = () => {
      try { child.kill('SIGKILL'); } catch {}
      child.unref();
    };
    const abort = () => {
      stopChild();
      settle(signal.reason instanceof Error ? signal.reason : new Error('Database validation cancelled'));
    };
    const timeout = setTimeout(() => {
      stopChild();
      settle(new Error(`SQLite integrity check timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timeout.unref();
    const settle = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', err => settle(new Error(`SQLite integrity check failed: ${err.message}`)));
    child.once('exit', (code, exitSignal) => {
      if (code === 0) settle();
      else settle(new Error(`SQLite integrity check failed: child exited with ${exitSignal || code}`));
    });
    if (signal?.aborted) abort();
  });
  return true;
}

async function copyDatabaseFile(sourcePath, destinationPath, options = {}) {
  const timeoutMs = options.timeoutMs ?? DATABASE_COPY_TIMEOUT_MS;
  const signal = options.signal;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > DATABASE_COPY_TIMEOUT_MS) {
    throw new Error(`SQLite copy timeout must be between 1000 and ${DATABASE_COPY_TIMEOUT_MS} milliseconds`);
  }
  signal?.throwIfAborted();

  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('cp', ['--', sourcePath, destinationPath], { stdio: 'ignore' });
    let settled = false;
    const removePartialAfterExit = () => child.once('exit', () => removeIfExists(destinationPath));
    const stopChild = () => {
      try { child.kill('SIGKILL'); } catch {}
      child.unref();
    };
    const abort = () => {
      removePartialAfterExit();
      stopChild();
      settle(signal.reason instanceof Error ? signal.reason : new Error('Database copy cancelled'));
    };
    const timeout = setTimeout(() => {
      removePartialAfterExit();
      stopChild();
      settle(new Error(`SQLite copy timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timeout.unref();
    const settle = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', err => settle(new Error(`SQLite copy failed: ${err.message}`)));
    child.once('exit', (code, exitSignal) => {
      if (code === 0) settle();
      else settle(new Error(`SQLite copy failed: child exited with ${exitSignal || code}`));
    });
    if (signal?.aborted) abort();
  });
}

export async function createOnlineDatabaseBackup(sourceDb, backupPath, options = {}) {
  const signal = options.signal;
  signal?.throwIfAborted();
  mkdirSync(dirname(backupPath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(backupPath), 0o700);
  removeIfExists(backupPath);
  await sourceDb.backup(backupPath, {
    progress: () => {
      signal?.throwIfAborted();
      return 4_096;
    },
  });
  chmodSync(backupPath, 0o600);
  try {
    await validateSqliteDatabaseAsync(backupPath, {
      signal,
      timeoutMs: options.validationTimeoutMs,
    });
    removeDatabaseSidecars(backupPath);
  } catch (err) {
    removeDatabaseSidecars(backupPath);
    removeIfExists(backupPath);
    throw err;
  }
  return backupPath;
}

export function getPendingRestorePath(dbPath) {
  return `${dbPath}${PENDING_SUFFIX}`;
}

export async function stageDatabaseRestore(backupFilePath, dbPath, options = {}) {
  const signal = options.signal;
  await validateSqliteDatabaseAsync(backupFilePath, {
    signal,
    timeoutMs: options.validationTimeoutMs,
  });
  mkdirSync(dirname(dbPath), { recursive: true });

  const pendingPath = getPendingRestorePath(dbPath);
  const temporaryPath = `${pendingPath}.${process.pid}.tmp`;
  removeIfExists(temporaryPath);

  try {
    await copyDatabaseFile(backupFilePath, temporaryPath, {
      signal,
      timeoutMs: options.copyTimeoutMs,
    });
    chmodSync(temporaryPath, 0o600);
    await validateSqliteDatabaseAsync(temporaryPath, {
      signal,
      timeoutMs: options.validationTimeoutMs,
    });
    removeIfExists(pendingPath);
    renameSync(temporaryPath, pendingPath);
  } catch (err) {
    removeIfExists(temporaryPath);
    throw err;
  }

  return pendingPath;
}

export function applyPendingDatabaseRestore(dbPath, timestamp = Date.now()) {
  const pendingPath = getPendingRestorePath(dbPath);
  if (!existsSync(pendingPath)) return null;

  validateSqliteDatabase(pendingPath);

  const safetyPath = join(dirname(dbPath), `redman-pre-restore-${timestamp}.db`);
  const sidecarSuffixes = ['', '-wal', '-shm'];
  const moved = [];
  let installedPending = false;

  try {
    for (const suffix of sidecarSuffixes) {
      const currentPath = `${dbPath}${suffix}`;
      if (!existsSync(currentPath)) continue;
      const previousPath = `${safetyPath}${suffix}`;
      removeIfExists(previousPath);
      renameSync(currentPath, previousPath);
      moved.push({ currentPath, previousPath });
      chmodSync(previousPath, 0o600);
    }

    renameSync(pendingPath, dbPath);
    installedPending = true;
    chmodSync(dbPath, 0o600);
    validateSqliteDatabase(dbPath);
    removeIfExists(`${dbPath}-wal`);
    removeIfExists(`${dbPath}-shm`);

    rotatePreRestoreCopies(dbPath);
    return { restored: dbPath, previousSavedAs: moved.length > 0 ? safetyPath : null };
  } catch (err) {
    if (installedPending) {
      removeIfExists(dbPath);
      removeIfExists(`${dbPath}-wal`);
      removeIfExists(`${dbPath}-shm`);
    }
    for (const { currentPath, previousPath } of moved.reverse()) {
      if (existsSync(previousPath)) renameSync(previousPath, currentPath);
    }
    throw err;
  }
}

export function rotatePreRestoreCopies(dbPath, keep = 3) {
  const directory = dirname(dbPath);
  const groups = new Map();
  for (const name of readdirSync(directory)) {
    const match = name.match(/^redman-pre-restore-(\d+)\.db(?:-(?:wal|shm))?$/);
    if (!match) continue;
    const timestamp = Number(match[1]);
    const files = groups.get(timestamp) || [];
    const filePath = join(directory, name);
    chmodSync(filePath, 0o600);
    files.push(filePath);
    groups.set(timestamp, files);
  }
  const expired = [...groups.keys()].sort((a, b) => b - a).slice(Math.max(0, keep));
  let removed = 0;
  for (const timestamp of expired) {
    for (const filePath of groups.get(timestamp)) {
      removeIfExists(filePath);
      removed++;
    }
  }
  return removed;
}
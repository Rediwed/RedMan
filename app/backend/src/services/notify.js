// Dual-channel notification service (ntfy.sh + browser SSE)
// Supports per-event toggles, multiple auth types, and progress updates

import db from '../db.js';

// Browser SSE subscribers
const browserSubscribers = new Map();
let subscriberIdCounter = 0;

// ── Settings helpers ──────────────────────────────────────────────

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row?.value || '';
}

function getAllSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  for (const row of rows) settings[row.key] = row.value;
  return settings;
}

function isNtfyEnabled(settings, eventKey) {
  return settings.ntfy_enabled === 'true' && settings[eventKey] === 'true';
}

function isBrowserEnabled(settings, eventKey) {
  return settings.browser_notify_enabled === 'true' && settings[eventKey] === 'true';
}

function anyEnabled(settings, eventKey) {
  return isNtfyEnabled(settings, eventKey) || isBrowserEnabled(settings, eventKey);
}

// ── Core send functions ───────────────────────────────────────────

async function sendNtfy(settings, message, { title, priority = '3', tags } = {}) {
  const server = settings.ntfy_server || settings.ntfy_url;
  const topic = settings.ntfy_topic;
  if (!server || !topic) return false;

  // Use JSON body instead of headers to avoid Latin-1 encoding issues with emoji
  const body = { topic, message };
  if (title) body.title = title;
  if (priority) body.priority = parseInt(priority) || 3;
  if (tags) body.tags = tags.split(',').map(t => t.trim());

  const headers = { 'Content-Type': 'application/json' };

  // Auth
  const authType = settings.ntfy_auth_type || 'none';
  if (authType === 'token' && settings.ntfy_auth_token) {
    headers['Authorization'] = `Bearer ${settings.ntfy_auth_token}`;
  } else if (authType === 'basic' && settings.ntfy_username && settings.ntfy_password) {
    const b64 = Buffer.from(`${settings.ntfy_username}:${settings.ntfy_password}`).toString('base64');
    headers['Authorization'] = `Basic ${b64}`;
  } else if (settings.ntfy_token) {
    headers['Authorization'] = `Bearer ${settings.ntfy_token}`;
  }

  try {
    const jsonStr = JSON.stringify(body);
    const res = await fetch(server, {
      method: 'POST',
      headers,
      body: new TextEncoder().encode(jsonStr),
    });
    if (!res.ok) {
      console.error(`[notify] ntfy returned ${res.status}: ${await res.text()}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[notify] Failed to send ntfy:`, err.message);
    return false;
  }
}

function sendBrowser(type, title, body) {
  const event = JSON.stringify({ type, title, body });
  for (const [, cb] of browserSubscribers) {
    try { cb(event); } catch { /* subscriber gone */ }
  }
}

function sendQuiet(settings, eventKey, type, title, body, { priority, tags } = {}) {
  if (isNtfyEnabled(settings, eventKey)) {
    sendNtfy(settings, body, { title, priority, tags }).catch(() => {});
  }
  if (isBrowserEnabled(settings, eventKey)) {
    sendBrowser(type, title, body);
  }
}

// ── Public notification methods ───────────────────────────────────

export async function sendNotification(message, { title, priority = '3', tags } = {}) {
  const settings = getAllSettings();
  if (settings.ntfy_enabled !== 'true') {
    // Legacy fallback: send if server + topic exist (pre-refactor configs)
    const server = settings.ntfy_server || settings.ntfy_url;
    const topic = settings.ntfy_topic;
    if (server && topic) {
      return sendNtfy(settings, message, { title, priority, tags });
    }
    return false;
  }
  return sendNtfy(settings, message, { title, priority, tags });
}

export function notifyJobStarted(feature, name) {
  const settings = getAllSettings();
  const title = `Job Started — ${name}`;
  const body = `Feature: ${feature}\nJob: ${name}`;
  sendQuiet(settings, 'ntfy_on_job_start', 'job_started', title, body, { tags: 'rocket' });
}

export function notifyJobCompleted(feature, name, stats = {}) {
  const settings = getAllSettings();
  const title = `${feature}: ${name} — Completed`;
  const lines = [`Status: completed`];
  if (stats.filesCopied !== undefined) lines.push(`Files: ${stats.filesCopied}`);
  if (stats.bytesTransferred !== undefined) lines.push(`Transferred: ${formatBytes(stats.bytesTransferred)}`);
  if (stats.duration !== undefined) lines.push(`Duration: ${formatDuration(stats.duration)}`);
  sendQuiet(settings, 'ntfy_on_job_complete', 'job_completed', title, lines.join('\n'), { tags: 'white_check_mark' });
}

export function notifyJobError(feature, name, errorMsg) {
  const settings = getAllSettings();
  const title = `${feature}: ${name} — Failed`;
  const body = `Error: ${errorMsg || 'Unknown error'}`;
  sendQuiet(settings, 'ntfy_on_job_error', 'job_error', title, body, { priority: '4', tags: 'x' });
}

export function notifyJobCancelled(feature, name) {
  const settings = getAllSettings();
  const title = `${feature}: ${name} — Cancelled`;
  sendQuiet(settings, 'ntfy_on_job_complete', 'job_cancelled', title, 'Job was cancelled by user', { tags: 'no_entry_sign' });
}

export function notifyJobSkipped(feature, name, consecutiveSkips) {
  const settings = getAllSettings();
  const title = `⚠️ ${name} — Schedule too aggressive`;
  const body = `"${name}" has been skipped ${consecutiveSkips} times in a row because the previous run was still active. Consider adjusting the schedule.`;
  // Always send to browser so it's visible in the UI
  sendBrowser('job_skipped', title, body);
  // Also send via ntfy using error channel (high priority)
  if (isNtfyEnabled(settings, 'ntfy_on_job_error')) {
    sendNtfy(settings, body, { title, priority: '4', tags: 'warning' }).catch(() => {});
  }
}

export function notifyJobProgress(feature, name, progress) {
  const settings = getAllSettings();
  if (!anyEnabled(settings, 'ntfy_on_progress')) return;
  const title = `${name} — ${progress.percent || 0}%`;
  const lines = [`Feature: ${feature}`];
  if (progress.filesCopied !== undefined) lines.push(`Files: ${progress.filesCopied}`);
  if (progress.bytesTransferred !== undefined) lines.push(`Transferred: ${formatBytes(progress.bytesTransferred)}`);
  sendQuiet(settings, 'ntfy_on_progress', 'job_progress', title, lines.join('\n'), { priority: '2', tags: 'hourglass' });
}

export function notifyDriveAttached(drive) {
  const settings = getAllSettings();
  const label = drive.label || drive.name || 'Unknown';
  const title = `Drive Connected — ${label}`;
  const body = `Mount: ${drive.mountPath || drive.mount_path}\nSize: ${drive.sizeHuman || 'unknown'}`;
  sendQuiet(settings, 'ntfy_on_drive_attach', 'drive_attached', title, body, { tags: 'floppy_disk' });
}

export function notifyDriveEjected(drive) {
  const settings = getAllSettings();
  const label = drive.label || drive.name || 'Unknown';
  const title = `Drive Ejected — ${label}`;
  sendQuiet(settings, 'ntfy_on_drive_attach', 'drive_ejected', title, `${label} safely removed`, { priority: '2', tags: 'eject' });
}

export function notifyDriveLost(drive) {
  const settings = getAllSettings();
  const label = drive.label || drive.name || 'Unknown';
  const title = `Drive Lost — ${label}`;
  const body = `Drive was unexpectedly removed: ${drive.mountPath || drive.mount_path}`;
  sendQuiet(settings, 'ntfy_on_drive_lost', 'drive_lost', title, body, { priority: '4', tags: 'warning' });
}

export function notifyDriveScanStarted(path) {
  const settings = getAllSettings();
  const title = `Drive Scan Started`;
  sendQuiet(settings, 'ntfy_on_drive_scan', 'drive_scan_started', title, `Scanning: ${path}`, { priority: '2', tags: 'mag' });
}

export function notifyDriveScanCompleted(path, result) {
  const settings = getAllSettings();
  const title = `Drive Scan Complete`;
  const lines = [`Path: ${path}`];
  if (result) {
    lines.push(`Photos: ${result.photos}, Videos: ${result.videos}`);
    if (result.detectedCamera) lines.push(`Camera: ${result.detectedCamera}`);
  }
  sendQuiet(settings, 'ntfy_on_drive_scan', 'drive_scan_completed', title, lines.join('\n'), { priority: '2', tags: 'white_check_mark' });
}

export function notifyImportStarted(driveName) {
  const settings = getAllSettings();
  const title = `Import Started — ${driveName}`;
  sendQuiet(settings, 'ntfy_on_job_start', 'import_started', title, `Importing from ${driveName} into Immich`, { tags: 'camera' });
}

export function notifyImportCompleted(driveName, stats = {}) {
  const settings = getAllSettings();
  const title = `Import Complete — ${driveName}`;
  const lines = [];
  if (stats.uploaded !== undefined) lines.push(`Uploaded: ${stats.uploaded}`);
  if (stats.duplicates !== undefined) lines.push(`Duplicates: ${stats.duplicates}`);
  if (stats.errors !== undefined && stats.errors > 0) lines.push(`Errors: ${stats.errors}`);
  if (stats.duration !== undefined) lines.push(`Duration: ${formatDuration(stats.duration)}`);
  sendQuiet(settings, 'ntfy_on_job_complete', 'import_completed', title, lines.join('\n') || 'Import finished', { tags: 'white_check_mark' });
}

export function notifyImportError(driveName, errorMsg) {
  const settings = getAllSettings();
  const title = `Import Failed — ${driveName}`;
  sendQuiet(settings, 'ntfy_on_job_error', 'import_error', title, errorMsg || 'Unknown error', { priority: '4', tags: 'x' });
}

// Legacy helper for existing backup services
export async function notifyBackupResult(feature, configName, status, stats = {}) {
  if (status === 'completed') {
    notifyJobCompleted(feature, configName, stats);
  } else {
    notifyJobError(feature, configName, stats.errorMessage || 'Job failed');
  }
}

// ── Test notifications ────────────────────────────────────────────

export async function sendTestNtfy() {
  const settings = getAllSettings();
  return sendNtfy(settings, 'Test notification from RedMan — if you see this, ntfy is working!', {
    title: 'RedMan Test', priority: '3', tags: 'bell',
  });
}

export function sendTestBrowser() {
  sendBrowser('test', '🔔 RedMan Test', 'Browser notifications are working!');
}

// ── Browser SSE management ────────────────────────────────────────

export function addBrowserSubscriber(callback) {
  const id = ++subscriberIdCounter;
  browserSubscribers.set(id, callback);
  return id;
}

export function removeBrowserSubscriber(id) {
  browserSubscribers.delete(id);
}

// ── Formatting helpers ────────────────────────────────────────────

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function formatDuration(seconds) {
  if (!seconds) return '0s';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

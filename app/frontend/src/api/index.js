const API_BASE = '/api';

async function fetchJSON(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, options);
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function postJSON(path, body) {
  return fetchJSON(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function putJSON(path, body) {
  return fetchJSON(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function deleteJSON(path) {
  return fetchJSON(path, { method: 'DELETE' });
}

// ===== Settings =====
export const getSettings = () => fetchJSON('/settings');
export const saveSettings = (data) => putJSON('/settings', data);

// ===== Overview =====
export const getOverviewSummary = () => fetchJSON('/overview/summary');

// ===== SSD Backup =====
export const getSsdShares = () => fetchJSON('/ssd-backup/shares');
export const browsePath = (path) => fetchJSON(`/ssd-backup/browse?path=${encodeURIComponent(path)}`);
export const getSsdConfigs = () => fetchJSON('/ssd-backup/configs');
export const getSsdConfig = (id) => fetchJSON(`/ssd-backup/configs/${id}`);
export const createSsdConfig = (data) => postJSON('/ssd-backup/configs', data);
export const updateSsdConfig = (id, data) => putJSON(`/ssd-backup/configs/${id}`, data);
export const deleteSsdConfig = (id) => deleteJSON(`/ssd-backup/configs/${id}`);
export const triggerSsdBackup = (id) => postJSON(`/ssd-backup/configs/${id}/run`, {});
export const getSsdRuns = (page = 1, configId) => {
  let url = `/ssd-backup/runs?page=${page}`;
  if (configId) url += `&config_id=${configId}`;
  return fetchJSON(url);
};
export const getSsdRunDetail = (id) => fetchJSON(`/ssd-backup/runs/${id}`);

// ===== SSD Backup Version Browser =====
export const getSsdSnapshots = (configId) => fetchJSON(`/ssd-backup/configs/${configId}/snapshots`);
export const browseSsdSnapshot = (configId, timestamp, path = '') => {
  let url = `/ssd-backup/configs/${configId}/browse?timestamp=${encodeURIComponent(timestamp)}`;
  if (path) url += `&path=${encodeURIComponent(path)}`;
  return fetchJSON(url);
};
export const getSsdDownloadUrl = (configId, timestamp, path) =>
  `/api/ssd-backup/configs/${configId}/download?timestamp=${encodeURIComponent(timestamp)}&path=${encodeURIComponent(path)}`;
export const getSsdPreviewUrl = (configId, timestamp, path) =>
  `/api/ssd-backup/configs/${configId}/download?timestamp=${encodeURIComponent(timestamp)}&path=${encodeURIComponent(path)}&inline=true`;
export const restoreSsdFile = (configId, timestamp, path) =>
  postJSON(`/ssd-backup/configs/${configId}/restore`, { timestamp, path });
export const verifySsdVersions = (configId) =>
  postJSON(`/ssd-backup/configs/${configId}/verify-versions`, {});

// ===== Hyper Backup =====
export const getHyperJobs = () => fetchJSON('/hyper-backup/jobs');
export const getHyperJob = (id) => fetchJSON(`/hyper-backup/jobs/${id}`);
export const createHyperJob = (data) => postJSON('/hyper-backup/jobs', data);
export const updateHyperJob = (id, data) => putJSON(`/hyper-backup/jobs/${id}`, data);
export const deleteHyperJob = (id) => deleteJSON(`/hyper-backup/jobs/${id}`);
export const triggerHyperBackup = (id) => postJSON(`/hyper-backup/jobs/${id}/run`, {});
export const testHyperConnection = (data) => postJSON('/hyper-backup/test-connection', data);
export const getHyperRuns = (page = 1, jobId) => {
  let url = `/hyper-backup/runs?page=${page}`;
  if (jobId) url += `&job_id=${jobId}`;
  return fetchJSON(url);
};
export const getHyperRunDetail = (id) => fetchJSON(`/hyper-backup/runs/${id}`);

// ===== SSH =====
export const getSshStatus = () => fetchJSON('/settings/ssh/status');
export const generateSshKey = () => postJSON('/settings/ssh/generate', {});
export const authorizeLocalSsh = () => postJSON('/settings/ssh/authorize-localhost', {});
export const testSshConnection = (data) => postJSON('/settings/ssh/test', data);

// ===== Authorized Peers =====
export const getPeers = () => fetchJSON('/peers');
export const getPeer = (id) => fetchJSON(`/peers/${id}`);
export const createPeer = (data) => postJSON('/peers', data);
export const updatePeer = (id, data) => putJSON(`/peers/${id}`, data);
export const deletePeer = (id) => deleteJSON(`/peers/${id}`);
export const regeneratePeerKey = (id) => postJSON(`/peers/${id}/regenerate-key`, {});
export const getPeerAuditLog = (id, page = 1) => fetchJSON(`/peers/${id}/audit-log?page=${page}`);
export const getAllPeerAuditLog = (page = 1) => fetchJSON(`/peers/audit-log/all?page=${page}`);

// ===== Rclone =====
export const getRcloneRemotes = () => fetchJSON('/rclone/remotes');
export const getRcloneProviders = () => fetchJSON('/rclone/providers');
export const getRcloneRemoteConfig = (name) => fetchJSON(`/rclone/remotes/${encodeURIComponent(name)}/config`);
export const createRcloneRemote = (data) => postJSON('/rclone/remotes', data);
export const updateRcloneRemote = (name, params) => putJSON(`/rclone/remotes/${encodeURIComponent(name)}`, { params });
export const deleteRcloneRemote = (name) => deleteJSON(`/rclone/remotes/${encodeURIComponent(name)}`);
export const testRcloneRemote = (name) => postJSON(`/rclone/remotes/${encodeURIComponent(name)}/test`, {});
export const browseRemote = (name, path = '') => fetchJSON(`/rclone/remote/${name}/ls?path=${encodeURIComponent(path)}`);
export const getRcloneJobs = () => fetchJSON('/rclone/jobs');
export const getRcloneJob = (id) => fetchJSON(`/rclone/jobs/${id}`);
export const createRcloneJob = (data) => postJSON('/rclone/jobs', data);
export const updateRcloneJob = (id, data) => putJSON(`/rclone/jobs/${id}`, data);
export const deleteRcloneJob = (id) => deleteJSON(`/rclone/jobs/${id}`);
export const triggerRcloneSync = (id) => postJSON(`/rclone/jobs/${id}/run`, {});
export const getRcloneRuns = (page = 1, jobId) => {
  let url = `/rclone/runs?page=${page}`;
  if (jobId) url += `&job_id=${jobId}`;
  return fetchJSON(url);
};
export const getRcloneRunDetail = (id) => fetchJSON(`/rclone/runs/${id}`);

// ===== Docker =====
export const getDockerStatus = () => fetchJSON('/docker/status');
export const getDockerContainers = () => fetchJSON('/docker/containers');
export const dockerAction = (id, action) => postJSON(`/docker/containers/${id}/${action}`, {});
export const getContainerStats = (id) => fetchJSON(`/docker/containers/${id}/stats`);
export const getContainerMetrics = (id, hours = 24) => fetchJSON(`/docker/containers/${id}/metrics?hours=${hours}`);

// ===== Media Import =====
export const getMediaDrives = () => fetchJSON('/media-import/drives');
export const getKnownDrives = () => fetchJSON('/media-import/drives/known');
export const getMediaDrive = (id) => fetchJSON(`/media-import/drives/${id}`);
export const updateMediaDrive = (id, data) => putJSON(`/media-import/drives/${id}`, data);
export const scanDrive = (id) => postJSON(`/media-import/drives/${id}/scan`, {});
export const getScanProgress = (id) => fetchJSON(`/media-import/drives/${id}/scan`);
export const startDriveImport = (id) => postJSON(`/media-import/drives/${id}/import`, {});
export const getImportProgress = (runId) => fetchJSON(`/media-import/runs/${runId}/progress`);
export const ejectDrive = (id) => postJSON(`/media-import/drives/${id}/eject`, {});
export const getMediaImportRuns = (page = 1, driveId) => {
  let url = `/media-import/runs?page=${page}`;
  if (driveId) url += `&drive_id=${driveId}`;
  return fetchJSON(url);
};
export const getMediaImportRunDetail = (id) => fetchJSON(`/media-import/runs/${id}`);
export const testImmichConnection = () => postJSON('/media-import/test-immich', {});
export const getMediaImportStatus = () => fetchJSON('/media-import/status');

// ===== Filesystem =====
export const browseDirectory = (dir) => fetchJSON(`/filesystem/browse?dir=${encodeURIComponent(dir || '')}`);
export const getFilesystemRoots = () => fetchJSON('/filesystem/roots');

// ===== Notifications =====
export const testNtfy = () => postJSON('/settings/ntfy-test', {});
export const testBrowserNotify = () => postJSON('/settings/browser-notify-test', {});

// ===== Database Backup & Recovery =====
export const backupDbTo = (destPath) => postJSON('/settings/db/backup', { dest_path: destPath });
export const backupDbToAll = () => postJSON('/settings/db/backup-all', {});
export const getDbBackups = (destPath) => fetchJSON(`/settings/db/backups?dest_path=${encodeURIComponent(destPath)}`);
export const getDbRecoveryScan = (paths = []) => {
  const q = paths.length ? `?paths=${paths.map(encodeURIComponent).join(',')}` : '';
  return fetchJSON(`/settings/db/recovery-scan${q}`);
};
export const getDbRecoveryInfo = (destPath) => fetchJSON(`/settings/db/recovery-info?dest_path=${encodeURIComponent(destPath)}`);
export const restoreDb = (backupPath) => postJSON('/settings/db/restore', { backup_path: backupPath });

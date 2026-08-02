const API_BASE = '/api';

function getCookie(name) {
  if (typeof document === 'undefined') return null;
  const prefix = `${encodeURIComponent(name)}=`;
  const part = document.cookie.split('; ').find(cookie => cookie.startsWith(prefix));
  return part ? decodeURIComponent(part.slice(prefix.length)) : null;
}

async function fetchJSON(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const headers = new Headers(options.headers || {});
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    const csrfToken = getCookie('redman_csrf');
    if (csrfToken) headers.set('X-CSRF-Token', csrfToken);
  }
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    credentials: 'same-origin',
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    const requestError = new Error(error.error || `HTTP ${res.status}`);
    requestError.status = res.status;
    if (res.status === 401 && !['/auth/login', '/auth/bootstrap', '/auth/recover'].includes(path)) {
      globalThis.dispatchEvent?.(new CustomEvent('redman:auth-required'));
    }
    throw requestError;
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

// ===== Authentication =====
export const getAuthStatus = () => fetchJSON('/auth/status');
export const getAuthSession = () => fetchJSON('/auth/session');
export const bootstrapAuth = (data) => postJSON('/auth/bootstrap', data);
export const loginAuth = (data) => postJSON('/auth/login', data);
export const recoverAuth = (data) => postJSON('/auth/recover', data);
export const logoutAuth = () => postJSON('/auth/logout', {});
export const changeAuthPassword = (data) => postJSON('/auth/password', data);
export const getAuthUsers = () => fetchJSON('/auth/users');
export const createAuthUser = (data) => postJSON('/auth/users', data);
export const updateAuthUser = (id, data) => putJSON(`/auth/users/${id}`, data);
export const revokeAuthUserSessions = (id) => postJSON(`/auth/users/${id}/revoke-sessions`, {});
export const getAuthAudit = (page = 1) => fetchJSON(`/auth/audit?page=${page}`);

// ===== Settings =====
export const getSettings = () => fetchJSON('/settings');
export const getPublicSettings = () => fetchJSON('/settings/public');
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
export const cancelSsdBackup = (runId) => postJSON(`/ssd-backup/runs/${runId}/cancel`, {});
export const getSsdRuns = (page = 1, configId) => {
  let url = `/ssd-backup/runs?page=${page}`;
  if (configId) url += `&config_id=${configId}`;
  return fetchJSON(url);
};
export const getSsdRunDetail = (id, { action, filePage, fileLimit } = {}) => {
  let url = `/ssd-backup/runs/${id}?`;
  if (action) url += `&action=${encodeURIComponent(action)}`;
  if (filePage) url += `&filePage=${filePage}`;
  if (fileLimit) url += `&fileLimit=${fileLimit}`;
  return fetchJSON(url);
};
export const getSsdRunProgress = (id) => fetchJSON(`/ssd-backup/runs/${id}/progress`);

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
export const restoreSsdFile = (configId, timestamp, path, verify = true) =>
  postJSON(`/ssd-backup/configs/${configId}/restore`, { timestamp, path, verify });
export const verifySsdVersions = (configId) =>
  postJSON(`/ssd-backup/configs/${configId}/verify-versions`, {});

// ===== Hyper Backup =====
export const getHyperJobs = () => fetchJSON('/hyper-backup/jobs');
export const getHyperJob = (id) => fetchJSON(`/hyper-backup/jobs/${id}`);
export const createHyperJob = (data) => postJSON('/hyper-backup/jobs', data);
export const updateHyperJob = (id, data) => putJSON(`/hyper-backup/jobs/${id}`, data);
export const deleteHyperJob = (id) => deleteJSON(`/hyper-backup/jobs/${id}`);
export const triggerHyperBackup = (id) => postJSON(`/hyper-backup/jobs/${id}/run`, {});
export const cancelHyperBackup = (runId) => postJSON(`/hyper-backup/runs/${runId}/cancel`, {});
export const testHyperConnection = (data) => postJSON('/hyper-backup/test-connection', data);
export const getHyperRuns = (page = 1, jobId) => {
  let url = `/hyper-backup/runs?page=${page}`;
  if (jobId) url += `&job_id=${jobId}`;
  return fetchJSON(url);
};
export const getHyperRunDetail = (id) => fetchJSON(`/hyper-backup/runs/${id}`);
export const getHyperRunProgress = (id) => fetchJSON(`/hyper-backup/runs/${id}/progress`);
export const browseRemotePeer = (remoteUrl, dir) => {
  let url = `/hyper-backup/remote-browse?remote_url=${encodeURIComponent(remoteUrl)}`;
  if (dir) url += `&dir=${encodeURIComponent(dir)}`;
  return fetchJSON(url);
};
export const getRemotePeerRoots = (remoteUrl) =>
  fetchJSON(`/hyper-backup/remote-roots?remote_url=${encodeURIComponent(remoteUrl)}`);
export const getRemotePeerShares = (remoteUrl) =>
  fetchJSON(`/hyper-backup/remote-shares?remote_url=${encodeURIComponent(remoteUrl)}`);

// ===== SSH =====
export const getSshStatus = () => fetchJSON('/settings/ssh/status');
export const generateSshKey = () => postJSON('/settings/ssh/generate', {});
export const authorizeLocalSsh = () => postJSON('/settings/ssh/authorize-localhost', {});
export const testSshConnection = (data) => postJSON('/settings/ssh/test', data);

// ===== Authorized Peers =====
export const getPeers = () => fetchJSON('/peers');
export const getPeerConnectivity = () => fetchJSON('/peers/connectivity');
export const getPeer = (id) => fetchJSON(`/peers/${id}`);
export const createPeer = (data) => postJSON('/peers', data);
export const updatePeer = (id, data) => putJSON(`/peers/${id}`, data);
export const deletePeer = (id) => deleteJSON(`/peers/${id}`);
export const regeneratePeerKey = (id) => postJSON(`/peers/${id}/regenerate-key`, {});
export const getPeerAuditLog = (id, page = 1) => fetchJSON(`/peers/${id}/audit-log?page=${page}`);
export const getAllPeerAuditLog = (page = 1) => fetchJSON(`/peers/audit-log/all?page=${page}`);

// ===== Pairing =====
export const initiatePairing = (remoteUrl, reciprocalOffer = null) =>
  postJSON('/peers/pair', { remote_url: remoteUrl, reciprocal_offer: reciprocalOffer });
export const getPairingIncoming = () => fetchJSON('/peers/pair/incoming');
export const getPairingStatus = (id) => fetchJSON(`/peers/pair/status/${id}`);
export const getPairingHistory = () => fetchJSON('/peers/pair/history');
export const acceptPairing = (id, access) => postJSON(`/peers/pair/${id}/accept`, access);
export const declinePairing = (id) => postJSON(`/peers/pair/${id}/decline`, {});
export const deletePairing = (id) => deleteJSON(`/peers/pair/${id}`);
export const syncPairings = () => postJSON('/peers/pair/sync', {});

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
export const cancelRcloneSync = (runId) => postJSON(`/rclone/runs/${runId}/cancel`, {});
export const getRcloneRuns = (page = 1, jobId) => {
  let url = `/rclone/runs?page=${page}`;
  if (jobId) url += `&job_id=${jobId}`;
  return fetchJSON(url);
};
export const getRcloneRunDetail = (id) => fetchJSON(`/rclone/runs/${id}`);
export const getRcloneRunProgress = (id) => fetchJSON(`/rclone/runs/${id}/progress`);

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
export const cancelDriveImport = (runId) => postJSON(`/media-import/runs/${runId}/cancel`, {});
export const getImportProgress = (runId) => fetchJSON(`/media-import/runs/${runId}/progress`);
export const ejectDrive = (id) => postJSON(`/media-import/drives/${id}/eject`, {});
export const getMediaImportRuns = (page = 1, driveId) => {
  let url = `/media-import/runs?page=${page}`;
  if (driveId) url += `&drive_id=${driveId}`;
  return fetchJSON(url);
};
export const getMediaImportRunDetail = (id) => fetchJSON(`/media-import/runs/${id}`);
export const getMediaImportRunFiles = (id, action) => {
  let url = `/media-import/runs/${id}/files`;
  if (action) url += `?action=${action}`;
  return fetchJSON(url);
};
export const testImmichConnection = () => postJSON('/media-import/test-immich', {});
export const getMediaImportStatus = () => fetchJSON('/media-import/status');

// ===== Filesystem =====
export const browseDirectory = (dir) => fetchJSON(`/filesystem/browse?dir=${encodeURIComponent(dir || '')}`);
export const getFilesystemRoots = () => fetchJSON('/filesystem/roots');
export const getAllFilesystemRoots = () => fetchJSON('/filesystem/roots?include_hidden=true');

// ===== Notifications =====
export const testNtfy = () => postJSON('/settings/ntfy-test', {});
export const testBrowserNotify = () => postJSON('/settings/browser-notify-test', {});

// ===== Discovery =====
export const discoverPeers = (refresh = false) => fetchJSON(`/discovery/peers${refresh ? '?refresh=true' : ''}`);
export const discoverImmich = (refresh = false) => fetchJSON(`/discovery/immich${refresh ? '?refresh=true' : ''}`);
export const getDiscoverySubnets = (refresh = false) => fetchJSON(`/discovery/subnets${refresh ? '?refresh=true' : ''}`);
export const clearDiscoveryCache = () => postJSON('/discovery/clear-cache', {});

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

// ===== Hardened Upgrade Readiness =====
export const getUpgradeReadiness = () => fetchJSON('/upgrade-readiness');export const createUpgradeReadinessBackup = () => postJSON('/upgrade-readiness/backup', {});
export const remediateUpgradeReadinessIssue = (issueId) => postJSON('/upgrade-readiness/remediate', { issueId });
export const createUpgradeHostPlan = (data) => postJSON('/upgrade-readiness/host-plan', data);
export const createUpgradeFinalConfig = (data) => postJSON('/upgrade-readiness/final-config', data);

// ===== External Jobs (heartbeat-reported schedules on other hosts) =====
export const getExternalJobs = () => fetchJSON('/external-jobs');
export const createExternalJob = (data) => postJSON('/external-jobs', data);
export const updateExternalJob = (id, data) => putJSON(`/external-jobs/${id}`, data);
export const deleteExternalJob = (id) => deleteJSON(`/external-jobs/${id}`);
export const regenerateExternalJobToken = (id) => postJSON(`/external-jobs/${id}/regenerate-token`, {});
export const getExternalJobRuns = (jobId = null, page = 1, limit = 50) => {
  const params = new URLSearchParams({ page, limit });
  if (jobId) params.set('job_id', jobId);
  return fetchJSON(`/external-jobs/runs?${params}`);
};

// ===== Event history =====
export const getEvents = (filters = {}, page = 1, limit = 50) => {
  const params = new URLSearchParams({ page, limit });
  for (const key of ['severity', 'category', 'type', 'since']) {
    if (filters[key]) params.set(key, filters[key]);
  }
  return fetchJSON(`/events?${params}`);
};
export const getEventSummary = (since = '-24 hours') =>
  fetchJSON(`/events/summary?since=${encodeURIComponent(since)}`);

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  getMediaDrives, getKnownDrives, updateMediaDrive, scanDrive, getScanProgress,
  startDriveImport, cancelDriveImport, getImportProgress, ejectDrive, getMediaImportRuns,
  getMediaImportStatus, getMediaImportRunFiles,
  getMediaImportSources, createMediaImportSource, createOnlineMediaImportSource, deleteMediaImportSource,
  discoverOnlineTakeout, getRcloneRemotes,
} from '../api/index.js';
import useReconnect from '../hooks/useReconnect.js';
import { useSettings } from '../contexts/SettingsContext.jsx';
import { formatDateTime, formatDateShort as fmtDateShort } from '../utils/dateFormat.js';
import StatusBadge from '../components/StatusBadge.jsx';
import {
  Camera, HardDrive, Search, Upload, LogOut, RefreshCw,
  Image, Video, Folder, Clock, AlertTriangle, Info, CheckCircle, X,
  FileCheck, FileX, Copy, FolderPlus, Trash2, Package, Cloud,
} from 'lucide-react';
import JobProgress from '../components/JobProgress.jsx';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import PathPicker from '../components/PathPicker.jsx';
import RcloneRemotePathPicker from '../components/RcloneRemotePathPicker.jsx';
import { DialogSurface } from '../components/Dialog.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import './MediaImportPage.css';

export default function MediaImportPage() {
  const auth = useAuth();
  const { settings } = useSettings();
  const [drives, setDrives] = useState([]);
  const [knownDrives, setKnownDrives] = useState([]);
  const [sources, setSources] = useState([]);
  const [sourceDialogOpen, setSourceDialogOpen] = useState(false);
  const [deleteSourceTarget, setDeleteSourceTarget] = useState(null);
  const [runs, setRuns] = useState([]);
  const [runsPage, setRunsPage] = useState(1);
  const [runsMeta, setRunsMeta] = useState({ total: 0, pages: 1 });
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeImports, setActiveImports] = useState({});
  const [detailRun, setDetailRun] = useState(null);
  const [detailFiles, setDetailFiles] = useState(null);
  const [detailFilter, setDetailFilter] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionResult, setActionResult] = useState(null);
  const [deleteVerifiedTarget, setDeleteVerifiedTarget] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const scanPollRef = useRef(new Set());

  const refresh = useCallback(async () => {
    try {
      const [d, k, r, s, src] = await Promise.all([
        getMediaDrives(),
        getKnownDrives(),
        getMediaImportRuns(runsPage),
        getMediaImportStatus(),
        getMediaImportSources(),
      ]);
      setDrives(d);
      setKnownDrives(k.filter(kd => !d.some(cd => cd.id === kd.id)));
      setRuns(r.runs);
      setRunsMeta({ total: r.total, pages: r.pages });
      setStatus(s);
      setSources(src);
    } catch (err) {
      setActionResult({ type: 'error', message: err.message });
    }
    setLoading(false);
  }, [runsPage]);

  useEffect(() => { refresh(); }, [refresh]);
  useReconnect(refresh);

  // Auto-refresh every 10s
  useEffect(() => {
    const interval = setInterval(refresh, 10000);
    return () => clearInterval(interval);
  }, [refresh]);

  // Clear any in-flight scan polls on unmount
  useEffect(() => {
    return () => {
      for (const id of scanPollRef.current) clearInterval(id);
      scanPollRef.current.clear();
    };
  }, []);

  // Poll active imports for progress
  useEffect(() => {
    const importRunIds = Object.keys(activeImports);
    if (importRunIds.length === 0) return;

    const interval = setInterval(async () => {
      for (const runId of importRunIds) {
        try {
          const progress = await getImportProgress(runId);
          if (progress.status === 'completed' || progress.status === 'failed' || progress.status === 'none') {
            setActiveImports(prev => {
              const next = { ...prev };
              delete next[runId];
              return next;
            });
            refresh();
          } else {
            setActiveImports(prev => ({ ...prev, [runId]: progress }));
          }
        } catch (err) {
          setActionResult({ type: 'error', message: `Import progress unavailable: ${err.message}` });
        }
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [activeImports, refresh]);

  async function handleScan(driveId) {
    try {
      await scanDrive(driveId);
      // Poll for scan completion
      const pollScan = setInterval(async () => {
        try {
          const progress = await getScanProgress(driveId);
          if (progress.status === 'completed' || progress.status === 'failed') {
            clearInterval(pollScan);
            scanPollRef.current.delete(pollScan);
            if (progress.status === 'failed') setActionResult({ type: 'error', message: progress.error || 'Drive scan failed' });
            refresh();
          }
        } catch (err) {
          clearInterval(pollScan);
          scanPollRef.current.delete(pollScan);
          setActionResult({ type: 'error', message: `Drive scan unavailable: ${err.message}` });
        }
      }, 1000);
      scanPollRef.current.add(pollScan);
    } catch (err) {
      setActionResult({ type: 'error', message: err.message });
    }
  }

  async function handleImport(driveId) {
    try {
      const result = await startDriveImport(driveId);
      setActiveImports(prev => ({ ...prev, [result.runId]: { status: 'running', percent: 0 } }));
    } catch (err) {
      setActionResult({ type: 'error', message: err.message });
    }
  }

  async function handleEject(driveId) {
    try {
      const result = await ejectDrive(driveId);
      if (!result.ok) setActionResult({ type: 'error', message: `Eject failed: ${result.error}` });
      else {
        setActionResult({ type: 'success', message: 'Drive ejected safely.' });
        refresh();
      }
    } catch (err) {
      setActionResult({ type: 'error', message: err.message });
    }
  }

  async function handleToggle(driveId, key, value) {
    try {
      await updateMediaDrive(driveId, { [key]: value ? 1 : 0 });
      refresh();
      return true;
    } catch (err) {
      setActionResult({ type: 'error', message: err.message });
      return false;
    }
  }

  async function confirmDeleteVerified() {
    setConfirming(true);
    const updated = await handleToggle(deleteVerifiedTarget.id, 'delete_after_import', true);
    setConfirming(false);
    if (updated) {
      setActionResult({ type: 'success', message: `Verified-source deletion enabled for ${deleteVerifiedTarget.name || deleteVerifiedTarget.label}.` });
      setDeleteVerifiedTarget(null);
    }
  }

  async function handleCreateSource(payload) {
    const source = payload.source_kind === 'online'
      ? await createOnlineMediaImportSource(payload)
      : await createMediaImportSource(payload);
    setSourceDialogOpen(false);
    setActionResult({ type: 'success', message: `Import source “${payload.name}” added.` });
    if (payload.source_kind === 'online') {
      const result = await startDriveImport(source.id);
      setActiveImports(prev => ({ ...prev, [result.runId]: { status: 'running', phase: 'listing', driveId: source.id, percent: 0 } }));
      setActionResult({ type: 'success', message: `Online import “${payload.name}” started.` });
    }
    refresh();
  }

  async function confirmDeleteSource() {
    setConfirming(true);
    try {
      await deleteMediaImportSource(deleteSourceTarget.id);
      setActionResult({ type: 'success', message: `Import source “${deleteSourceTarget.name}” removed. Its import history was kept.` });
      setDeleteSourceTarget(null);
      refresh();
    } catch (err) {
      setActionResult({ type: 'error', message: err.message });
    }
    setConfirming(false);
  }
  async function openRunDetail(run, filterAction = null) {
    setDetailRun(run);
    setDetailFilter(filterAction);
    setDetailLoading(true);
    try {
      const data = await getMediaImportRunFiles(run.id, filterAction);
      setDetailFiles(data);
    } catch { setDetailFiles({ files: [], summary: [] }); }
    setDetailLoading(false);
  }

  async function changeDetailFilter(action) {
    if (!detailRun) return;
    setDetailFilter(action);
    setDetailLoading(true);
    try {
      const data = await getMediaImportRunFiles(detailRun.id, action);
      setDetailFiles(data);
    } catch { setDetailFiles({ files: [], summary: [] }); }
    setDetailLoading(false);
  }

  if (loading) return <div className="empty-state"><p>Loading...</p></div>;

  return (
    <div className="media-import-page">
      <div className="page-header">
        <h1><Camera size={24} /> Media Import</h1>
        <div className="page-header-actions">
          {status && !status.immichGoAvailable && (
            <span className="status-warning"><AlertTriangle size={14} /> immich-go not found</span>
          )}
          <button className="btn btn-ghost btn-sm" onClick={refresh}><RefreshCw size={14} /> Refresh</button>
        </div>
      </div>

      {actionResult && (
        <div className={`alert alert-${actionResult.type}`} role={actionResult.type === 'error' ? 'alert' : 'status'}>
          {actionResult.message}
        </div>
      )}

      {/* Connected Drives */}
      <section>
        <h2 className="section-title"><HardDrive size={16} /> Connected Drives</h2>
        {drives.length === 0 ? (
          <div className="card empty-state">
            <HardDrive size={32} />
            <p>No drives detected under <code>/mnt/disks/</code></p>
            <span className="form-hint">Insert a USB drive or SD card to get started</span>
          </div>
        ) : (
          <div className="drive-grid">
            {drives.map(drive => (
              <DriveCard
                key={drive.mountPath || drive.id}
                drive={drive}
                activeImport={Object.values(activeImports).find(i => i.driveId === drive.id)}
                onCancel={() => {
                  const entry = Object.entries(activeImports).find(([, i]) => i.driveId === drive.id);
                  if (entry) cancelDriveImport(parseInt(entry[0])).then(() => refresh());
                }}
                onScan={() => handleScan(drive.id)}
                onImport={() => handleImport(drive.id)}
                onEject={() => handleEject(drive.id)}
                ejectSupported={!!status?.ejectSupported}
                canManage={auth.isAdmin}
                onToggle={(key, val) => handleToggle(drive.id, key, val)}
                onRequestDeleteVerified={() => { setActionResult(null); setDeleteVerifiedTarget(drive); }}
              />
            ))}
          </div>
        )}
      </section>

      {/* Folder sources */}
      <section>
        <div className="section-header">
          <h2 className="section-title"><Folder size={16} /> Import Sources</h2>
          {auth.isAdmin && (
            <button className="btn btn-secondary btn-sm" onClick={() => { setActionResult(null); setSourceDialogOpen(true); }}>
              <FolderPlus size={14} /> Add Source
            </button>
          )}
        </div>
        {sources.length === 0 ? (
          <div className="card empty-state">
            <Folder size={32} />
            <p>No import sources</p>
            <span className="form-hint">
              Add a folder on this machine or import a Google Photos Takeout directly from Google Drive.
            </span>
          </div>
        ) : (
          <div className="drive-grid">
            {sources.map(source => (
              <FolderSourceCard
                key={source.id}
                source={source}
                activeImport={Object.values(activeImports).find(i => i.driveId === source.id)}
                onCancel={() => {
                  const entry = Object.entries(activeImports).find(([, i]) => i.driveId === source.id);
                  if (entry) cancelDriveImport(parseInt(entry[0])).then(() => refresh());
                }}
                onImport={() => handleImport(source.id)}
                onDelete={() => { setActionResult(null); setDeleteSourceTarget(source); }}
                canManage={auth.isAdmin}
              />
            ))}
          </div>
        )}
      </section>

      {sourceDialogOpen && (
        <FolderSourceDialog
          onClose={() => setSourceDialogOpen(false)}
          onCreate={handleCreateSource}
        />
      )}

      {deleteSourceTarget && (
        <ConfirmDialog
          title="Remove import source"
          confirmLabel="Remove source"
          destructive
          busy={confirming}
          onClose={() => setDeleteSourceTarget(null)}
          onConfirm={confirmDeleteSource}
        >
          <p>Stop tracking <strong>{deleteSourceTarget.name}</strong> as an import source.</p>
          <p className="form-hint">
            Nothing is deleted from disk and the import history is kept. The folder can be added again later.
          </p>
        </ConfirmDialog>
      )}

      {deleteVerifiedTarget && (
        <ConfirmDialog title="Enable verified-source deletion" confirmLabel="Enable deletion" destructive busy={confirming} error={actionResult?.type === 'error' ? actionResult.message : null} onClose={() => setDeleteVerifiedTarget(null)} onConfirm={confirmDeleteVerified}>
          <p>After a successful or partial import, RedMan may delete source files from <strong>{deleteVerifiedTarget.name || deleteVerifiedTarget.label}</strong>.</p>
          <p className="form-hint">Only files individually verified by Immich and unchanged since upload are eligible. Failed, unknown, changed, or unsafe files remain on the drive.</p>
        </ConfirmDialog>
      )}

      {/* Import History */}
      <section>
        <h2 className="section-title"><Clock size={16} /> Import History</h2>
        {runs.length === 0 ? (
          <div className="card empty-state">
            <p>No imports yet</p>
          </div>
        ) : (
          <>
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Drive</th>
                    <th>Started</th>
                    <th>Duration</th>
                    <th>Uploaded</th>
                    <th>Errors</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map(run => (
                    <tr key={run.id} className="clickable-row" onClick={() => openRunDetail(run)}>
                      <td><StatusBadge status={run.status} /></td>
                      <td>{run.drive_name || run.drive_label || `Drive #${run.config_id}`}</td>
                      <td>{formatDateTime(run.started_at, settings)}</td>
                      <td>{run.duration_seconds ? formatDuration(run.duration_seconds) : '—'}</td>
                      <td>{run.files_copied ?? 0}</td>
                      <td>{run.files_failed > 0 ? <span className="text-danger">{run.files_failed}</span> : 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {runsMeta.pages > 1 && (
              <div className="pagination">
                <button className="btn btn-ghost btn-sm" disabled={runsPage <= 1} onClick={() => setRunsPage(p => p - 1)}>← Prev</button>
                <span>Page {runsPage} of {runsMeta.pages}</span>
                <button className="btn btn-ghost btn-sm" disabled={runsPage >= runsMeta.pages} onClick={() => setRunsPage(p => p + 1)}>Next →</button>
              </div>
            )}
          </>
        )}
      </section>

      {/* Known (disconnected) Drives */}
      {knownDrives.length > 0 && (
        <section>
          <h2 className="section-title" style={{ color: 'var(--color-text-muted)' }}>
            <HardDrive size={16} /> Known Drives (disconnected)
          </h2>
          <div className="drive-grid">
            {knownDrives.map(drive => (
              <div key={drive.id} className="card drive-card drive-card-disconnected">
                <div className="drive-card-header">
                  <span className="drive-name">{drive.name || drive.label}</span>
                  <span className="drive-status disconnected">Disconnected</span>
                </div>
                <div className="drive-meta">
                  {drive.detected_camera && <span>📸 {drive.detected_camera}</span>}
                  {drive.last_seen_at && <span>Last seen: {formatDateTime(drive.last_seen_at, settings)}</span>}
                  {drive.last_import_at && <span>Last import: {formatDateTime(drive.last_import_at, settings)}</span>}
                  {drive.auto_import ? <span className="badge badge-auto">Auto-import on</span> : null}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
      {/* Run Detail Modal */}
      {detailRun && (
        <DialogSurface ariaLabel={`Import details for ${detailRun.drive_name || detailRun.drive_label}`} className="modal-lg" onClose={() => { setDetailRun(null); setDetailFiles(null); }}>
            <div className="modal-header">
              <h3>Import Details — {detailRun.drive_name || detailRun.drive_label}</h3>
              <button className="btn btn-ghost btn-sm" onClick={() => { setDetailRun(null); setDetailFiles(null); }} title="Close" aria-label="Close import details">
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            <div className="modal-body">
              <div className="run-detail-meta">
                <StatusBadge status={detailRun.status} />
                <span>{formatDateTime(detailRun.started_at, settings)}</span>
                <span>{detailRun.duration_seconds ? formatDuration(detailRun.duration_seconds) : '—'}</span>
                <span>{detailRun.files_copied ?? 0} uploaded</span>
                {detailRun.files_failed > 0 && <span className="text-danger">{detailRun.files_failed} errors</span>}
              </div>

              {/* Photo date range — where to find them in Immich */}
              {detailFiles?.dateRange?.earliest && (
                <div className="photo-date-range">
                  <Clock size={14} />
                  <span>
                    Photos dated: <strong>{fmtDateShort(detailFiles.dateRange.earliest, settings)}</strong>
                    {detailFiles.dateRange.latest !== detailFiles.dateRange.earliest && (
                      <> — <strong>{fmtDateShort(detailFiles.dateRange.latest, settings)}</strong></>
                    )}
                  </span>
                  <span className="form-hint">Find them in Immich's timeline around this date</span>
                </div>
              )}

              {/* Filter tabs */}
              {detailFiles && detailFiles.summary && (
                <div className="detail-filter-tabs">
                  <button
                    className={`btn btn-sm ${!detailFilter ? 'btn-primary' : 'btn-ghost'}`}
                    onClick={() => changeDetailFilter(null)}
                  >
                    All ({detailFiles.summary.reduce((a, s) => a + s.count, 0)})
                  </button>
                  {detailFiles.summary.map(s => (
                    <button
                      key={s.action}
                      className={`btn btn-sm ${detailFilter === s.action ? 'btn-primary' : 'btn-ghost'}`}
                      onClick={() => changeDetailFilter(s.action)}
                    >
                      {s.action === 'uploaded' && <><FileCheck size={13} /> Uploaded ({s.count})</>}
                      {s.action === 'error' && <><FileX size={13} /> Errors ({s.count})</>}
                      {s.action === 'duplicate' && <><Copy size={13} /> Duplicates ({s.count})</>}
                    </button>
                  ))}
                </div>
              )}

              {/* File list */}
              {detailLoading ? (
                <p>Loading...</p>
              ) : detailFiles && detailFiles.files.length > 0 ? (
                <div className="table-wrapper detail-file-table">
                  <table>
                    <thead>
                      <tr>
                        <th>File</th>
                        <th>Status</th>
                        <th>Photo Date</th>
                        <th>Error</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detailFiles.files.map(f => (
                        <tr key={f.id} className={f.action === 'error' ? 'row-error' : ''}>
                          <td className="file-path-cell">{f.file_path}</td>
                          <td>
                            {f.action === 'uploaded' && <span className="badge badge-success"><FileCheck size={12} /> Uploaded</span>}
                            {f.action === 'error' && <span className="badge badge-danger"><FileX size={12} /> Error</span>}
                            {f.action === 'duplicate' && <span className="badge badge-muted"><Copy size={12} /> Duplicate</span>}
                          </td>
                          <td className="date-cell">{f.file_date ? fmtDateShort(f.file_date, settings) : '—'}</td>
                          <td className="error-cell">{f.error || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-muted">No file details recorded for this run.</p>
              )}
            </div>
        </DialogSurface>
      )}
    </div>
  );
}

function DriveCard({ drive, activeImport, onScan, onImport, onEject, ejectSupported, canManage, onToggle, onRequestDeleteVerified, onCancel }) {
  const { settings } = useSettings();
  const scan = drive.scan;
  const isScanning = scan && scan.status === 'scanning';
  const scanDone = scan && scan.status === 'completed';
  const isImporting = !!activeImport;
  const isNew = drive.id && !drive.last_import_at;

  return (
    <div className="card drive-card">
      <div className="drive-card-header">
        <div className="drive-name-row">
          {drive.detected_camera ? <Camera size={16} /> : <HardDrive size={16} />}
          <span className="drive-name">{drive.name || drive.label || drive.mountPath}</span>
        </div>
        <span className="drive-status connected">Connected</span>
      </div>

      <div className="drive-meta">
        <span><Folder size={13} /> {drive.mountPath}</span>
        {drive.sizeHuman && <span>💾 {drive.sizeHuman}</span>}
        {drive.filesystem && drive.filesystem !== 'unknown' && <span>📁 {drive.filesystem}</span>}
        {drive.detected_camera && <span>📸 {drive.detected_camera}</span>}
        {drive.last_seen_at && <span>Last seen: {formatDateTime(drive.last_seen_at, settings)}</span>}
        {drive.last_import_at && <span>Last import: {formatDateTime(drive.last_import_at, settings)}</span>}
      </div>

      {/* Scan results */}
      {scanDone && (
        <div className="scan-results">
          <span><Image size={13} /> {scan.photos.toLocaleString()} photos</span>
          <span><Video size={13} /> {scan.videos.toLocaleString()} videos</span>
          {scan.otherFiles > 0 && <span>📄 {scan.otherFiles.toLocaleString()} other</span>}
          {scan.detectedCamera && <span>📸 {scan.detectedCamera}</span>}
        </div>
      )}

      {isScanning && (
        <div className="scan-progress">
          <RefreshCw size={14} className="spin" /> Scanning... {scan.photos} photos, {scan.videos} videos found
        </div>
      )}

      {/* Import progress */}
      {isImporting && (
        <JobProgress progress={activeImport} feature="media-import" onCancel={canManage ? onCancel : null} />
      )}

      {/* New drive suggestion */}
      {isNew && !isImporting && (
        <div className="new-drive-hint">
          <Info size={14} />
          <span>New drive! Enable auto-import so it imports automatically next time.</span>
        </div>
      )}

      {/* Toggles */}
      {canManage && <div className="drive-toggles">
        <label className="toggle-label-sm">
          <input type="checkbox" className="toggle"
            checked={!!drive.auto_import}
            onChange={e => onToggle('auto_import', e.target.checked)} />
          Auto-import
        </label>
        <label className="toggle-label-sm" title="Delete only files individually verified as uploaded or already present in Immich">
          <input type="checkbox" className="toggle"
            checked={!!drive.delete_after_import}
            onChange={e => {
              if (e.target.checked) onRequestDeleteVerified();
              else onToggle('delete_after_import', false);
            }} />
          Delete verified
        </label>
        <label className="toggle-label-sm">
          <input type="checkbox" className="toggle"
            checked={!!drive.eject_after_import}
            disabled={!ejectSupported}
            onChange={e => onToggle('eject_after_import', e.target.checked)} />
          {ejectSupported ? 'Eject after' : 'Eject unavailable'}
        </label>
      </div>}

      {/* Actions */}
      {canManage && <div className="drive-actions">
        <button className="btn btn-primary btn-sm" onClick={onImport} disabled={isImporting || isScanning}>
          <Upload size={14} /> Import Now
        </button>
        <button className="btn btn-secondary btn-sm" onClick={onScan} disabled={isScanning || isImporting}>
          <Search size={14} /> Scan
        </button>
        <button className="btn btn-ghost btn-sm" onClick={onEject} disabled={isImporting || !ejectSupported} title={ejectSupported ? 'Eject drive' : 'No host eject helper configured'}>
          <LogOut size={14} /> Eject
        </button>
      </div>}
    </div>
  );
}

function FolderSourceCard({ source, activeImport, onImport, onDelete, onCancel, canManage }) {
  const { settings } = useSettings();
  const isImporting = !!activeImport;
  const isTakeout = source.import_mode === 'google-photos';
  const isOnline = source.source_kind === 'online';

  return (
    <div className="card drive-card">
      <div className="drive-card-header">
        <div className="drive-name-row">
          {isOnline ? <Cloud size={16} /> : isTakeout ? <Package size={16} /> : <Folder size={16} />}
          <span className="drive-name">{source.name}</span>
        </div>
        <span className={`drive-status ${source.available ? 'connected' : 'disconnected'}`}>
          {source.available ? 'Available' : 'Missing'}
        </span>
      </div>

      <div className="drive-meta">
        <span><Folder size={13} /> {isOnline ? `${source.remote_name}:${source.remote_path}` : source.mount_path}</span>
        <span>{isOnline ? 'Google Photos Takeout import' : isTakeout ? 'Google Photos takeout' : 'Plain folder'}</span>
        {isOnline && <span>Staging: {source.mount_path}</span>}
        {isOnline && source.completed_archive_count > 0 && (
          <span>{source.completed_archive_count.toLocaleString()} archive{source.completed_archive_count === 1 ? '' : 's'} completed</span>
        )}
        {isTakeout && source.archive_count > 0 && (
          <span>{source.archive_count.toLocaleString()} archive{source.archive_count === 1 ? '' : 's'}</span>
        )}
        {source.last_import_at && <span>Last import: {formatDateTime(source.last_import_at, settings)}</span>}
      </div>

      {!isOnline && isTakeout && source.available && source.archive_count === 0 && (
        <div className="new-drive-hint">
          <Info size={14} />
          <span>No takeout archives here yet. Download them first — an Rclone job can pull them from Google Drive.</span>
        </div>
      )}

      {isImporting && (
        <JobProgress progress={activeImport} feature="media-import" onCancel={canManage ? onCancel : null} />
      )}

      {canManage && <div className="drive-actions">
        <button className="btn btn-primary btn-sm" onClick={onImport} disabled={isImporting || !source.available}>
          <Upload size={14} /> Import Now
        </button>
        <button className="btn btn-ghost btn-sm" onClick={onDelete} disabled={isImporting}>
          <Trash2 size={14} /> Remove
        </button>
      </div>}
    </div>
  );
}

function FolderSourceDialog({ onClose, onCreate }) {
  const [sourceKind, setSourceKind] = useState('folder');
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [importMode, setImportMode] = useState('folder');
  const [remotes, setRemotes] = useState([]);
  const [remoteName, setRemoteName] = useState('');
  const [remotePath, setRemotePath] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (sourceKind !== 'online') return;
    getRcloneRemotes().then(setRemotes).catch(err => setError(err.message));
  }, [sourceKind]);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onCreate(sourceKind === 'online'
        ? { name: name.trim(), source_kind: 'online', remote_name: remoteName, remote_path: remotePath }
        : { name: name.trim(), path, import_mode: importMode });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <DialogSurface ariaLabel="Add import source" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="modal-header">
          <h3>Add Import Source</h3>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="modal-body">
          {error && <div className="alert alert-error" role="alert">{error}</div>}

          <div className="form-group">
            <label htmlFor="source-kind">Source</label>
            <select id="source-kind" value={sourceKind} onChange={event => {
              const nextKind = event.target.value;
              setSourceKind(nextKind);
              if (nextKind === 'online') {
                setImportMode('google-photos');
                if (!name) setName('Google Photos takeout');
              }
            }}>
              <option value="folder">Folder on this machine</option>
              <option value="online">Google Photos Takeout import</option>
            </select>
          </div>

          <div className="form-group">
            <label htmlFor="source-name">Name</label>
            <input
              id="source-name"
              type="text"
              value={name}
              maxLength={100}
              onChange={event => setName(event.target.value)}
              placeholder="Google Photos takeout"
              required
            />
          </div>

          {sourceKind === 'online' && <div className="form-group">
            <label htmlFor="source-remote">Google Drive connection</label>
            <select id="source-remote" value={remoteName} onChange={async event => {
              const nextRemote = event.target.value;
              setRemoteName(nextRemote);
              setRemotePath('');
              if (!nextRemote) return;
              setError(null);
              try {
                const discovered = await discoverOnlineTakeout(nextRemote);
                setRemotePath(discovered.path);
              } catch (err) {
                setError(`${err.message}. Browse the remote to select it manually.`);
                setShowAdvanced(true);
              }
            }} required>
              <option value="">Select a connected remote...</option>
              {remotes.map(remote => <option key={remote} value={remote}>{remote}</option>)}
            </select>
            {remotes.length === 0 && <span className="form-hint">Connect Google Drive under Cloud Backup first.</span>}
          </div>}

          {sourceKind === 'folder' && <div className="form-group">
            <label>Folder</label>
            <PathPicker
              label="Folder"
              value={path}
              onChange={setPath}
              placeholder="/mnt/user/downloads/takeout"
            />
            <span className="form-hint">Must be inside a folder RedMan is allowed to read.</span>
          </div>}

          {sourceKind === 'online' && <div className="online-import-advanced">
            <button
              type="button"
              className="btn btn-ghost btn-sm online-import-advanced-toggle"
              aria-expanded={showAdvanced}
              onClick={() => setShowAdvanced(value => !value)}
            >
              Advanced options
            </button>
            {showAdvanced && <div className="online-import-advanced-fields">
              <div className="form-group">
                <label>Takeout folder</label>
                <RcloneRemotePathPicker
                  value={remotePath}
                  onChange={setRemotePath}
                  remoteName={remoteName}
                  placeholder="Detected automatically"
                  disabled={!remoteName}
                  required
                />
                <span className="form-hint">Normally detected automatically after selecting Google Drive.</span>
              </div>

            </div>}
          </div>}

          {sourceKind === 'folder' && <div className="form-group">
            <label htmlFor="source-mode">Contents</label>
            <select id="source-mode" value={importMode} onChange={event => setImportMode(event.target.value)}>
              <option value="folder">Photos and videos</option>
              <option value="google-photos">Google Photos takeout</option>
            </select>
            <span className="form-hint">
              {importMode === 'google-photos'
                ? 'Reads the takeout archives without unpacking them, and applies the dates, locations, and albums from their sidecar files.'
                : 'Uploads the files as they are, using whatever each file carries in its own metadata.'}
            </span>
          </div>}
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !name.trim() || (sourceKind === 'folder' && !path) || (sourceKind === 'online' && (!remoteName || !remotePath))}>
            {busy ? 'Adding...' : 'Add Source'}
          </button>
        </div>
      </form>
    </DialogSurface>
  );
}

function formatDuration(seconds) {
  if (!seconds) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

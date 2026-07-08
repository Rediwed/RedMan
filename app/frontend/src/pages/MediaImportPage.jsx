import { useState, useEffect, useCallback, useRef } from 'react';
import {
  getMediaDrives, getKnownDrives, updateMediaDrive, scanDrive, getScanProgress,
  startDriveImport, cancelDriveImport, getImportProgress, ejectDrive, getMediaImportRuns,
  getMediaImportStatus, getMediaImportRunFiles,
} from '../api/index.js';
import useReconnect from '../hooks/useReconnect.js';
import { useSettings } from '../contexts/SettingsContext.jsx';
import { formatDateTime, formatDateShort as fmtDateShort } from '../utils/dateFormat.js';
import StatusBadge from '../components/StatusBadge.jsx';
import {
  Camera, HardDrive, Search, Upload, LogOut, RefreshCw,
  Image, Video, Folder, Clock, AlertTriangle, Info, CheckCircle, X,
  FileCheck, FileX, Copy,
} from 'lucide-react';
import JobProgress from '../components/JobProgress.jsx';
import './MediaImportPage.css';

export default function MediaImportPage() {
  const { settings } = useSettings();
  const [drives, setDrives] = useState([]);
  const [knownDrives, setKnownDrives] = useState([]);
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
  const scanPollRef = useRef(new Set());

  const refresh = useCallback(async () => {
    try {
      const [d, k, r, s] = await Promise.all([
        getMediaDrives(),
        getKnownDrives(),
        getMediaImportRuns(runsPage),
        getMediaImportStatus(),
      ]);
      setDrives(d);
      setKnownDrives(k.filter(kd => !d.some(cd => cd.id === kd.id)));
      setRuns(r.runs);
      setRunsMeta({ total: r.total, pages: r.pages });
      setStatus(s);
    } catch { /* silent */ }
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
        } catch { /* silent */ }
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [activeImports, refresh]);

  async function handleScan(driveId) {
    try {
      await scanDrive(driveId);
      // Poll for scan completion
      const pollScan = setInterval(async () => {
        const progress = await getScanProgress(driveId);
        if (progress.status === 'completed' || progress.status === 'failed') {
          clearInterval(pollScan);
          scanPollRef.current.delete(pollScan);
          refresh();
        }
      }, 1000);
      scanPollRef.current.add(pollScan);
    } catch { /* silent */ }
  }

  async function handleImport(driveId) {
    try {
      const result = await startDriveImport(driveId);
      setActiveImports(prev => ({ ...prev, [result.runId]: { status: 'running', percent: 0 } }));
    } catch (err) {
      alert(err.message);
    }
  }

  async function handleEject(driveId) {
    try {
      const result = await ejectDrive(driveId);
      if (!result.ok) alert(`Eject failed: ${result.error}`);
      else refresh();
    } catch (err) {
      alert(err.message);
    }
  }

  async function handleToggle(driveId, key, value) {
    try {
      await updateMediaDrive(driveId, { [key]: value ? 1 : 0 });
      refresh();
    } catch { /* silent */ }
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
                onToggle={(key, val) => handleToggle(drive.id, key, val)}
              />
            ))}
          </div>
        )}
      </section>

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
        <div className="modal-overlay" onClick={() => { setDetailRun(null); setDetailFiles(null); }}>
          <div className="modal modal-lg" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Import Details — {detailRun.drive_name || detailRun.drive_label}</h3>
              <button className="btn btn-ghost btn-sm" onClick={() => { setDetailRun(null); setDetailFiles(null); }}>
                <X size={16} />
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
          </div>
        </div>
      )}
    </div>
  );
}

function DriveCard({ drive, activeImport, onScan, onImport, onEject, onToggle, onCancel }) {
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
        <JobProgress progress={activeImport} feature="media-import" onCancel={onCancel} />
      )}

      {/* New drive suggestion */}
      {isNew && !isImporting && (
        <div className="new-drive-hint">
          <Info size={14} />
          <span>New drive! Enable auto-import so it imports automatically next time.</span>
        </div>
      )}

      {/* Toggles */}
      <div className="drive-toggles">
        <label className="toggle-label-sm">
          <input type="checkbox" className="toggle"
            checked={!!drive.auto_import}
            onChange={e => onToggle('auto_import', e.target.checked)} />
          Auto-import
        </label>
        <label className="toggle-label-sm">
          <input type="checkbox" className="toggle"
            checked={!!drive.delete_after_import}
            onChange={e => onToggle('delete_after_import', e.target.checked)} />
          Delete after
        </label>
        <label className="toggle-label-sm">
          <input type="checkbox" className="toggle"
            checked={!!drive.eject_after_import}
            onChange={e => onToggle('eject_after_import', e.target.checked)} />
          Eject after
        </label>
      </div>

      {/* Actions */}
      <div className="drive-actions">
        <button className="btn btn-primary btn-sm" onClick={onImport} disabled={isImporting || isScanning}>
          <Upload size={14} /> Import Now
        </button>
        <button className="btn btn-secondary btn-sm" onClick={onScan} disabled={isScanning || isImporting}>
          <Search size={14} /> Scan
        </button>
        <button className="btn btn-ghost btn-sm" onClick={onEject} disabled={isImporting}>
          <LogOut size={14} /> Eject
        </button>
      </div>
    </div>
  );
}

function formatDuration(seconds) {
  if (!seconds) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

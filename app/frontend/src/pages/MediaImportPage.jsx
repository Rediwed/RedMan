import { useState, useEffect, useCallback } from 'react';
import {
  getMediaDrives, getKnownDrives, updateMediaDrive, scanDrive, getScanProgress,
  startDriveImport, getImportProgress, ejectDrive, getMediaImportRuns,
  getMediaImportStatus,
} from '../api/index.js';
import StatusBadge from '../components/StatusBadge.jsx';
import {
  Camera, HardDrive, Search, Upload, LogOut, RefreshCw,
  Image, Video, Folder, Clock, AlertTriangle, Info, CheckCircle,
} from 'lucide-react';
import JobProgress from '../components/JobProgress.jsx';
import './MediaImportPage.css';

export default function MediaImportPage() {
  const [drives, setDrives] = useState([]);
  const [knownDrives, setKnownDrives] = useState([]);
  const [runs, setRuns] = useState([]);
  const [runsPage, setRunsPage] = useState(1);
  const [runsMeta, setRunsMeta] = useState({ total: 0, pages: 1 });
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeImports, setActiveImports] = useState({});

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

  // Auto-refresh every 10s
  useEffect(() => {
    const interval = setInterval(refresh, 10000);
    return () => clearInterval(interval);
  }, [refresh]);

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
          refresh();
        }
      }, 1000);
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
                    <tr key={run.id}>
                      <td><StatusBadge status={run.status} /></td>
                      <td>{run.drive_name || run.drive_label || `Drive #${run.config_id}`}</td>
                      <td>{formatDate(run.started_at)}</td>
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
                  {drive.last_seen_at && <span>Last seen: {formatDate(drive.last_seen_at)}</span>}
                  {drive.last_import_at && <span>Last import: {formatDate(drive.last_import_at)}</span>}
                  {drive.auto_import ? <span className="badge badge-auto">Auto-import on</span> : null}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function DriveCard({ drive, activeImport, onScan, onImport, onEject, onToggle }) {
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
        {drive.last_seen_at && <span>Last seen: {formatDate(drive.last_seen_at)}</span>}
        {drive.last_import_at && <span>Last import: {formatDate(drive.last_import_at)}</span>}
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
        <JobProgress progress={activeImport} feature="media-import" />
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

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso + (iso.includes('Z') ? '' : 'Z'));
  return d.toLocaleDateString('nl-NL', { day: '2-digit', month: '2-digit', year: 'numeric' })
    + ' ' + d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
}

function formatDuration(seconds) {
  if (!seconds) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

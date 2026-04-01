import { useState, useEffect } from 'react';
import {
  getSsdConfigs, createSsdConfig, updateSsdConfig, deleteSsdConfig,
  triggerSsdBackup, getSsdRuns, getSsdRunDetail,
  getSsdSnapshots, browseSsdSnapshot, getSsdDownloadUrl, restoreSsdFile,
} from '../api/index.js';
import {
  HardDrive, Play, Pencil, Trash2, ClipboardList, Check, X, AlertTriangle,
  FolderOpen, FileText, Download, RotateCcw, ChevronRight, ArrowUp, Clock, FolderClosed, Search,
} from 'lucide-react';
import StatusBadge from '../components/StatusBadge.jsx';
import PathPicker from '../components/PathPicker.jsx';
import JobProgress from '../components/JobProgress.jsx';
import SchedulePicker, { describeCron } from '../components/SchedulePicker.jsx';
import useJobProgress from '../hooks/useJobProgress.js';
import './SsdBackupPage.css';

export default function SsdBackupPage() {
  const [configs, setConfigs] = useState([]);
  const [runs, setRuns] = useState({ runs: [], page: 1, totalPages: 0 });
  const [selectedRun, setSelectedRun] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(defaultForm());
  const [filterConfig, setFilterConfig] = useState('');
  const [loading, setLoading] = useState(true);

  // Version browser state
  const [browserConfig, setBrowserConfig] = useState(null);
  const [snapshots, setSnapshots] = useState([]);
  const [selectedSnapshot, setSelectedSnapshot] = useState('');
  const [browserPath, setBrowserPath] = useState('');
  const [browserEntries, setBrowserEntries] = useState([]);
  const [browserLoading, setBrowserLoading] = useState(false);
  const [restoreStatus, setRestoreStatus] = useState(null);

  const { trackRun, detectRunning, getProgressForConfig } = useJobProgress(getSsdRunDetail, () => loadAll());

  function defaultForm() {
    return {
      name: '', source_path: '', dest_path: '',
      cron_expression: '0 * * * *',
      versioning_enabled: true, enabled: true,
      notify_on_success: true, notify_on_failure: true,
    };
  }

  useEffect(() => { loadAll(); }, []);

  async function loadAll() {
    setLoading(true);
    try {
      const [c, r] = await Promise.all([getSsdConfigs(), getSsdRuns(1)]);
      setConfigs(c);
      setRuns(r);
      detectRunning(r.runs);
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  }

  async function loadRuns(page = 1) {
    const r = await getSsdRuns(page, filterConfig || undefined);
    setRuns(r);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const data = {
      ...form,
      versioning_enabled: form.versioning_enabled ? 1 : 0,
      enabled: form.enabled ? 1 : 0,
      notify_on_success: form.notify_on_success ? 1 : 0,
      notify_on_failure: form.notify_on_failure ? 1 : 0,
    };

    if (editId) {
      await updateSsdConfig(editId, data);
    } else {
      await createSsdConfig(data);
    }
    setShowForm(false);
    setEditId(null);
    setForm(defaultForm());
    loadAll();
  }

  function startEdit(config) {
    setForm({
      name: config.name,
      source_path: config.source_path,
      dest_path: config.dest_path,
      cron_expression: config.cron_expression,
      versioning_enabled: !!config.versioning_enabled,
      enabled: !!config.enabled,
      notify_on_success: !!config.notify_on_success,
      notify_on_failure: !!config.notify_on_failure,
    });
    setEditId(config.id);
    setShowForm(true);
  }

  async function handleDelete(id) {
    if (!confirm('Delete this backup configuration?')) return;
    await deleteSsdConfig(id);
    loadAll();
  }

  async function handleTrigger(id) {
    const result = await triggerSsdBackup(id);
    if (result.runId) trackRun(result.runId, id);
  }

  async function viewRun(id) {
    const detail = await getSsdRunDetail(id);
    setSelectedRun(detail);
  }

  async function openBrowser(config) {
    setBrowserConfig(config);
    setBrowserPath('');
    setBrowserEntries([]);
    setSelectedSnapshot('');
    setRestoreStatus(null);
    try {
      const snaps = await getSsdSnapshots(config.id);
      setSnapshots(snaps);
      if (snaps.length > 0) {
        setSelectedSnapshot(snaps[0].timestamp);
        await loadBrowserEntries(config.id, snaps[0].timestamp, '');
      }
    } catch (err) {
      console.error('Failed to load snapshots:', err);
      setSnapshots([]);
    }
  }

  async function loadBrowserEntries(configId, timestamp, path) {
    setBrowserLoading(true);
    try {
      const entries = await browseSsdSnapshot(configId, timestamp, path);
      setBrowserEntries(entries);
      setBrowserPath(path);
    } catch (err) {
      console.error('Failed to browse snapshot:', err);
      setBrowserEntries([]);
    }
    setBrowserLoading(false);
  }

  function navigateTo(dirName) {
    const newPath = browserPath ? `${browserPath}/${dirName}` : dirName;
    loadBrowserEntries(browserConfig.id, selectedSnapshot, newPath);
  }

  function navigateUp() {
    const parts = browserPath.split('/').filter(Boolean);
    parts.pop();
    const newPath = parts.join('/');
    loadBrowserEntries(browserConfig.id, selectedSnapshot, newPath);
  }

  async function handleSnapshotChange(timestamp) {
    setSelectedSnapshot(timestamp);
    await loadBrowserEntries(browserConfig.id, timestamp, browserPath);
  }

  async function handleRestore(filePath) {
    const fullPath = browserPath ? `${browserPath}/${filePath}` : filePath;
    if (!confirm(`Restore "${fullPath}" to source location?\nThis will overwrite the current file at the source.`)) return;
    setRestoreStatus({ path: fullPath, status: 'restoring' });
    try {
      await restoreSsdFile(browserConfig.id, selectedSnapshot, fullPath);
      setRestoreStatus({ path: fullPath, status: 'success' });
      setTimeout(() => setRestoreStatus(null), 3000);
    } catch (err) {
      setRestoreStatus({ path: fullPath, status: 'error', message: err.message });
    }
  }

  function handleDownload(filePath) {
    const fullPath = browserPath ? `${browserPath}/${filePath}` : filePath;
    const url = getSsdDownloadUrl(browserConfig.id, selectedSnapshot, fullPath);
    window.open(url, '_blank');
  }

  function formatSnapshotDate(timestamp) {
    // YYYY-MM-DDTHH-MM-SS → readable date
    const d = timestamp.replace(/T(\d{2})-(\d{2})-(\d{2})$/, 'T$1:$2:$3');
    return new Date(d).toLocaleString();
  }

  if (loading) return <div className="empty-state"><p>Loading...</p></div>;

  return (
    <div className="ssd-page">
      <div className="page-header">
        <h1><HardDrive size={24} /> SSD Backup</h1>
        <button className="btn btn-primary" onClick={() => { setShowForm(true); setEditId(null); setForm(defaultForm()); }}>
          + New Config
        </button>
      </div>

      {/* Config list */}
      {configs.length > 0 ? (
        <div className="config-list">
          {configs.map(c => (
            <div key={c.id} className="card config-card">
              <div className="config-card-header">
                <div>
                  <span className="config-name">{c.name}</span>
                  <StatusBadge status={c.enabled ? 'running' : 'exited'} label={c.enabled ? 'Active' : 'Disabled'} />
                </div>
                <div className="config-actions">
                  <button className="btn btn-primary btn-sm" onClick={() => handleTrigger(c.id)} disabled={!!getProgressForConfig(c.id)}><Play size={14} /> Run Now</button>
                  {!!c.versioning_enabled && (
                    <button className="btn btn-secondary btn-sm" onClick={() => openBrowser(c)}><Search size={14} /> Browse</button>
                  )}
                  <button className="btn btn-secondary btn-sm" onClick={() => startEdit(c)}><Pencil size={14} /> Edit</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => handleDelete(c.id)}><Trash2 size={14} /></button>
                </div>
              </div>
              <div className="config-details">
                <div className="config-detail">
                  <span className="detail-label">Source</span>
                  <code>{c.source_path}</code>
                </div>
                <div className="config-detail">
                  <span className="detail-label">Destination</span>
                  <code>{c.dest_path}</code>
                </div>
                <div className="config-detail">
                  <span className="detail-label">Schedule</span>
                  <span>{describeCron(c.cron_expression)}</span>
                </div>
                <div className="config-detail">
                  <span className="detail-label">Versioning</span>
                  <span>{c.versioning_enabled ? <><Check size={14} className="inline-icon success" /> Yes</> : <><X size={14} className="inline-icon danger" /> No</>}</span>
                </div>
              </div>
              <JobProgress progress={getProgressForConfig(c.id)} feature="ssd-backup" />
              {c.consecutive_skips > 0 && (
                <div className="skip-warning">
                  <AlertTriangle size={14} />
                  <span>Schedule too aggressive — skipped {c.consecutive_skips} time{c.consecutive_skips > 1 ? 's' : ''} in a row (previous run still active)</span>
                </div>
              )}
            </div>
          ))}
        </div>
      ) : !showForm ? (
        <div className="empty-state card">
          <HardDrive size={40} className="empty-icon" />
          <p>No backup configurations yet. Create one to get started.</p>
        </div>
      ) : null}

      {/* Create/Edit form modal */}
      {showForm && (
        <div className="modal-overlay" onClick={() => setShowForm(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{editId ? 'Edit Config' : 'New Backup Config'}</h2>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowForm(false)}>✕</button>
            </div>
            <form onSubmit={handleSubmit}>
              <div className="modal-body">
                <div className="form-group">
                  <label>Name</label>
                  <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required placeholder="e.g. Documents SSD → HDD" />
                </div>

                <div className="form-group">
                  <label>Source Path</label>
                  <PathPicker value={form.source_path} onChange={v => setForm({ ...form, source_path: v })} placeholder="/mnt/cache/Documents" />
                </div>

                <div className="form-group">
                  <label>Destination Path</label>
                  <PathPicker value={form.dest_path} onChange={v => setForm({ ...form, dest_path: v })} placeholder="/mnt/user/Backups/Documents" />
                </div>

                <div className="form-group">
                  <label>Schedule</label>
                  <SchedulePicker value={form.cron_expression} onChange={v => setForm({ ...form, cron_expression: v })} />
                </div>

                <div className="form-row">
                  <div className="form-group">
                    <div className="toggle-group">
                      <div className={`toggle ${form.versioning_enabled ? 'active' : ''}`} onClick={() => setForm({ ...form, versioning_enabled: !form.versioning_enabled })} />
                      <span>Versioning</span>
                    </div>
                  </div>
                  <div className="form-group">
                    <div className="toggle-group">
                      <div className={`toggle ${form.enabled ? 'active' : ''}`} onClick={() => setForm({ ...form, enabled: !form.enabled })} />
                      <span>Enabled</span>
                    </div>
                  </div>
                </div>

                <div className="form-row">
                  <div className="form-group">
                    <div className="toggle-group">
                      <div className={`toggle ${form.notify_on_success ? 'active' : ''}`} onClick={() => setForm({ ...form, notify_on_success: !form.notify_on_success })} />
                      <span>Notify on success</span>
                    </div>
                  </div>
                  <div className="form-group">
                    <div className="toggle-group">
                      <div className={`toggle ${form.notify_on_failure ? 'active' : ''}`} onClick={() => setForm({ ...form, notify_on_failure: !form.notify_on_failure })} />
                      <span>Notify on failure</span>
                    </div>
                  </div>
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowForm(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary">{editId ? 'Save Changes' : 'Create Config'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Run history */}
      <div className="runs-section">
        <div className="runs-header">
          <h2><ClipboardList size={18} /> Run History</h2>
          <select value={filterConfig} onChange={e => { setFilterConfig(e.target.value); }}>
            <option value="">All configs</option>
            {configs.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <button className="btn btn-secondary btn-sm" onClick={() => loadRuns(1)}>Refresh</button>
        </div>

        {runs.runs.length > 0 ? (
          <>
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Config</th>
                    <th>Started</th>
                    <th>Duration</th>
                    <th>Files</th>
                    <th>Transferred</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {runs.runs.map(r => (
                    <tr key={r.id}>
                      <td><StatusBadge status={r.status} /></td>
                      <td>{configs.find(c => c.id === r.config_id)?.name || `#${r.config_id}`}</td>
                      <td className="mono-cell">{r.started_at ? new Date(r.started_at).toLocaleString() : '—'}</td>
                      <td>{r.duration_seconds ? `${Math.round(r.duration_seconds)}s` : '—'}</td>
                      <td>{r.files_copied || 0}{r.files_failed ? ` (${r.files_failed} failed)` : ''}</td>
                      <td>{formatBytes(r.bytes_transferred || 0)}</td>
                      <td>
                        <button className="btn btn-ghost btn-sm" onClick={() => viewRun(r.id)}>View</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {runs.totalPages > 1 && (
              <div className="pagination">
                <button className="btn btn-secondary btn-sm" disabled={runs.page <= 1} onClick={() => loadRuns(runs.page - 1)}>← Prev</button>
                <span>Page {runs.page} of {runs.totalPages}</span>
                <button className="btn btn-secondary btn-sm" disabled={runs.page >= runs.totalPages} onClick={() => loadRuns(runs.page + 1)}>Next →</button>
              </div>
            )}
          </>
        ) : (
          <div className="empty-state"><p>No backup runs yet</p></div>
        )}
      </div>

      {/* Run detail modal */}
      {selectedRun && (
        <div className="modal-overlay" onClick={() => setSelectedRun(null)}>
          <div className="modal" style={{ maxWidth: '800px' }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Run Report #{selectedRun.id}</h2>
              <button className="btn btn-ghost btn-sm" onClick={() => setSelectedRun(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="run-summary">
                <div className="run-stat"><span className="run-stat-label">Status</span><StatusBadge status={selectedRun.status} /></div>
                <div className="run-stat"><span className="run-stat-label">Duration</span><span>{selectedRun.duration_seconds ? `${Math.round(selectedRun.duration_seconds)}s` : '—'}</span></div>
                <div className="run-stat"><span className="run-stat-label">Files Copied</span><span>{selectedRun.files_copied || 0}</span></div>
                <div className="run-stat"><span className="run-stat-label">Files Failed</span><span className={selectedRun.files_failed ? 'danger-text' : ''}>{selectedRun.files_failed || 0}</span></div>
                <div className="run-stat"><span className="run-stat-label">Transferred</span><span>{formatBytes(selectedRun.bytes_transferred || 0)}</span></div>
              </div>

              {selectedRun.error_message && (
                <div className="alert alert-error" style={{ marginTop: 'var(--space-md)' }}>
                  {selectedRun.error_message}
                </div>
              )}

              {selectedRun.files && selectedRun.files.length > 0 && (
                <div className="run-files">
                  <h3>File Details ({selectedRun.files.length} files)</h3>
                  <div className="table-wrapper" style={{ maxHeight: '300px', overflowY: 'auto' }}>
                    <table>
                      <thead>
                        <tr>
                          <th>Action</th>
                          <th>File</th>
                          <th>Size</th>
                          <th>Error</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedRun.files.map((f, i) => (
                          <tr key={i}>
                            <td><StatusBadge status={f.action === 'error' ? 'failed' : 'completed'} label={f.action} /></td>
                            <td className="mono-cell file-path">{f.file_path}</td>
                            <td>{formatBytes(f.size || 0)}</td>
                            <td className="danger-text">{f.error || ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Version browser modal */}
      {browserConfig && (
        <div className="modal-overlay" onClick={() => setBrowserConfig(null)}>
          <div className="modal browser-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2><Clock size={18} /> Browse Backup — {browserConfig.name}</h2>
              <button className="btn btn-ghost btn-sm" onClick={() => setBrowserConfig(null)}>✕</button>
            </div>
            <div className="modal-body">
              {/* Snapshot picker */}
              <div className="browser-controls">
                <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
                  <label>Snapshot</label>
                  <select
                    value={selectedSnapshot}
                    onChange={e => handleSnapshotChange(e.target.value)}
                  >
                    {snapshots.length === 0 && <option value="">No snapshots available</option>}
                    {snapshots.map(s => (
                      <option key={s.timestamp} value={s.timestamp}>
                        {formatSnapshotDate(s.timestamp)} — {s.fileCount} file{s.fileCount !== 1 ? 's' : ''} changed
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Breadcrumb path */}
              <div className="browser-breadcrumb">
                <button
                  className="btn btn-ghost btn-sm"
                  disabled={!browserPath}
                  onClick={navigateUp}
                >
                  <ArrowUp size={14} />
                </button>
                <span className="breadcrumb-path">
                  <button className="breadcrumb-segment" onClick={() => loadBrowserEntries(browserConfig.id, selectedSnapshot, '')}>
                    /
                  </button>
                  {browserPath.split('/').filter(Boolean).map((seg, i, arr) => {
                    const segPath = arr.slice(0, i + 1).join('/');
                    return (
                      <span key={segPath}>
                        <ChevronRight size={12} className="breadcrumb-sep" />
                        <button className="breadcrumb-segment" onClick={() => loadBrowserEntries(browserConfig.id, selectedSnapshot, segPath)}>
                          {seg}
                        </button>
                      </span>
                    );
                  })}
                </span>
              </div>

              {/* Restore status */}
              {restoreStatus && (
                <div className={`alert ${restoreStatus.status === 'success' ? 'alert-success' : restoreStatus.status === 'error' ? 'alert-error' : 'alert-info'}`}>
                  {restoreStatus.status === 'restoring' && `Restoring ${restoreStatus.path}...`}
                  {restoreStatus.status === 'success' && `Restored ${restoreStatus.path} successfully`}
                  {restoreStatus.status === 'error' && `Failed to restore: ${restoreStatus.message}`}
                </div>
              )}

              {/* File listing */}
              {browserLoading ? (
                <div className="empty-state"><p>Loading...</p></div>
              ) : browserEntries.length === 0 ? (
                <div className="empty-state"><p>{snapshots.length === 0 ? 'No versioned snapshots found for this config' : 'Empty directory'}</p></div>
              ) : (
                <div className="browser-list">
                  {browserEntries.map(entry => (
                    <div key={entry.name} className={`browser-entry ${entry.source === 'version' ? 'from-version' : ''}`}>
                      <div className="entry-info" onClick={entry.isDirectory ? () => navigateTo(entry.name) : undefined} style={entry.isDirectory ? { cursor: 'pointer' } : undefined}>
                        {entry.isDirectory ? <FolderClosed size={16} className="entry-icon folder" /> : <FileText size={16} className="entry-icon file" />}
                        <span className="entry-name">{entry.name}</span>
                        {!entry.isDirectory && <span className="entry-size">{formatBytes(entry.size)}</span>}
                        {entry.source === 'version' && <span className="entry-badge">versioned</span>}
                      </div>
                      {!entry.isDirectory && (
                        <div className="entry-actions">
                          <button className="btn btn-ghost btn-sm" title="Download" onClick={() => handleDownload(entry.name)}>
                            <Download size={14} />
                          </button>
                          <button className="btn btn-ghost btn-sm" title="Restore to source" onClick={() => handleRestore(entry.name)}>
                            <RotateCcw size={14} />
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

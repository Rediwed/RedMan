import { useState, useEffect, useCallback } from 'react';
import {
  getSsdConfigs, createSsdConfig, updateSsdConfig, deleteSsdConfig,
  triggerSsdBackup, cancelSsdBackup, getSsdRuns, getSsdRunDetail, getSsdRunProgress,
  getSsdSnapshots, browseSsdSnapshot, getSsdDownloadUrl, getSsdPreviewUrl, restoreSsdFile,
} from '../api/index.js';
import {
  HardDrive, Play, Pencil, Trash2, ClipboardList, Check, X, AlertTriangle,
  FolderOpen, FileText, Download, RotateCcw, ChevronRight, ArrowUp, Clock, FolderClosed, Search, Eye,
  ShieldCheck, ShieldAlert, ShieldOff,
} from 'lucide-react';
import StatusBadge from '../components/StatusBadge.jsx';
import PathPicker from '../components/PathPicker.jsx';
import JobProgress from '../components/JobProgress.jsx';
import SchedulePicker, { describeCron } from '../components/SchedulePicker.jsx';
import InfoTip from '../components/InfoTip.jsx';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import BackupHealth from '../components/BackupHealth.jsx';
import NotificationPolicyField from '../components/NotificationPolicyField.jsx';
import { DialogSurface } from '../components/Dialog.jsx';
import useJobProgress from '../hooks/useJobProgress.js';
import useReconnect from '../hooks/useReconnect.js';
import { useSettings } from '../contexts/SettingsContext.jsx';
import { formatDateTime } from '../utils/dateFormat.js';
import { formatBytes } from '../utils/formatBytes.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import './SsdBackupPage.css';

// Outcome of the SQLite integrity check on the database copy written to the
// destination during post-processing. Runs from before this was recorded, and
// runs that never reached that stage, have no value at all.
const DB_BACKUP_VERIFICATION = {
  verified: {
    Icon: ShieldCheck,
    label: 'Verified',
    title: 'Database copy written to this destination and its SQLite integrity check passed',
  },
  skipped: {
    Icon: ShieldOff,
    label: 'Not due',
    title: 'No database copy this run — the existing copy at this destination is still recent',
  },
  failed: {
    Icon: ShieldAlert,
    label: 'Failed',
    title: 'The database copy could not be integrity-verified — open the run report for details',
  },
};

function IntegrityBadge({ status }) {
  const descriptor = DB_BACKUP_VERIFICATION[status];
  if (!descriptor) {
    return <span className="integrity-badge integrity-unknown" title="No database backup stage ran for this backup">—</span>;
  }
  const { Icon, label, title } = descriptor;
  return (
    <span className={`integrity-badge integrity-${status}`} title={title} aria-label={`Database integrity: ${label}`}>
      <Icon size={14} aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

export default function SsdBackupPage() {
  const auth = useAuth();
  const { settings } = useSettings();
  const [configs, setConfigs] = useState([]);
  const [runs, setRuns] = useState({ runs: [], page: 1, totalPages: 0 });
  const [selectedRun, setSelectedRun] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(defaultForm());
  const [filterConfig, setFilterConfig] = useState('');
  const [loading, setLoading] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [formError, setFormError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [restoreTarget, setRestoreTarget] = useState(null);
  const [confirmError, setConfirmError] = useState(null);
  const [confirming, setConfirming] = useState(false);

  // Version browser state
  const [browserConfig, setBrowserConfig] = useState(null);
  const [snapshots, setSnapshots] = useState([]);
  const [preview, setPreview] = useState(null); // { name, url, type }
  const [selectedSnapshot, setSelectedSnapshot] = useState('');
  const [browserPath, setBrowserPath] = useState('');
  const [browserEntries, setBrowserEntries] = useState([]);
  const [browserLoading, setBrowserLoading] = useState(false);
  const [restoreStatus, setRestoreStatus] = useState(null);

  const { trackRun, detectRunning, getProgressForConfig, getRunIdForConfig } = useJobProgress(getSsdRunProgress, () => loadAll());

  function defaultForm() {
    return {
      name: '', source_path: '', dest_path: '',
      cron_expression: '0 * * * *',
      versioning_enabled: true, enabled: true,
      delta_versioning: false, delta_threshold: 50,
      delta_max_chain: 10, delta_keyframe_days: 7,
      retention_policy: { hourly: 24, daily: 7, weekly: 30, monthly: 90, quarterly: 365 },
      exclude_patterns: '',
      notify_mode: 'global', notify_on_start: true, notify_on_success: true, notify_on_failure: true,
    };
  }

  useEffect(() => { loadAll(); }, []);
  useReconnect(useCallback(() => loadAll(), []));

  async function loadAll() {
    setLoading(true);
    setLoadError(null);
    try {
      const [c, r] = await Promise.all([getSsdConfigs(), getSsdRuns(1)]);
      setConfigs(c);
      setRuns(r);
      detectRunning(r.runs);
    } catch (err) {
      setLoadError(err.message);
    }
    setLoading(false);
  }

  async function loadRuns(page = 1, configId = filterConfig) {
    try {
      setLoadError(null);
      const r = await getSsdRuns(page, configId || undefined);
      setRuns(r);
    } catch (err) {
      setLoadError(err.message);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setFormError(null);
    setSubmitting(true);
    const data = {
      ...form,
      versioning_enabled: form.versioning_enabled ? 1 : 0,
      enabled: form.enabled ? 1 : 0,
      delta_versioning: form.delta_versioning ? 1 : 0,
      notify_mode: form.notify_mode,
      notify_on_start: form.notify_on_start ? 1 : 0,
      notify_on_success: form.notify_on_success ? 1 : 0,
      notify_on_failure: form.notify_on_failure ? 1 : 0,
    };

    try {
      if (editId) {
        await updateSsdConfig(editId, data);
      } else {
        await createSsdConfig(data);
      }
      setShowForm(false);
      setEditId(null);
      setForm(defaultForm());
      loadAll();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  function startEdit(config) {
    let retentionPolicy = { hourly: 24, daily: 7, weekly: 30, monthly: 90, quarterly: 365 };
    if (config.retention_policy) {
      try { retentionPolicy = JSON.parse(config.retention_policy); } catch {}
    }
    setForm({
      name: config.name,
      source_path: config.source_path,
      dest_path: config.dest_path,
      cron_expression: config.cron_expression,
      versioning_enabled: !!config.versioning_enabled,
      enabled: !!config.enabled,
      delta_versioning: !!config.delta_versioning,
      delta_threshold: config.delta_threshold || 50,
      delta_max_chain: config.delta_max_chain || 10,
      delta_keyframe_days: config.delta_keyframe_days || 7,
      retention_policy: retentionPolicy,
      exclude_patterns: config.exclude_patterns || '',
      notify_mode: config.notify_mode || 'global',
      notify_on_start: config.notify_on_start !== undefined ? !!config.notify_on_start : true,
      notify_on_success: !!config.notify_on_success,
      notify_on_failure: !!config.notify_on_failure,
    });
    setEditId(config.id);
    setFormError(null);
    setShowForm(true);
    setNameManual(true);
  }

  async function handleDelete(id) {
    setConfirmError(null);
    setDeleteTarget(configs.find(config => config.id === id) || { id, name: `Config ${id}` });
  }

  async function confirmDelete() {
    setConfirming(true);
    setConfirmError(null);
    try {
      await deleteSsdConfig(deleteTarget.id);
      setDeleteTarget(null);
      loadAll();
    } catch (err) {
      setConfirmError(err.message);
    } finally {
      setConfirming(false);
    }
  }

  async function handleTrigger(id) {
    const result = await triggerSsdBackup(id);
    if (result.runId) trackRun(result.runId, id);
  }

  const [fileFilter, setFileFilter] = useState('');
  const [filePage, setFilePage] = useState(1);

  const [nameManual, setNameManual] = useState(false);

  function suggestName(src, dst) {
    const seg = p => p?.replace(/\/+$/, '').split('/').pop() || '';
    const s = seg(src), d = seg(dst);
    return s && d ? `${s} → ${d}` : s || d || '';
  }

  async function viewRun(id, action = '', page = 1) {
    const detail = await getSsdRunDetail(id, { action: action || undefined, filePage: page });
    setSelectedRun(detail);
    setFileFilter(action);
    setFilePage(page);
  }

  async function openBrowser(config, preferredTimestamp = null) {
    setBrowserConfig(config);
    setBrowserPath('');
    setBrowserEntries([]);
    setSelectedSnapshot('');
    setRestoreStatus(null);
    try {
      const snaps = await getSsdSnapshots(config.id);
      setSnapshots(snaps);
      if (snaps.length > 0) {
        const timestamp = snaps.some(snapshot => snapshot.timestamp === preferredTimestamp)
          ? preferredTimestamp
          : snaps[0].timestamp;
        setSelectedSnapshot(timestamp);
        await loadBrowserEntries(config.id, timestamp, '');
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
    setConfirmError(null);
    setRestoreTarget({ path: fullPath, timestamp: selectedSnapshot, verify: true });
  }

  async function confirmRestore() {
    const { path, timestamp, verify } = restoreTarget;
    setConfirming(true);
    setConfirmError(null);
    setRestoreStatus({ path, status: 'restoring' });
    try {
      const result = await restoreSsdFile(browserConfig.id, timestamp, path, verify);
      setRestoreStatus({ path, status: 'success', verified: result.verified, restoreEventId: result.restoreEventId });
      setRestoreTarget(null);
    } catch (err) {
      setRestoreStatus({ path, status: 'error', message: err.message });
      setConfirmError(err.message);
    } finally {
      setConfirming(false);
    }
  }

  function handleDownload(filePath) {
    const fullPath = browserPath ? `${browserPath}/${filePath}` : filePath;
    const url = getSsdDownloadUrl(browserConfig.id, selectedSnapshot, fullPath);
    window.open(url, '_blank');
  }

  async function handlePreview(fileName) {
    const fullPath = browserPath ? `${browserPath}/${fileName}` : fileName;
    const type = getPreviewType(fileName);
    const url = getSsdPreviewUrl(browserConfig.id, selectedSnapshot, fullPath);

    if (type === 'text') {
      setPreview({ name: fileName, type, content: undefined, url });
      try {
        const res = await fetch(url);
        const content = await res.text();
        setPreview({ name: fileName, type, content, url });
      } catch (err) {
        setPreview({ name: fileName, type, content: `Error loading file: ${err.message}`, url });
      }
    } else {
      setPreview({ name: fileName, type, url });
    }
  }

  function formatSnapshotDate(timestamp) {
    // YYYY-MM-DDTHH-MM-SS → readable date
    const d = timestamp.replace(/T(\d{2})-(\d{2})-(\d{2})$/, 'T$1:$2:$3');
    return formatDateTime(d, settings);
  }

  if (loading) return <div className="empty-state"><p>Loading...</p></div>;

  return (
    <div className="ssd-page">
      <div className="page-header">
        <h1><HardDrive size={24} /> SSD Backup</h1>
        {auth.isAdmin && <button className="btn btn-primary" onClick={() => { setShowForm(true); setEditId(null); setForm(defaultForm()); setNameManual(false); setShowAdvanced(false); setFormError(null); }}>
          + New Config
        </button>}
      </div>

      {loadError && (
        <div className="alert alert-error" role="alert">
          <span>{loadError}</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={loadAll}>Retry</button>
        </div>
      )}

      {/* Config list */}
      {configs.length > 0 ? (
        <div className="config-list">
          {configs.map(c => (
            <div key={c.id} className="card config-card">
              <div className="config-card-header">
                <div>
                  <span className="config-name">{c.name}</span>
                  <StatusBadge status={getProgressForConfig(c.id) ? 'active' : c.enabled ? 'enabled' : 'disabled'} />
                </div>
                <div className="config-actions">
                  {auth.isAdmin && <button className="btn btn-primary btn-sm" onClick={() => handleTrigger(c.id)} disabled={!!getProgressForConfig(c.id)}><Play size={14} /> Run Now</button>}
                  {!!c.versioning_enabled && (
                    <button className="btn btn-secondary btn-sm" onClick={() => openBrowser(c)}><Search size={14} /> Browse</button>
                  )}
                  {auth.isAdmin && <button className="btn btn-secondary btn-sm" onClick={() => startEdit(c)}><Pencil size={14} /> Edit</button>}
                  {auth.isAdmin && <button className="btn btn-ghost btn-sm" onClick={() => handleDelete(c.id)} title="Delete configuration" aria-label={`Delete ${c.name}`}><Trash2 size={14} aria-hidden="true" /></button>}
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
              <BackupHealth
                health={c.health}
                settings={settings}
                restoreSupported
                onOpenRun={viewRun}
                onOpenRestore={() => openBrowser(c, c.health?.lastVerifiedRestore?.snapshot_timestamp)}
              />
              <JobProgress progress={getProgressForConfig(c.id)} feature="ssd-backup" onCancel={auth.isAdmin ? () => { const rid = getRunIdForConfig(c.id); if (rid) cancelSsdBackup(rid).then(() => loadAll()); } : null} />
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
        <DialogSurface ariaLabel={editId ? 'Edit backup configuration' : 'New backup configuration'} onClose={() => setShowForm(false)}>
            <div className="modal-header">
              <h2>{editId ? 'Edit Config' : 'New Backup Config'}</h2>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowForm(false)} title="Close" aria-label="Close backup form">✕</button>
            </div>
            <form onSubmit={handleSubmit} aria-describedby={formError ? 'ssd-form-error' : undefined}>
              <div className="modal-body">
                {formError && <div id="ssd-form-error" className="alert alert-error" role="alert">{formError}</div>}
                <div className="form-group">
                  <label>Name</label>
                  <input value={form.name} onChange={e => { setForm({ ...form, name: e.target.value }); setNameManual(true); }} required placeholder="e.g. Documents → ssd-backup" />
                </div>

                <div className="form-group">
                  <label>Source Path</label>
                  <PathPicker value={form.source_path} onChange={v => {
                    const update = { ...form, source_path: v };
                    if (!editId && !nameManual) update.name = suggestName(v, form.dest_path);
                    setForm(update);
                  }} placeholder="/mnt/cache/Documents" />
                </div>

                <div className="form-group">
                  <label>Destination Path</label>
                  <PathPicker value={form.dest_path} onChange={v => {
                    const update = { ...form, dest_path: v };
                    if (!editId && !nameManual) update.name = suggestName(form.source_path, v);
                    setForm(update);
                  }} placeholder="/mnt/user/Backups/Documents" />
                </div>

                <div className="form-group">
                  <label>Schedule</label>
                  <SchedulePicker value={form.cron_expression} onChange={v => setForm({ ...form, cron_expression: v })} />
                </div>

                <div className="form-group">
                  <label>Excluded paths and patterns<InfoTip text="One rsync exclude pattern per line. Excluded paths are neither copied nor deleted from the destination." /></label>
                  <textarea
                    rows="4"
                    value={form.exclude_patterns}
                    onChange={event => setForm({ ...form, exclude_patterns: event.target.value })}
                    placeholder={'cache/\n*.tmp\n.DS_Store'}
                  />
                  <span className="form-hint">Preview ({parseExcludePreview(form.exclude_patterns).length}/100)</span>
                  {parseExcludePreview(form.exclude_patterns).length > 0 && (
                    <div className="exclude-preview" aria-label="Active exclude patterns">
                      {parseExcludePreview(form.exclude_patterns).map(pattern => <code key={pattern}>{pattern}</code>)}
                    </div>
                  )}
                </div>

                <div className="form-row">
                  <div className="form-group">
                    <div className="toggle-group">
                      <div className={`toggle ${form.versioning_enabled ? 'active' : ''}`} onClick={() => setForm({ ...form, versioning_enabled: !form.versioning_enabled })} />
                      <span>Versioning</span>
                    </div>
                  </div>
                  {form.versioning_enabled && (
                    <div className="form-group">
                      <div className="toggle-group">
                        <div className={`toggle ${form.delta_versioning ? 'active' : ''}`} onClick={() => setForm({ ...form, delta_versioning: !form.delta_versioning })} />
                        <span>Delta Versioning<InfoTip text="Store only binary differences between versions (saves disk space)" /></span>
                      </div>
                    </div>
                  )}
                </div>

                {/* Version retention applies to plain and delta snapshots. */}
                {form.versioning_enabled && (
                  <>
                    <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 'var(--space-sm)' }}
                      onClick={() => setShowAdvanced(v => !v)}>
                      <ChevronRight size={14} style={{ transform: showAdvanced ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }} />
                      Advanced settings
                    </button>
                    {showAdvanced && (
                      <>
                        {form.delta_versioning && <div className="form-subsection">
                          <div className="form-row">
                            <div className="form-group">
                              <label>Min Savings Threshold ({form.delta_threshold}%)</label>
                              <input type="range" min="10" max="90" value={form.delta_threshold}
                                onChange={e => setForm({ ...form, delta_threshold: parseInt(e.target.value) })} />
                              <small className="form-hint">Only store delta if it saves at least this much</small>
                            </div>
                          </div>
                          <div className="form-row">
                            <div className="form-group">
                              <label>Max Chain Length</label>
                              <input type="number" min="1" max="50" value={form.delta_max_chain}
                                onChange={e => setForm({ ...form, delta_max_chain: parseInt(e.target.value) || 10 })} />
                            </div>
                            <div className="form-group">
                              <label>Keyframe Interval (days)</label>
                              <input type="number" min="1" max="30" value={form.delta_keyframe_days}
                                onChange={e => setForm({ ...form, delta_keyframe_days: parseInt(e.target.value) || 7 })} />
                            </div>
                          </div>
                        </div>}

                        <div className="form-subsection">
                          <label className="subsection-label">Retention Policy</label>
                          <small className="form-hint">How long to keep version snapshots at each granularity (0 = disabled)</small>
                          <div className="retention-grid">
                            <div className="form-group">
                              <label>Hourly (hours)</label>
                              <input type="number" min="0" max="168" value={form.retention_policy.hourly}
                                onChange={e => setForm({ ...form, retention_policy: { ...form.retention_policy, hourly: parseInt(e.target.value) || 0 } })} />
                            </div>
                            <div className="form-group">
                              <label>Daily (days)</label>
                              <input type="number" min="0" max="365" value={form.retention_policy.daily}
                                onChange={e => setForm({ ...form, retention_policy: { ...form.retention_policy, daily: parseInt(e.target.value) || 0 } })} />
                            </div>
                            <div className="form-group">
                              <label>Weekly (days)</label>
                              <input type="number" min="0" max="365" value={form.retention_policy.weekly}
                                onChange={e => setForm({ ...form, retention_policy: { ...form.retention_policy, weekly: parseInt(e.target.value) || 0 } })} />
                            </div>
                            <div className="form-group">
                              <label>Monthly (days)</label>
                              <input type="number" min="0" max="730" value={form.retention_policy.monthly}
                                onChange={e => setForm({ ...form, retention_policy: { ...form.retention_policy, monthly: parseInt(e.target.value) || 0 } })} />
                            </div>
                            <div className="form-group">
                              <label>Quarterly (days)</label>
                              <input type="number" min="0" max="1825" value={form.retention_policy.quarterly}
                                onChange={e => setForm({ ...form, retention_policy: { ...form.retention_policy, quarterly: parseInt(e.target.value) || 0 } })} />
                            </div>
                          </div>
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setForm({ ...form, retention_policy: { hourly: 24, daily: 7, weekly: 30, monthly: 90, quarterly: 365 } })}>
                            Reset to defaults
                          </button>
                        </div>
                      </>
                    )}
                  </>
                )}

                <NotificationPolicyField form={form} onChange={patch => setForm(current => ({ ...current, ...patch }))} />
              </div>
              <div className="modal-footer">
                <div className="toggle-group">
                  <div className={`toggle ${form.enabled ? 'active' : ''}`} onClick={() => setForm({ ...form, enabled: !form.enabled })} />
                  <span>Enabled</span>
                </div>
                <div className="modal-footer-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => setShowForm(false)}>Cancel</button>
                  <button type="submit" className="btn btn-primary" disabled={submitting}>{submitting ? 'Saving...' : editId ? 'Save Changes' : 'Create Config'}</button>
                </div>
              </div>
            </form>
        </DialogSurface>
      )}

      {/* Run history */}
      {deleteTarget && (
        <ConfirmDialog title="Delete backup configuration" confirmLabel="Delete configuration" destructive busy={confirming} error={confirmError} onClose={() => setDeleteTarget(null)} onConfirm={confirmDelete}>
          <p>Delete <strong>{deleteTarget.name}</strong> from RedMan?</p>
          <p className="form-hint">The schedule is removed. Existing destination files and snapshots are not deleted.</p>
        </ConfirmDialog>
      )}

      {restoreTarget && (
        <ConfirmDialog title="Restore file" confirmLabel="Restore and overwrite" destructive busy={confirming} error={confirmError} onClose={() => setRestoreTarget(null)} onConfirm={confirmRestore}>
          <dl className="restore-confirm-details">
            <dt>Selected revision</dt><dd>{restoreTarget.timestamp}</dd>
            <dt>Snapshot file</dt><dd><code>{browserConfig?.dest_path}/{restoreTarget.path}</code></dd>
            <dt>Restore destination</dt><dd><code>{browserConfig?.source_path}/{restoreTarget.path}</code></dd>
            <dt>Overwrite</dt><dd>Yes, the current destination file will be replaced</dd>
          </dl>
          <label className="toggle-label-sm">
            <input type="checkbox" checked={restoreTarget.verify} onChange={event => setRestoreTarget({ ...restoreTarget, verify: event.target.checked })} />
            Verify restored bytes with SHA-256
          </label>
        </ConfirmDialog>
      )}

      {/* Run history */}
      <div className="runs-section">
        <div className="runs-header">
          <h2><ClipboardList size={18} /> Run History</h2>
          <select value={filterConfig} onChange={e => { const configId = e.target.value; setFilterConfig(configId); loadRuns(1, configId); }}>
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
                    <th>DB Integrity</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {runs.runs.map(r => (
                    <tr key={r.id}>
                      <td><StatusBadge status={r.status} /></td>
                      <td>{configs.find(c => c.id === r.config_id)?.name || `#${r.config_id}`}</td>
                      <td className="mono-cell">{r.started_at ? formatDateTime(r.started_at, settings) : '—'}</td>
                      <td>{r.duration_seconds ? `${Math.round(r.duration_seconds)}s` : '—'}</td>
                      <td>{r.files_copied || 0}{r.files_failed ? ` (${r.files_failed} failed)` : ''}</td>
                      <td>{formatBytes(r.bytes_transferred || 0)}</td>
                      <td><IntegrityBadge status={r.db_backup_status} /></td>
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
        <DialogSurface ariaLabel={`Run report ${selectedRun.id}`} style={{ maxWidth: '800px' }} onClose={() => setSelectedRun(null)}>
            <div className="modal-header">
              <h2>Run Report #{selectedRun.id}</h2>
              <button className="btn btn-ghost btn-sm" onClick={() => setSelectedRun(null)} title="Close" aria-label="Close run details">✕</button>
            </div>
            <div className="modal-body">
              <div className="run-summary">
                <div className="run-stat"><span className="run-stat-label">Status</span><StatusBadge status={selectedRun.status} /></div>
                <div className="run-stat"><span className="run-stat-label">Duration</span><span>{selectedRun.duration_seconds ? `${Math.round(selectedRun.duration_seconds)}s` : '—'}</span></div>
                <div className="run-stat"><span className="run-stat-label">Files Copied</span><span>{selectedRun.files_copied || 0}</span></div>
                <div className="run-stat"><span className="run-stat-label">Files Failed</span><span className={selectedRun.files_failed ? 'danger-text' : ''}>{selectedRun.files_failed || 0}</span></div>
                <div className="run-stat"><span className="run-stat-label">Transferred</span><span>{formatBytes(selectedRun.bytes_transferred || 0)}</span></div>
                <div className="run-stat"><span className="run-stat-label">DB Integrity</span><IntegrityBadge status={selectedRun.db_backup_status} /></div>
              </div>

              {selectedRun.status === 'failed' && (
                <div className="alert alert-error" style={{ marginTop: 'var(--space-md)', whiteSpace: 'pre-wrap' }}>
                  {selectedRun.error_message || 'Backup failed — no error details were recorded for this run.'}
                </div>
              )}

              {selectedRun.status === 'partial' && selectedRun.error_message && (
                <div className="alert alert-warning" style={{ marginTop: 'var(--space-md)', whiteSpace: 'pre-wrap' }}>
                  {selectedRun.error_message}
                </div>
              )}

              {selectedRun.files && selectedRun.files.length > 0 && (
                <div className="run-files">
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 'var(--space-sm)', marginBottom: 'var(--space-sm)' }}>
                    <h3 style={{ margin: 0 }}>File Details ({selectedRun.totalFiles} files{fileFilter ? ` — ${fileFilter}` : ''})</h3>
                    {selectedRun.actionCounts && (
                      <div style={{ display: 'flex', gap: 'var(--space-xs)', flexWrap: 'wrap' }}>
                        <button className={`btn btn-sm ${!fileFilter ? 'btn-primary' : 'btn-ghost'}`} onClick={() => viewRun(selectedRun.id, '', 1)}>
                          All
                        </button>
                        {selectedRun.actionCounts.map(({ action, count }) => (
                          <button key={action} className={`btn btn-sm ${fileFilter === action ? 'btn-primary' : 'btn-ghost'}`} onClick={() => viewRun(selectedRun.id, action, 1)}>
                            {action} ({count})
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
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
                  {selectedRun.filePages > 1 && (
                    <div style={{ display: 'flex', justifyContent: 'center', gap: 'var(--space-sm)', marginTop: 'var(--space-sm)', alignItems: 'center' }}>
                      <button className="btn btn-sm btn-ghost" disabled={filePage <= 1} onClick={() => viewRun(selectedRun.id, fileFilter, filePage - 1)}>← Prev</button>
                      <span className="muted">Page {filePage} of {selectedRun.filePages}</span>
                      <button className="btn btn-sm btn-ghost" disabled={filePage >= selectedRun.filePages} onClick={() => viewRun(selectedRun.id, fileFilter, filePage + 1)}>Next →</button>
                    </div>
                  )}
                </div>
              )}
            </div>
        </DialogSurface>
      )}

      {/* Version browser modal */}
      {browserConfig && (
        <DialogSurface ariaLabel={`Browse backup ${browserConfig.name}`} className="browser-modal" onClose={() => setBrowserConfig(null)}>
            <div className="modal-header">
              <h2><Clock size={18} /> Browse Backup — {browserConfig.name}</h2>
              <button className="btn btn-ghost btn-sm" onClick={() => setBrowserConfig(null)} title="Close" aria-label="Close version browser">✕</button>
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
                        {formatSnapshotDate(s.timestamp)}{s.tier ? ` · ${s.tier}` : ''}
                      </option>
                    ))}
                  </select>
                  {(() => {
                    const snapshot = snapshots.find(item => item.timestamp === selectedSnapshot);
                    if (!snapshot) return null;
                    return (
                      <span className="form-hint snapshot-summary">
                        {snapshot.summaryIncomplete
                          ? 'Summary unavailable for this legacy snapshot'
                          : <>
                              {snapshot.fileCount} file{snapshot.fileCount !== 1 ? 's' : ''} changed
                              {snapshot.diskSize != null ? ` · ${formatBytes(snapshot.diskSize)}` : ''}
                              {snapshot.originalSize > snapshot.diskSize ? ` · ${Math.round((1 - snapshot.diskSize / snapshot.originalSize) * 100)}% saved` : ''}
                            </>}
                      </span>
                    );
                  })()}
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
                  {restoreStatus.status === 'success' && `Restored ${restoreStatus.path} successfully${restoreStatus.verified ? ' and verified byte-for-byte' : ' without byte verification'}`}
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
                        {entry.isDelta && <span className="entry-badge delta-badge">delta</span>}
                      </div>
                      {!entry.isDirectory && (
                        <div className="entry-actions">
                          {isPreviewable(entry.name) && (
                            <button className="btn btn-ghost btn-sm" title="Preview" aria-label={`Preview ${entry.name}`} onClick={() => handlePreview(entry.name)}>
                              <Eye size={14} />
                            </button>
                          )}
                          <button className="btn btn-ghost btn-sm" title="Download" aria-label={`Download ${entry.name}`} onClick={() => handleDownload(entry.name)}>
                            <Download size={14} />
                          </button>
                          {auth.isAdmin && <button className="btn btn-ghost btn-sm" title="Restore to source" aria-label={`Restore ${entry.name} to source`} onClick={() => handleRestore(entry.name)}>
                            <RotateCcw size={14} />
                          </button>}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
        </DialogSurface>
      )}
      {/* File preview modal */}
      {preview && (
        <DialogSurface ariaLabel={`Preview ${preview.name}`} className="browser-modal" onClose={() => setPreview(null)}>
            <div className="modal-header">
              <h2><Eye size={18} /> {preview.name}</h2>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button className="btn btn-secondary btn-sm" onClick={() => handleDownload(preview.name)}>Download</button>
                <button className="btn btn-ghost btn-sm" onClick={() => setPreview(null)} title="Close" aria-label="Close file preview">✕</button>
              </div>
            </div>
            <div className="modal-body" style={{ maxHeight: '70vh', overflow: 'auto' }}>
              {preview.type === 'text' && preview.content !== undefined && (
                <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, fontSize: '0.85rem', lineHeight: 1.5 }}>{preview.content}</pre>
              )}
              {preview.type === 'text' && preview.content === undefined && (
                <div className="empty-state"><p>Loading...</p></div>
              )}
              {preview.type === 'image' && (
                <img src={preview.url} alt={preview.name} style={{ maxWidth: '100%', maxHeight: '65vh', objectFit: 'contain' }} />
              )}
              {preview.type === 'pdf' && (
                <iframe src={preview.url} style={{ width: '100%', height: '65vh', border: 'none' }} title={preview.name} />
              )}
              {preview.type === 'video' && (
                <div style={{ display: 'flex', justifyContent: 'center' }}>
                  <video src={preview.url} controls style={{ width: '100%', maxHeight: '70vh' }} />
                </div>
              )}
              {preview.type === 'unsupported' && (
                <div className="empty-state">
                  <p>Preview not available for this file type.</p>
                  <button className="btn btn-primary btn-sm" onClick={() => handleDownload(preview.name)}>Download instead</button>
                </div>
              )}
            </div>
        </DialogSurface>
      )}
    </div>
  );
}

const TEXT_EXTS = new Set(['txt','md','json','csv','xml','html','htm','js','mjs','py','sh','yml','yaml','toml','env','cfg','ini','log','css','sql']);
const IMAGE_EXTS = new Set(['jpg','jpeg','png','gif','webp','svg','bmp','ico']);
const VIDEO_EXTS = new Set(['mp4','webm','mov']);

function getPreviewType(name) {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  if (TEXT_EXTS.has(ext)) return 'text';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (VIDEO_EXTS.has(ext)) return 'video';
  return 'unsupported';
}

function isPreviewable(name) {
  return getPreviewType(name) !== 'unsupported';
}

function parseExcludePreview(value) {
  return [...new Set(String(value || '').split(/[\r\n,]+/).map(pattern => pattern.trim()).filter(Boolean))];
}

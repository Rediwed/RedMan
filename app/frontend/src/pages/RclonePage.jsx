import { useState, useEffect } from 'react';
import {
  getRcloneRemotes, getRcloneJobs, createRcloneJob, updateRcloneJob,
  deleteRcloneJob, triggerRcloneSync, getRcloneRuns, getRcloneRunDetail,
  getRcloneProviders, getRcloneRemoteConfig, createRcloneRemote,
  updateRcloneRemote, deleteRcloneRemote, testRcloneRemote,
} from '../api/index.js';
import { Cloud, Play, Pencil, Trash2, ClipboardList, AlertTriangle, Plus, Plug, CheckCircle2, XCircle, Settings, Eye, EyeOff } from 'lucide-react';
import StatusBadge from '../components/StatusBadge.jsx';
import PathPicker from '../components/PathPicker.jsx';
import JobProgress from '../components/JobProgress.jsx';
import SchedulePicker, { describeCron } from '../components/SchedulePicker.jsx';
import useJobProgress from '../hooks/useJobProgress.js';
import './RclonePage.css';

export default function RclonePage() {
  const [remotes, setRemotes] = useState([]);
  const [providers, setProviders] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [runs, setRuns] = useState({ runs: [], page: 1, totalPages: 0 });
  const [selectedRun, setSelectedRun] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(defaultForm());
  const [loading, setLoading] = useState(true);

  // Remote management state
  const [showRemoteForm, setShowRemoteForm] = useState(false);
  const [editRemote, setEditRemote] = useState(null);
  const [remoteForm, setRemoteForm] = useState({ name: '', type: '', params: {} });
  const [remoteTestResult, setRemoteTestResult] = useState(null);
  const [remoteTesting, setRemoteTesting] = useState(null);
  const [showSensitive, setShowSensitive] = useState({});

  const { trackRun, detectRunning, getProgressForConfig } = useJobProgress(getRcloneRunDetail, () => loadAll());

  function defaultForm() {
    return {
      name: '', local_path: '', remote_name: '', remote_path: '',
      sync_direction: 'upload', cron_expression: '0 3 * * *',
      enabled: true, notify_on_success: true, notify_on_failure: true,
    };
  }

  useEffect(() => { loadAll(); }, []);

  async function loadAll() {
    setLoading(true);
    try {
      const [rem, prov, j, r] = await Promise.all([
        getRcloneRemotes().catch(() => []),
        getRcloneProviders().catch(() => []),
        getRcloneJobs(),
        getRcloneRuns(1),
      ]);
      setRemotes(rem);
      setProviders(prov);
      setJobs(j);
      setRuns(r);
      detectRunning(r.runs);
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  }

  async function loadRuns(page = 1) {
    const r = await getRcloneRuns(page);
    setRuns(r);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const data = {
      ...form,
      enabled: form.enabled ? 1 : 0,
      notify_on_success: form.notify_on_success ? 1 : 0,
      notify_on_failure: form.notify_on_failure ? 1 : 0,
    };

    if (editId) {
      await updateRcloneJob(editId, data);
    } else {
      await createRcloneJob(data);
    }
    setShowForm(false);
    setEditId(null);
    setForm(defaultForm());
    loadAll();
  }

  function startEdit(job) {
    setForm({
      name: job.name, local_path: job.local_path,
      remote_name: job.remote_name, remote_path: job.remote_path,
      sync_direction: job.sync_direction, cron_expression: job.cron_expression,
      enabled: !!job.enabled,
      notify_on_success: !!job.notify_on_success,
      notify_on_failure: !!job.notify_on_failure,
    });
    setEditId(job.id);
    setShowForm(true);
  }

  async function handleDelete(id) {
    if (!confirm('Delete this Rclone sync job?')) return;
    await deleteRcloneJob(id);
    loadAll();
  }

  async function handleTrigger(id) {
    const result = await triggerRcloneSync(id);
    if (result.runId) trackRun(result.runId, id);
  }

  async function viewRun(id) {
    const detail = await getRcloneRunDetail(id);
    setSelectedRun(detail);
  }

  // Remote management handlers
  function openNewRemote() {
    setEditRemote(null);
    setRemoteForm({ name: '', type: providers[0] || 'drive', params: {} });
    setRemoteTestResult(null);
    setShowRemoteForm(true);
  }

  async function openEditRemote(name) {
    try {
      const config = await getRcloneRemoteConfig(name);
      const { name: n, type, ...params } = config;
      setEditRemote(n);
      setRemoteForm({ name: n, type, params });
      setRemoteTestResult(null);
      setShowSensitive({});
      setShowRemoteForm(true);
    } catch (err) {
      alert(`Failed to load config: ${err.message}`);
    }
  }

  async function handleRemoteSubmit(e) {
    e.preventDefault();
    try {
      if (editRemote) {
        // Filter out masked "••••••••" values so they don't overwrite real secrets
        const cleanParams = {};
        for (const [k, v] of Object.entries(remoteForm.params)) {
          if (v !== '••••••••') cleanParams[k] = v;
        }
        await updateRcloneRemote(editRemote, cleanParams);
      } else {
        await createRcloneRemote({ name: remoteForm.name, type: remoteForm.type, params: remoteForm.params });
      }
      setShowRemoteForm(false);
      loadAll();
    } catch (err) {
      alert(err.message);
    }
  }

  async function handleDeleteRemote(name) {
    if (!confirm(`Delete remote "${name}"? Any sync jobs using this remote will stop working.`)) return;
    try {
      await deleteRcloneRemote(name);
      loadAll();
    } catch (err) {
      alert(err.message);
    }
  }

  async function handleTestRemote(name) {
    setRemoteTesting(name);
    setRemoteTestResult(null);
    try {
      const result = await testRcloneRemote(name);
      setRemoteTestResult({ name, ...result });
    } catch (err) {
      setRemoteTestResult({ name, reachable: false, error: err.message });
    }
    setRemoteTesting(null);
  }

  function updateRemoteParam(key, value) {
    setRemoteForm(f => ({ ...f, params: { ...f.params, [key]: value } }));
  }

  if (loading) return <div className="empty-state"><p>Loading...</p></div>;

  return (
    <div className="rclone-page">
      <div className="page-header">
        <h1><Cloud size={24} /> Rclone Sync</h1>
        <button className="btn btn-primary" onClick={() => { setShowForm(true); setEditId(null); setForm(defaultForm()); }}>
          + New Job
        </button>
      </div>

      {/* Configured remotes */}
      <div className="remotes-section">
        <div className="remotes-section-header">
          <h2><Settings size={18} /> Remotes</h2>
          <button className="btn btn-secondary btn-sm" onClick={openNewRemote}><Plus size={14} /> Add Remote</button>
        </div>

        {remotes.length > 0 ? (
          <div className="remotes-grid">
            {remotes.map(r => (
              <div key={r} className="remote-card">
                <div className="remote-card-header">
                  <span className="remote-card-name">{r}</span>
                  <div className="remote-card-actions">
                    <button className="btn btn-ghost btn-sm" onClick={() => handleTestRemote(r)} disabled={remoteTesting === r}>
                      <Plug size={14} />
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => openEditRemote(r)}>
                      <Pencil size={14} />
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => handleDeleteRemote(r)}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
                {remoteTestResult?.name === r && (
                  <div className={`test-result ${remoteTestResult.reachable ? 'success' : 'failure'}`}>
                    {remoteTestResult.reachable
                      ? <><CheckCircle2 size={14} /> Connected{remoteTestResult.total ? ` — ${formatBytes(remoteTestResult.used || 0)} / ${formatBytes(remoteTestResult.total)}` : ''}</>
                      : <><XCircle size={14} /> {remoteTestResult.error || 'Connection failed'}</>}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="remotes-empty">
            <p>No remotes configured. Add one to connect to cloud storage providers.</p>
          </div>
        )}
      </div>

      {/* Remote create/edit modal */}
      {showRemoteForm && (
        <div className="modal-overlay" onClick={() => setShowRemoteForm(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{editRemote ? `Edit Remote: ${editRemote}` : 'New Remote'}</h2>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowRemoteForm(false)}>✕</button>
            </div>
            <form onSubmit={handleRemoteSubmit}>
              <div className="modal-body">
                {!editRemote && (
                  <>
                    <div className="form-group">
                      <label>Remote Name</label>
                      <input
                        value={remoteForm.name}
                        onChange={e => setRemoteForm({ ...remoteForm, name: e.target.value })}
                        required
                        placeholder="e.g. proton-drive"
                        pattern="[a-zA-Z0-9_-]+"
                        title="Letters, numbers, hyphens, and underscores only"
                      />
                    </div>
                    <div className="form-group">
                      <label>Provider Type</label>
                      <select value={remoteForm.type} onChange={e => setRemoteForm({ ...remoteForm, type: e.target.value, params: {} })} required>
                        {providers.map(p => <option key={p} value={p}>{PROVIDER_LABELS[p] || p}</option>)}
                      </select>
                    </div>
                  </>
                )}

                <div className="remote-params">
                  <label className="params-label">Configuration</label>
                  {PROVIDER_FIELDS[remoteForm.type]?.map(field => (
                    <div key={field.key} className="form-group">
                      <label>{field.label}</label>
                      {field.sensitive ? (
                        <div className="token-input">
                          <input
                            type={showSensitive[field.key] ? 'text' : 'password'}
                            value={remoteForm.params[field.key] || ''}
                            onChange={e => updateRemoteParam(field.key, e.target.value)}
                            placeholder={field.placeholder}
                            required={field.required && !editRemote}
                          />
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowSensitive(s => ({ ...s, [field.key]: !s[field.key] }))}>
                            {showSensitive[field.key] ? <EyeOff size={14} /> : <Eye size={14} />}
                          </button>
                        </div>
                      ) : (
                        <input
                          value={remoteForm.params[field.key] || ''}
                          onChange={e => updateRemoteParam(field.key, e.target.value)}
                          placeholder={field.placeholder}
                          required={field.required && !editRemote}
                        />
                      )}
                      {field.hint && <span className="form-hint">{field.hint}</span>}
                    </div>
                  )) || (
                    <div className="form-group">
                      <span className="form-hint">
                        Enter key=value pairs for this provider. Check the <a href="https://rclone.org/overview/" target="_blank" rel="noreferrer">rclone docs</a> for available options.
                      </span>
                      <div className="kv-editor">
                        {Object.entries(remoteForm.params).filter(([k]) => k !== 'type').map(([k, v]) => (
                          <div key={k} className="kv-row">
                            <input value={k} disabled className="kv-key" />
                            <input value={v} onChange={e => updateRemoteParam(k, e.target.value)} className="kv-value" />
                            <button type="button" className="btn btn-ghost btn-sm" onClick={() => {
                              const next = { ...remoteForm.params };
                              delete next[k];
                              setRemoteForm(f => ({ ...f, params: next }));
                            }}><Trash2 size={12} /></button>
                          </div>
                        ))}
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => {
                          const key = prompt('Parameter name:');
                          if (key) updateRemoteParam(key, '');
                        }}><Plus size={12} /> Add Parameter</button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowRemoteForm(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary">{editRemote ? 'Save Changes' : 'Create Remote'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Job list */}
      {jobs.length > 0 ? (
        <div className="config-list">
          {jobs.map(j => (
            <div key={j.id} className="card config-card">
              <div className="config-card-header">
                <div>
                  <span className="config-name">{j.name}</span>
                  <StatusBadge status={j.sync_direction} />
                  <StatusBadge status={j.enabled ? 'running' : 'exited'} label={j.enabled ? 'Active' : 'Disabled'} />
                  {j.bisync_resync_needed ? <StatusBadge status="queued" label="Resync pending" /> : null}
                </div>
                <div className="config-actions">
                  <button className="btn btn-primary btn-sm" onClick={() => handleTrigger(j.id)} disabled={!!getProgressForConfig(j.id)}><Play size={14} /> Run</button>
                  <button className="btn btn-secondary btn-sm" onClick={() => startEdit(j)}><Pencil size={14} /> Edit</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => handleDelete(j.id)}><Trash2 size={14} /></button>
                </div>
              </div>
              <div className="config-details">
                <div className="config-detail"><span className="detail-label">Local Path</span><code>{j.local_path}</code></div>
                <div className="config-detail"><span className="detail-label">Remote</span><code>{j.remote_name}:{j.remote_path}</code></div>
                <div className="config-detail"><span className="detail-label">Schedule</span><span>{describeCron(j.cron_expression)}</span></div>
              </div>
              <JobProgress progress={getProgressForConfig(j.id)} feature="rclone" />
              {j.consecutive_skips > 0 && (
                <div className="skip-warning">
                  <AlertTriangle size={14} />
                  <span>Schedule too aggressive — skipped {j.consecutive_skips} time{j.consecutive_skips > 1 ? 's' : ''} in a row (previous run still active)</span>
                </div>
              )}
            </div>
          ))}
        </div>
      ) : !showForm ? (
        <div className="empty-state card">
          <Cloud size={40} className="empty-icon" />
          <p>No sync jobs configured. Create one to start syncing with cloud storage.</p>
        </div>
      ) : null}

      {/* Form modal */}
      {showForm && (
        <div className="modal-overlay" onClick={() => setShowForm(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{editId ? 'Edit Job' : 'New Rclone Sync Job'}</h2>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowForm(false)}>✕</button>
            </div>
            <form onSubmit={handleSubmit}>
              <div className="modal-body">
                <div className="form-group">
                  <label>Job Name</label>
                  <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required placeholder="e.g. Nextcloud → Proton Drive" />
                </div>

                <div className="form-group">
                  <label>Local Path</label>
                  <PathPicker value={form.local_path} onChange={v => setForm({ ...form, local_path: v })} placeholder="/mnt/user/Documents/dewicadat/files" />
                </div>

                <div className="form-group">
                  <label>Remote</label>
                  <select value={form.remote_name} onChange={e => setForm({ ...form, remote_name: e.target.value })} required>
                    <option value="">Select a remote...</option>
                    {remotes.map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                  {remotes.length === 0 && <span className="form-hint">No remotes found. Add one in the Remotes section above.</span>}
                </div>

                <div className="form-group">
                  <label>Remote Path</label>
                  <input value={form.remote_path} onChange={e => setForm({ ...form, remote_path: e.target.value })} required placeholder="Backups/Nextcloud" />
                </div>

                <div className="form-group">
                  <label>Sync Direction</label>
                  <div className="direction-toggle three">
                    {['upload', 'download', 'bisync'].map(d => (
                      <button key={d} type="button" className={`dir-btn ${form.sync_direction === d ? 'active' : ''}`}
                        onClick={() => setForm({ ...form, sync_direction: d })}>
                        {d === 'upload' && '↑ Upload'}
                        {d === 'download' && '↓ Download'}
                        {d === 'bisync' && '⇅ Bisync'}
                      </button>
                    ))}
                  </div>
                  {form.sync_direction === 'bisync' && (
                    <span className="form-hint"><AlertTriangle size={12} /> Bisync requires an initial --resync run (will happen automatically on first run)</span>
                  )}
                </div>

                <div className="form-group">
                  <label>Schedule</label>
                  <SchedulePicker value={form.cron_expression} onChange={v => setForm({ ...form, cron_expression: v })} />
                </div>

                <div className="form-row">
                  <div className="form-group">
                    <div className="toggle-group">
                      <div className={`toggle ${form.enabled ? 'active' : ''}`} onClick={() => setForm({ ...form, enabled: !form.enabled })} />
                      <span>Enabled</span>
                    </div>
                  </div>
                  <div className="form-group">
                    <div className="toggle-group">
                      <div className={`toggle ${form.notify_on_success ? 'active' : ''}`} onClick={() => setForm({ ...form, notify_on_success: !form.notify_on_success })} />
                      <span>Notify on success</span>
                    </div>
                  </div>
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowForm(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary">{editId ? 'Save Changes' : 'Create Job'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Run history */}
      <div className="runs-section">
        <div className="runs-header">
          <h2><ClipboardList size={18} /> Run History</h2>
          <button className="btn btn-secondary btn-sm" onClick={() => loadRuns(1)}>Refresh</button>
        </div>

        {runs.runs.length > 0 ? (
          <>
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Job</th>
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
                      <td>{jobs.find(j => j.id === r.config_id)?.name || `#${r.config_id}`}</td>
                      <td className="mono-cell">{r.started_at ? new Date(r.started_at).toLocaleString() : '—'}</td>
                      <td>{r.duration_seconds ? `${Math.round(r.duration_seconds)}s` : '—'}</td>
                      <td>{r.files_copied || 0}{r.files_failed ? ` (${r.files_failed} err)` : ''}</td>
                      <td>{formatBytes(r.bytes_transferred || 0)}</td>
                      <td><button className="btn btn-ghost btn-sm" onClick={() => viewRun(r.id)}>View</button></td>
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
          <div className="empty-state"><p>No runs yet</p></div>
        )}
      </div>

      {/* Run detail modal */}
      {selectedRun && (
        <div className="modal-overlay" onClick={() => setSelectedRun(null)}>
          <div className="modal" style={{ maxWidth: '800px' }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Run #{selectedRun.id}</h2>
              <button className="btn btn-ghost btn-sm" onClick={() => setSelectedRun(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="run-summary">
                <div className="run-stat"><span className="run-stat-label">Status</span><StatusBadge status={selectedRun.status} /></div>
                <div className="run-stat"><span className="run-stat-label">Duration</span><span>{selectedRun.duration_seconds ? `${Math.round(selectedRun.duration_seconds)}s` : '—'}</span></div>
                <div className="run-stat"><span className="run-stat-label">Files</span><span>{selectedRun.files_copied || 0}</span></div>
                <div className="run-stat"><span className="run-stat-label">Failed</span><span className={selectedRun.files_failed ? 'danger-text' : ''}>{selectedRun.files_failed || 0}</span></div>
                <div className="run-stat"><span className="run-stat-label">Transferred</span><span>{formatBytes(selectedRun.bytes_transferred || 0)}</span></div>
              </div>
              {selectedRun.error_message && <div className="alert alert-error" style={{ marginTop: 'var(--space-md)' }}>{selectedRun.error_message}</div>}
              {selectedRun.files?.length > 0 && (
                <div className="run-files">
                  <h3>Files ({selectedRun.files.length})</h3>
                  <div className="table-wrapper" style={{ maxHeight: '300px', overflowY: 'auto' }}>
                    <table>
                      <thead><tr><th>Action</th><th>File</th><th>Error</th></tr></thead>
                      <tbody>
                        {selectedRun.files.map((f, i) => (
                          <tr key={i}>
                            <td><StatusBadge status={f.action === 'error' ? 'failed' : 'completed'} label={f.action} /></td>
                            <td className="mono-cell file-path">{f.file_path}</td>
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
    </div>
  );
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

const PROVIDER_LABELS = {
  drive: 'Google Drive',
  onedrive: 'OneDrive',
  protondrive: 'Proton Drive',
  s3: 'Amazon S3 / Compatible',
  b2: 'Backblaze B2',
  dropbox: 'Dropbox',
  sftp: 'SFTP',
  webdav: 'WebDAV',
  box: 'Box',
  mega: 'MEGA',
  pcloud: 'pCloud',
  ftp: 'FTP',
  local: 'Local Path',
};

const PROVIDER_FIELDS = {
  drive: [
    { key: 'client_id', label: 'Client ID', placeholder: 'Google OAuth Client ID', sensitive: false },
    { key: 'client_secret', label: 'Client Secret', placeholder: 'Google OAuth Client Secret', sensitive: true },
    { key: 'token', label: 'OAuth Token (JSON)', placeholder: '{"access_token":"...","token_type":"Bearer",...}', sensitive: true, hint: 'Paste the full JSON token from rclone authorize' },
    { key: 'root_folder_id', label: 'Root Folder ID', placeholder: 'Leave empty for root', sensitive: false },
  ],
  onedrive: [
    { key: 'client_id', label: 'Client ID', placeholder: 'Azure App Client ID', sensitive: false },
    { key: 'client_secret', label: 'Client Secret', placeholder: 'Azure App Client Secret', sensitive: true },
    { key: 'token', label: 'OAuth Token (JSON)', placeholder: '{"access_token":"..."}', sensitive: true },
    { key: 'drive_type', label: 'Drive Type', placeholder: 'personal / business / documentLibrary', sensitive: false },
  ],
  protondrive: [
    { key: 'username', label: 'Username', placeholder: 'your@proton.me', sensitive: false, required: true },
    { key: 'password', label: 'Password', placeholder: 'Proton account password', sensitive: true, required: true },
    { key: '2fa', label: '2FA Code', placeholder: 'Leave empty if not set', sensitive: false },
  ],
  s3: [
    { key: 'provider', label: 'Provider', placeholder: 'AWS / Minio / Wasabi / Other', sensitive: false },
    { key: 'access_key_id', label: 'Access Key', placeholder: 'AWS access key', sensitive: false, required: true },
    { key: 'secret_access_key', label: 'Secret Key', placeholder: 'AWS secret key', sensitive: true, required: true },
    { key: 'region', label: 'Region', placeholder: 'us-east-1', sensitive: false },
    { key: 'endpoint', label: 'Endpoint', placeholder: 'Leave empty for AWS', sensitive: false },
  ],
  b2: [
    { key: 'account', label: 'Account ID', placeholder: 'B2 Application Key ID', sensitive: false, required: true },
    { key: 'key', label: 'Application Key', placeholder: 'B2 Application Key', sensitive: true, required: true },
  ],
  dropbox: [
    { key: 'client_id', label: 'Client ID', placeholder: 'Dropbox App Key', sensitive: false },
    { key: 'client_secret', label: 'Client Secret', placeholder: 'Dropbox App Secret', sensitive: true },
    { key: 'token', label: 'OAuth Token (JSON)', placeholder: '{"access_token":"..."}', sensitive: true },
  ],
  sftp: [
    { key: 'host', label: 'Host', placeholder: 'hostname or IP', sensitive: false, required: true },
    { key: 'user', label: 'Username', placeholder: 'root', sensitive: false, required: true },
    { key: 'port', label: 'Port', placeholder: '22', sensitive: false },
    { key: 'pass', label: 'Password', placeholder: 'Leave empty for key-based auth', sensitive: true },
    { key: 'key_file', label: 'Key File Path', placeholder: '/root/.ssh/id_rsa', sensitive: false },
  ],
  webdav: [
    { key: 'url', label: 'URL', placeholder: 'https://cloud.example.com/remote.php/webdav', sensitive: false, required: true },
    { key: 'vendor', label: 'Vendor', placeholder: 'nextcloud / owncloud / sharepoint / other', sensitive: false },
    { key: 'user', label: 'Username', placeholder: 'admin', sensitive: false },
    { key: 'pass', label: 'Password', placeholder: 'App password', sensitive: true },
  ],
  ftp: [
    { key: 'host', label: 'Host', placeholder: 'ftp.example.com', sensitive: false, required: true },
    { key: 'user', label: 'Username', placeholder: 'anonymous', sensitive: false },
    { key: 'pass', label: 'Password', placeholder: 'FTP password', sensitive: true },
    { key: 'port', label: 'Port', placeholder: '21', sensitive: false },
  ],
  mega: [
    { key: 'user', label: 'Username', placeholder: 'your@email.com', sensitive: false, required: true },
    { key: 'pass', label: 'Password', placeholder: 'MEGA password', sensitive: true, required: true },
  ],
  box: [
    { key: 'client_id', label: 'Client ID', placeholder: 'Box App Client ID', sensitive: false },
    { key: 'client_secret', label: 'Client Secret', placeholder: 'Box App Client Secret', sensitive: true },
    { key: 'token', label: 'OAuth Token (JSON)', placeholder: '{"access_token":"..."}', sensitive: true },
  ],
  pcloud: [
    { key: 'client_id', label: 'Client ID', placeholder: 'pCloud App Client ID', sensitive: false },
    { key: 'client_secret', label: 'Client Secret', placeholder: 'pCloud App Client Secret', sensitive: true },
    { key: 'token', label: 'OAuth Token (JSON)', placeholder: '{"access_token":"..."}', sensitive: true },
  ],
  local: [
    { key: 'nounc', label: 'Disable UNC paths', placeholder: 'true', sensitive: false, hint: 'Usually not needed on Linux' },
  ],
};

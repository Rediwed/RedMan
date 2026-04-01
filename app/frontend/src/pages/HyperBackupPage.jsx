import { useState, useEffect } from 'react';
import {
  getHyperJobs, createHyperJob, updateHyperJob, deleteHyperJob,
  triggerHyperBackup, testHyperConnection, getHyperRuns, getHyperRunDetail,
  getSshStatus, generateSshKey, authorizeLocalSsh, testSshConnection,
} from '../api/index.js';
import { RefreshCw, Play, Pencil, Trash2, ClipboardList, Plug, Search, CheckCircle2, XCircle, Key, Settings, Copy, Check, Terminal, Shield, AlertTriangle } from 'lucide-react';
import StatusBadge from '../components/StatusBadge.jsx';
import PathPicker from '../components/PathPicker.jsx';
import JobProgress from '../components/JobProgress.jsx';
import SchedulePicker, { describeCron } from '../components/SchedulePicker.jsx';
import useJobProgress from '../hooks/useJobProgress.js';
import './HyperBackupPage.css';

export default function HyperBackupPage() {
  const [jobs, setJobs] = useState([]);
  const [runs, setRuns] = useState({ runs: [], page: 1, totalPages: 0 });
  const [selectedRun, setSelectedRun] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(defaultForm());
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [ssh, setSsh] = useState({ keyExists: false, publicKey: null });
  const [showSshModal, setShowSshModal] = useState(false);
  const [sshGenerating, setSshGenerating] = useState(false);
  const [sshCopied, setSshCopied] = useState(false);
  const [sshAuthorizing, setSshAuthorizing] = useState(false);
  const [sshAuthorized, setSshAuthorized] = useState(false);
  const [sshTestResult, setSshTestResult] = useState(null);

  const { trackRun, detectRunning, getProgressForConfig } = useJobProgress(getHyperRunDetail, () => loadAll());

  function defaultForm() {
    return {
      name: '', direction: 'push',
      remote_url: '', remote_api_key: '',
      local_path: '', remote_path: '',
      ssh_user: 'root', ssh_host: '', ssh_port: 22,
      cron_expression: '0 2 * * *',
      enabled: true, notify_on_success: true, notify_on_failure: true,
    };
  }

  useEffect(() => { loadAll(); }, []);

  async function loadAll() {
    setLoading(true);
    try {
      const [j, r, s] = await Promise.all([getHyperJobs(), getHyperRuns(1), getSshStatus()]);
      setJobs(j);
      setRuns(r);
      setSsh(s);
      detectRunning(r.runs);
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  }

  async function loadRuns(page = 1) {
    const r = await getHyperRuns(page);
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
      await updateHyperJob(editId, data);
    } else {
      await createHyperJob(data);
    }
    setShowForm(false);
    setEditId(null);
    setForm(defaultForm());
    setTestResult(null);
    loadAll();
  }

  function startEdit(job) {
    setForm({
      name: job.name, direction: job.direction,
      remote_url: job.remote_url, remote_api_key: '',
      local_path: job.local_path, remote_path: job.remote_path,
      ssh_user: job.ssh_user || 'root', ssh_host: job.ssh_host || '',
      ssh_port: job.ssh_port || 22, cron_expression: job.cron_expression,
      enabled: !!job.enabled,
      notify_on_success: !!job.notify_on_success,
      notify_on_failure: !!job.notify_on_failure,
    });
    setEditId(job.id);
    setShowForm(true);
    setTestResult(null);
  }

  async function handleDelete(id) {
    if (!confirm('Delete this Hyper Backup job?')) return;
    await deleteHyperJob(id);
    loadAll();
  }

  async function handleTrigger(id) {
    const result = await triggerHyperBackup(id);
    if (result.runId) trackRun(result.runId, id);
  }

  async function handleTestConnection() {
    if (!form.remote_url || !form.remote_api_key) {
      setTestResult({ reachable: false, error: 'Remote URL and API key required' });
      return;
    }
    setTesting(true);
    try {
      const result = await testHyperConnection({ remote_url: form.remote_url, remote_api_key: form.remote_api_key });
      setTestResult(result);
    } catch (err) {
      setTestResult({ reachable: false, error: err.message });
    }
    setTesting(false);
  }

  async function viewRun(id) {
    const detail = await getHyperRunDetail(id);
    setSelectedRun(detail);
  }

  // Intercept actions that require SSH
  function requireSsh(action) {
    if (!ssh.keyExists) {
      setShowSshModal(true);
      return;
    }
    action();
  }

  if (loading) return <div className="empty-state"><p>Loading...</p></div>;

  return (
    <div className="hyper-page">
      <div className="page-header">
        <h1><RefreshCw size={24} /> Hyper Backup</h1>
        <button className="btn btn-primary" onClick={() => requireSsh(() => { setShowForm(true); setEditId(null); setForm(defaultForm()); setTestResult(null); })}>
          + New Job
        </button>
      </div>

      {/* SSH Setup Wizard — first-time setup, subsequent changes in Settings */}
      {showSshModal && (
        <div className="modal-overlay" onClick={() => setShowSshModal(false)}>
          <div className="modal" style={{ maxWidth: '560px' }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2><Key size={18} /> SSH Setup</h2>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowSshModal(false)}>✕</button>
            </div>
            <div className="modal-body">
              <p style={{ marginBottom: 'var(--space-md)' }}>
                Hyper Backup uses rsync over SSH. {ssh.keyExists ? 'Your SSH key is ready.' : 'Generate an SSH key to get started.'}
              </p>

              {/* Step 1: Generate key */}
              {!ssh.keyExists ? (
                <div className="ssh-wizard-step">
                  <h3><span className="step-num">1</span> Generate SSH Key</h3>
                  <button
                    className="btn btn-primary"
                    disabled={sshGenerating}
                    onClick={async () => {
                      setSshGenerating(true);
                      try {
                        const result = await generateSshKey();
                        setSsh({ keyExists: true, publicKey: result.publicKey });
                      } catch (err) { alert(err.message); }
                      setSshGenerating(false);
                    }}
                  >
                    <Key size={14} /> {sshGenerating ? 'Generating...' : 'Generate Key'}
                  </button>
                </div>
              ) : (
                <>
                  {/* Key generated — show public key */}
                  <div className="ssh-wizard-step">
                    <h3><CheckCircle2 size={16} className="text-success" /> SSH Key Ready</h3>
                    {ssh.publicKey && (
                      <div className="ssh-pubkey-box">
                        <code>{ssh.publicKey}</code>
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => {
                            navigator.clipboard.writeText(ssh.publicKey);
                            setSshCopied(true);
                            setTimeout(() => setSshCopied(false), 2000);
                          }}
                        >
                          {sshCopied ? <><Check size={14} /> Copied</> : <><Copy size={14} /> Copy</>}
                        </button>
                      </div>
                    )}
                    <span className="form-hint">Add this public key to <code>~/.ssh/authorized_keys</code> on your remote hosts.</span>
                  </div>

                  {/* Step 2: Authorize localhost (optional) */}
                  <div className="ssh-wizard-step">
                    <h3><Shield size={16} /> Authorize Localhost</h3>
                    <span className="form-hint" style={{ marginBottom: 'var(--space-sm)', display: 'block' }}>
                      For peer-to-peer backups on the same machine, authorize SSH to localhost.
                    </span>
                    <button
                      className="btn btn-secondary btn-sm"
                      disabled={sshAuthorizing || sshAuthorized}
                      onClick={async () => {
                        setSshAuthorizing(true);
                        try {
                          await authorizeLocalSsh();
                          setSshAuthorized(true);
                        } catch (err) { alert(err.message); }
                        setSshAuthorizing(false);
                      }}
                    >
                      <Terminal size={14} /> {sshAuthorized ? 'Authorized ✓' : sshAuthorizing ? 'Authorizing...' : 'Authorize Localhost'}
                    </button>
                  </div>

                  {/* Step 3: Test (optional) */}
                  <div className="ssh-wizard-step">
                    <h3><Plug size={16} /> Test Connection</h3>
                    <div style={{ display: 'flex', gap: 'var(--space-sm)', alignItems: 'center' }}>
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={async () => {
                          setSshTestResult(null);
                          try {
                            const r = await testSshConnection({ host: 'localhost', user: 'root' });
                            setSshTestResult(r);
                          } catch (err) { setSshTestResult({ ok: false, error: err.message }); }
                        }}
                      >
                        <Search size={14} /> Test localhost
                      </button>
                      {sshTestResult && (
                        <span className={sshTestResult.ok ? 'text-success' : 'text-danger'}>
                          {sshTestResult.ok ? <><CheckCircle2 size={14} /> Connected</> : <><XCircle size={14} /> {sshTestResult.error}</>}
                        </span>
                      )}
                    </div>
                  </div>
                </>
              )}

              <div className="alert-info" style={{ marginTop: 'var(--space-md)' }}>
                <Settings size={14} />
                <span>After initial setup, manage SSH keys in <strong>Settings → Infrastructure</strong>.</span>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setShowSshModal(false)}>
                {ssh.keyExists ? 'Done' : 'Cancel'}
              </button>
              {ssh.keyExists && (
                <button className="btn btn-primary" onClick={() => {
                  setShowSshModal(false);
                  setShowForm(true);
                  setEditId(null);
                  setForm(defaultForm());
                  setTestResult(null);
                }}>
                  Continue to New Job →
                </button>
              )}
            </div>
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
                  <StatusBadge status={j.direction} />
                  <StatusBadge status={j.enabled ? 'running' : 'exited'} label={j.enabled ? 'Active' : 'Disabled'} />
                </div>
                <div className="config-actions">
                  <button className="btn btn-primary btn-sm" onClick={() => requireSsh(() => handleTrigger(j.id))} disabled={!!getProgressForConfig(j.id)}><Play size={14} /> Run</button>
                  <button className="btn btn-secondary btn-sm" onClick={() => startEdit(j)}><Pencil size={14} /> Edit</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => handleDelete(j.id)}><Trash2 size={14} /></button>
                </div>
              </div>
              <div className="config-details">
                <div className="config-detail"><span className="detail-label">Local Path</span><code>{j.local_path}</code></div>
                <div className="config-detail"><span className="detail-label">Remote Path</span><code>{j.remote_path}</code></div>
                <div className="config-detail"><span className="detail-label">Remote URL</span><code>{j.remote_url}</code></div>
                <div className="config-detail"><span className="detail-label">Schedule</span><span>{describeCron(j.cron_expression)}</span></div>
              </div>
              <JobProgress progress={getProgressForConfig(j.id)} feature="hyper-backup" />
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
          <RefreshCw size={40} className="empty-icon" />
          <p>No Hyper Backup jobs yet. Create one to start cross-site backups.</p>
        </div>
      ) : null}

      {/* Form modal */}
      {showForm && (
        <div className="modal-overlay" onClick={() => setShowForm(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{editId ? 'Edit Job' : 'New Hyper Backup Job'}</h2>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowForm(false)}>✕</button>
            </div>
            <form onSubmit={handleSubmit}>
              <div className="modal-body">
                <div className="form-group">
                  <label>Job Name</label>
                  <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required placeholder="e.g. Documents → Dad's NAS" />
                </div>

                <div className="form-group">
                  <label>Direction</label>
                  <div className="direction-toggle">
                    <button type="button" className={`dir-btn ${form.direction === 'push' ? 'active' : ''}`} onClick={() => setForm({ ...form, direction: 'push' })}>
                      ↑ Push (Send to remote)
                    </button>
                    <button type="button" className={`dir-btn ${form.direction === 'pull' ? 'active' : ''}`} onClick={() => setForm({ ...form, direction: 'pull' })}>
                      ↓ Pull (Receive from remote)
                    </button>
                  </div>
                </div>

                <div className="form-group">
                  <label>Remote RedMan URL</label>
                  <input value={form.remote_url} onChange={e => setForm({ ...form, remote_url: e.target.value })} required placeholder="http://100.90.128.2:8091" />
                  <span className="form-hint">The peer API URL of the remote RedMan instance</span>
                </div>

                <div className="form-group">
                  <label>Remote API Key</label>
                  <input type="password" value={form.remote_api_key} onChange={e => setForm({ ...form, remote_api_key: e.target.value })} placeholder={editId ? 'Leave empty to keep existing' : 'Peer API key'} required={!editId} />
                </div>

                <div className="form-group">
                  <button type="button" className="btn btn-secondary btn-sm" onClick={handleTestConnection} disabled={testing}>
                    {testing ? <><Search size={14} /> Testing...</> : <><Plug size={14} /> Test Connection</>}
                  </button>
                  {testResult && (
                    <div className={`test-result ${testResult.reachable ? 'success' : 'failure'}`}>
                      {testResult.reachable
                        ? <><CheckCircle2 size={14} /> Connected to {testResult.instance || 'remote'} ({testResult.version || '?'})</>
                        : <><XCircle size={14} /> {testResult.error || 'Connection failed'}</>}
                    </div>
                  )}
                </div>

                <div className="form-row">
                  <div className="form-group">
                    <label>SSH User</label>
                    <input value={form.ssh_user} onChange={e => setForm({ ...form, ssh_user: e.target.value })} placeholder="root" />
                  </div>
                  <div className="form-group">
                    <label>SSH Host (override)</label>
                    <input value={form.ssh_host} onChange={e => setForm({ ...form, ssh_host: e.target.value })} placeholder="Auto-detected from remote URL" />
                  </div>
                </div>

                <div className="form-group">
                  <label>Local Path</label>
                  <PathPicker value={form.local_path} onChange={v => setForm({ ...form, local_path: v })} placeholder="/mnt/user/Documents" />
                </div>

                <div className="form-group">
                  <label>Remote Path</label>
                  <input value={form.remote_path} onChange={e => setForm({ ...form, remote_path: e.target.value })} required placeholder="/mnt/user/Backups/Documents" />
                  <span className="form-hint">Path on the remote system</span>
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
                      <td>{r.files_copied || 0}</td>
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
                <div className="run-stat"><span className="run-stat-label">Transferred</span><span>{formatBytes(selectedRun.bytes_transferred || 0)}</span></div>
              </div>
              {selectedRun.error_message && <div className="alert alert-error" style={{ marginTop: 'var(--space-md)' }}>{selectedRun.error_message}</div>}
              {selectedRun.files?.length > 0 && (
                <div className="run-files">
                  <h3>Files ({selectedRun.files.length})</h3>
                  <div className="table-wrapper" style={{ maxHeight: '300px', overflowY: 'auto' }}>
                    <table>
                      <thead><tr><th>Action</th><th>File</th><th>Size</th></tr></thead>
                      <tbody>
                        {selectedRun.files.map((f, i) => (
                          <tr key={i}>
                            <td><StatusBadge status="completed" label={f.action} /></td>
                            <td className="mono-cell file-path">{f.file_path}</td>
                            <td>{formatBytes(f.size || 0)}</td>
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

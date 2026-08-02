import { useState, useEffect, useCallback } from 'react';
import {
  getRcloneRemotes, getRcloneJobs, createRcloneJob, updateRcloneJob,
  deleteRcloneJob, triggerRcloneSync, cancelRcloneSync, getRcloneRuns, getRcloneRunDetail, getRcloneRunProgress,
  getRcloneProviders, getRcloneRemoteConfig, createRcloneRemote,
  updateRcloneRemote, deleteRcloneRemote, testRcloneRemote,
} from '../api/index.js';
import useReconnect from '../hooks/useReconnect.js';
import { Cloud, Play, Pencil, Trash2, ClipboardList, AlertTriangle, Plus, Plug, CheckCircle2, XCircle, Settings, Eye, EyeOff, Copy, ChevronRight, ChevronDown, ExternalLink, Loader2, Terminal } from 'lucide-react';
import StatusBadge from '../components/StatusBadge.jsx';
import PathPicker from '../components/PathPicker.jsx';
import JobProgress from '../components/JobProgress.jsx';
import SchedulePicker, { describeCron } from '../components/SchedulePicker.jsx';
import useJobProgress from '../hooks/useJobProgress.js';
import { useSettings } from '../contexts/SettingsContext.jsx';
import { formatDateTime } from '../utils/dateFormat.js';
import { formatBytes } from '../utils/formatBytes.js';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import BackupHealth from '../components/BackupHealth.jsx';
import NotificationPolicyField from '../components/NotificationPolicyField.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import { DialogSurface } from '../components/Dialog.jsx';
import './RclonePage.css';

export default function RclonePage() {
  const auth = useAuth();
  const { settings } = useSettings();
  const [remotes, setRemotes] = useState([]);
  const [providers, setProviders] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [runs, setRuns] = useState({ runs: [], page: 1, totalPages: 0 });
  const [runJobFilter, setRunJobFilter] = useState('');
  const [selectedRun, setSelectedRun] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(defaultForm());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [formError, setFormError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteError, setDeleteError] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [remoteDeleteTarget, setRemoteDeleteTarget] = useState(null);
  const [remoteActionError, setRemoteActionError] = useState(null);

  // Remote management state
  const [showRemoteForm, setShowRemoteForm] = useState(false);
  const [editRemote, setEditRemote] = useState(null);
  const [remoteForm, setRemoteForm] = useState({ name: '', type: '', params: {} });
  const [remoteTestResult, setRemoteTestResult] = useState(null);
  const [remoteTesting, setRemoteTesting] = useState(null);
  const [showSensitive, setShowSensitive] = useState({});
  const [wizardStep, setWizardStep] = useState(1);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [copied, setCopied] = useState(false);
  const [autoTesting, setAutoTesting] = useState(false);
  const [createTestResult, setCreateTestResult] = useState(null);

  const { trackRun, detectRunning, getProgressForConfig, getRunIdForConfig } = useJobProgress(getRcloneRunProgress, () => loadAll());

  function defaultForm() {
    return {
      name: '', local_path: '', remote_name: '', remote_path: '',
      sync_direction: 'upload', cron_expression: '0 3 * * *',
      enabled: true, notify_mode: 'global', notify_on_start: true, notify_on_success: true, notify_on_failure: true,
    };
  }

  useEffect(() => { loadAll(); }, []);
  useEffect(() => { loadRuns(1); }, [runJobFilter]);
  useReconnect(useCallback(() => loadAll(), []));

  async function loadAll() {
    setLoading(true);
    setLoadError(null);
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
      setLoadError(err.message);
    }
    setLoading(false);
  }

  async function loadRuns(page = 1) {
    try {
      setLoadError(null);
      const r = await getRcloneRuns(page, runJobFilter || undefined);
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
      enabled: form.enabled ? 1 : 0,
      notify_mode: form.notify_mode,
      notify_on_start: form.notify_on_start ? 1 : 0,
      notify_on_success: form.notify_on_success ? 1 : 0,
      notify_on_failure: form.notify_on_failure ? 1 : 0,
    };

    try {
      if (editId) {
        await updateRcloneJob(editId, data);
      } else {
        await createRcloneJob(data);
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

  function startEdit(job) {
    setForm({
      name: job.name, local_path: job.local_path,
      remote_name: job.remote_name, remote_path: job.remote_path,
      sync_direction: job.sync_direction, cron_expression: job.cron_expression,
      enabled: !!job.enabled,
      notify_mode: job.notify_mode || 'global',
      notify_on_start: job.notify_on_start !== undefined ? !!job.notify_on_start : true,
      notify_on_success: !!job.notify_on_success,
      notify_on_failure: !!job.notify_on_failure,
    });
    setEditId(job.id);
    setFormError(null);
    setShowForm(true);
    setNameManual(true);
  }

  async function handleDelete(id) {
    setDeleteError(null);
    setDeleteTarget(jobs.find(job => job.id === id) || { id, name: `Job ${id}` });
  }

  async function confirmDelete() {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteRcloneJob(deleteTarget.id);
      setDeleteTarget(null);
      loadAll();
    } catch (err) {
      setDeleteError(err.message);
    } finally {
      setDeleting(false);
    }
  }

  const [nameManual, setNameManual] = useState(false);

  function suggestName(localPath, remoteName) {
    const seg = p => p?.replace(/\/+$/, '').split('/').pop() || '';
    const local = seg(localPath);
    return local && remoteName ? `${local} → ${remoteName}` : local || '';
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
    setShowSensitive({});
    setWizardStep(1);
    setShowAdvanced(false);
    setCopied(false);
    setAutoTesting(false);
    setCreateTestResult(null);
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
      setShowAdvanced(false);
      setShowRemoteForm(true);
    } catch (err) {
      setRemoteActionError(`Failed to load config: ${err.message}`);
    }
  }

  async function handleRemoteSubmit(e) {
    if (e) e.preventDefault();
    try {
      if (editRemote) {
        const cleanParams = {};
        for (const [k, v] of Object.entries(remoteForm.params)) {
          if (v !== '••••••••') cleanParams[k] = v;
        }
        if (cleanParams.token) cleanParams.token = extractToken(cleanParams.token) || cleanParams.token;
        await updateRcloneRemote(editRemote, cleanParams);
        setShowRemoteForm(false);
        loadAll();
      } else {
        const params = {};
        for (const [k, v] of Object.entries(remoteForm.params)) {
          if (v !== undefined && v !== null && v !== '') {
            params[k] = k === 'token' ? (extractToken(v) || v) : v;
          }
        }
        await createRcloneRemote({ name: remoteForm.name, type: remoteForm.type, params });
        setWizardStep(3);
        setAutoTesting(true);
        loadAll();
        try {
          const result = await testRcloneRemote(remoteForm.name);
          setCreateTestResult(result);
        } catch {
          setCreateTestResult({ reachable: false, error: 'Connection test failed' });
        }
        setAutoTesting(false);
      }
    } catch (err) {
      setRemoteActionError(err.message);
    }
  }

  async function handleDeleteRemote(name) {
    setRemoteActionError(null);
    setRemoteDeleteTarget(name);
  }

  async function confirmDeleteRemote() {
    setDeleting(true);
    setRemoteActionError(null);
    try {
      await deleteRcloneRemote(remoteDeleteTarget);
      setRemoteDeleteTarget(null);
      loadAll();
    } catch (err) {
      setRemoteActionError(err.message);
    } finally {
      setDeleting(false);
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

  function getAuthorizeCommand(type, params = {}) {
    let cmd = `rclone authorize "${type}"`;
    if (params.client_id && params.client_secret) {
      cmd += ` "${params.client_id}" "${params.client_secret}"`;
    }
    return cmd;
  }

  function extractToken(str) {
    if (!str || !str.trim()) return '';
    const trimmed = str.trim();
    try { if (JSON.parse(trimmed).access_token) return trimmed; } catch {}
    const match = trimmed.match(/--->\s*(\{[\s\S]*?\})\s*<---/);
    if (match) {
      try { if (JSON.parse(match[1].trim()).access_token) return match[1].trim(); } catch {}
    }
    return '';
  }

  function validateTokenJson(str) {
    if (!str || !str.trim()) return null;
    return extractToken(str) !== '';
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const el = document.createElement('textarea');
      el.value = text;
      el.style.position = 'fixed';
      el.style.opacity = '0';
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function renderFormField(field, editMode = false) {
    return (
      <div key={field.key} className="form-group">
        <label>{field.label}{field.required && !editMode ? ' *' : ''}</label>
        {field.sensitive ? (
          <div className="token-input">
            <input
              type={showSensitive[field.key] ? 'text' : 'password'}
              value={remoteForm.params[field.key] || ''}
              onChange={e => updateRemoteParam(field.key, e.target.value)}
              placeholder={field.placeholder}
              required={field.required && !editMode}
            />
            <button type="button" className="btn btn-ghost btn-sm" aria-label={`${showSensitive[field.key] ? 'Hide' : 'Show'} ${field.label}`} title={`${showSensitive[field.key] ? 'Hide' : 'Show'} ${field.label}`} onClick={() => setShowSensitive(s => ({ ...s, [field.key]: !s[field.key] }))}>
              {showSensitive[field.key] ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        ) : (
          <input
            value={remoteForm.params[field.key] || ''}
            onChange={e => updateRemoteParam(field.key, e.target.value)}
            placeholder={field.placeholder}
            required={field.required && !editMode}
          />
        )}
        {field.hint && <span className="form-hint">{field.hint}</span>}
      </div>
    );
  }

  if (loading) return <div className="empty-state"><p>Loading...</p></div>;

  return (
    <div className="rclone-page">
      <div className="page-header">
        <h1><Cloud size={24} /> Cloud Backup</h1>
        {auth.isAdmin && <button className="btn btn-primary" onClick={() => { setShowForm(true); setEditId(null); setForm(defaultForm()); setNameManual(false); setFormError(null); }}>
          + New Job
        </button>}
      </div>

      {loadError && (
        <div className="alert alert-error" role="alert">
          <span>{loadError}</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={loadAll}>Retry</button>
        </div>
      )}

      {remoteActionError && !remoteDeleteTarget && (
        <div className="alert alert-error" role="alert">{remoteActionError}</div>
      )}

      {/* Configured remotes */}
      <div className="remotes-section">
        <div className="remotes-section-header">
          <h2><Settings size={18} /> Remotes</h2>
          {auth.isAdmin && <button className="btn btn-secondary btn-sm" onClick={openNewRemote}><Plus size={14} /> Add Remote</button>}
        </div>

        {remotes.length > 0 ? (
          <div className="remotes-grid">
            {remotes.map(r => (
              <div key={r} className="remote-card">
                <div className="remote-card-header">
                  <span className="remote-card-name">{r}</span>
                  {auth.isAdmin && <div className="remote-card-actions">
                    <button className="btn btn-ghost btn-sm" onClick={() => handleTestRemote(r)} disabled={remoteTesting === r} title="Test remote" aria-label={`Test ${r}`}>
                      <Plug size={14} />
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => openEditRemote(r)} title="Edit remote" aria-label={`Edit ${r}`}>
                      <Pencil size={14} />
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => handleDeleteRemote(r)} title="Delete remote" aria-label={`Delete ${r}`}>
                      <Trash2 size={14} />
                    </button>
                  </div>}
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
        <DialogSurface ariaLabel={editRemote ? `Edit remote ${editRemote}` : 'New remote'} onClose={() => setShowRemoteForm(false)}>
            <div className="modal-header">
              <h2>{editRemote ? `Edit Remote: ${editRemote}` : 'New Remote'}</h2>
              {!editRemote && wizardStep < 3 && (
                <div className="wizard-steps">
                  <span className={`wizard-dot ${wizardStep >= 1 ? 'active' : ''}`} />
                  <span className={`wizard-dot ${wizardStep >= 2 ? 'active' : ''}`} />
                </div>
              )}
              <button className="btn btn-ghost btn-sm" onClick={() => setShowRemoteForm(false)} title="Close" aria-label="Close remote form">✕</button>
            </div>

            {editRemote ? (
              /* ---- EDIT MODE ---- */
              <form onSubmit={handleRemoteSubmit}>
                <div className="modal-body">
                  <div className="remote-params">
                    {PROVIDER_FIELDS[remoteForm.type] ? (
                      <>
                        {(PROVIDER_FIELDS[remoteForm.type]).filter(f => !f.advanced && !f.oauth).map(f => renderFormField(f, true))}

                        {OAUTH_PROVIDERS.has(remoteForm.type) && (
                          <div className="form-group">
                            <label>Account Connection</label>
                            {remoteForm.params.token ? (
                              <span className="form-hint oauth-status connected"><CheckCircle2 size={12} /> Connected (token saved)</span>
                            ) : (
                              <span className="form-hint oauth-status"><AlertTriangle size={12} /> No token configured</span>
                            )}
                          </div>
                        )}

                        {((PROVIDER_FIELDS[remoteForm.type]).filter(f => f.advanced).length > 0 || OAUTH_PROVIDERS.has(remoteForm.type)) && (
                          <>
                            <button type="button" className="advanced-toggle" onClick={() => setShowAdvanced(a => !a)}>
                              {showAdvanced ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                              {OAUTH_PROVIDERS.has(remoteForm.type) ? 'Advanced options & reconnect' : 'Advanced options'}
                            </button>
                            {showAdvanced && (
                              <div className="advanced-fields">
                                {OAUTH_PROVIDERS.has(remoteForm.type) && (
                                  <div className="oauth-section">
                                    <label>Re-authorize</label>
                                    <div className="authorize-command">
                                      <code>{getAuthorizeCommand(remoteForm.type, remoteForm.params)}</code>
                                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => copyToClipboard(getAuthorizeCommand(remoteForm.type, remoteForm.params))}>
                                        {copied ? <CheckCircle2 size={14} /> : <Copy size={14} />}
                                      </button>
                                    </div>
                                    <span className="form-hint">Run this on a machine with a web browser, then paste the token below.</span>
                                    <textarea
                                      className="token-paste"
                                      rows={3}
                                      value={remoteForm.params.token === '••••••••' ? '' : (remoteForm.params.token || '')}
                                      onChange={e => updateRemoteParam('token', e.target.value)}
                                      placeholder="Paste the new token JSON here..."
                                    />
                                    {(() => {
                                      const v = validateTokenJson(remoteForm.params.token === '••••••••' ? '' : remoteForm.params.token);
                                      if (v === null) return null;
                                      return v
                                        ? <span className="form-hint oauth-status connected"><CheckCircle2 size={12} /> Valid token</span>
                                        : <span className="form-hint danger-text">Doesn't look like valid token JSON</span>;
                                    })()}
                                  </div>
                                )}
                                {(PROVIDER_FIELDS[remoteForm.type]).filter(f => f.advanced).map(f => renderFormField(f, true))}
                              </div>
                            )}
                          </>
                        )}
                      </>
                    ) : (
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
                  <button type="submit" className="btn btn-primary">Save Changes</button>
                </div>
              </form>

            ) : wizardStep === 1 ? (
              /* ---- CREATE STEP 1: Name + Provider ---- */
              <div>
                <div className="modal-body">
                  <div className="form-group">
                    <label>Remote Name</label>
                    <input
                      value={remoteForm.name}
                      onChange={e => setRemoteForm({ ...remoteForm, name: e.target.value })}
                      placeholder="e.g. proton-drive"
                      pattern="[a-zA-Z0-9_-]+"
                      title="Letters, numbers, hyphens, and underscores only"
                      autoFocus
                    />
                  </div>
                  <div className="form-group">
                    <label>Provider Type</label>
                    <select value={remoteForm.type} onChange={e => setRemoteForm({ ...remoteForm, type: e.target.value, params: {} })}>
                      {providers.map(p => <option key={p} value={p}>{PROVIDER_LABELS[p] || p}</option>)}
                    </select>
                  </div>
                </div>
                <div className="modal-footer">
                  <button type="button" className="btn btn-secondary" onClick={() => setShowRemoteForm(false)}>Cancel</button>
                  <button type="button" className="btn btn-primary"
                    disabled={!remoteForm.name || !remoteForm.type || !/^[a-zA-Z0-9_-]+$/.test(remoteForm.name)}
                    onClick={() => { setShowAdvanced(false); setWizardStep(2); }}>
                    Next →
                  </button>
                </div>
              </div>

            ) : wizardStep === 2 ? (
              /* ---- CREATE STEP 2: Configure ---- */
              <form onSubmit={handleRemoteSubmit}>
                <div className="modal-body">
                  {OAUTH_PROVIDERS.has(remoteForm.type) ? (
                    /* OAuth provider wizard */
                    <div className="oauth-wizard">
                      <div className="oauth-section">
                        <h3><Terminal size={16} /> Authorize {PROVIDER_LABELS[remoteForm.type]}</h3>
                        <p className="oauth-instructions">
                          Run this command on a machine with a web browser, then paste the resulting token below:
                        </p>
                        <div className="authorize-command">
                          <code>{getAuthorizeCommand(remoteForm.type, remoteForm.params)}</code>
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => copyToClipboard(getAuthorizeCommand(remoteForm.type, remoteForm.params))}>
                            {copied ? <CheckCircle2 size={14} /> : <Copy size={14} />}
                          </button>
                        </div>
                        <label>Paste token here</label>
                        <textarea
                          className="token-paste"
                          rows={4}
                          value={remoteForm.params.token || ''}
                          onChange={e => updateRemoteParam('token', e.target.value)}
                          placeholder={'Paste the full token output from rclone authorize here...\n\nBoth the raw JSON and the "Paste the following --->" format are supported.'}
                        />
                        {(() => {
                          const v = validateTokenJson(remoteForm.params.token);
                          if (v === null) return null;
                          return v
                            ? <span className="form-hint oauth-status connected"><CheckCircle2 size={12} /> Valid token detected</span>
                            : <span className="form-hint danger-text">Doesn't look like valid token JSON</span>;
                        })()}
                      </div>

                      <button type="button" className="advanced-toggle" onClick={() => setShowAdvanced(a => !a)}>
                        {showAdvanced ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        Advanced options (custom OAuth credentials)
                      </button>
                      {showAdvanced && (
                        <div className="advanced-fields">
                          {(PROVIDER_FIELDS[remoteForm.type] || []).filter(f => f.advanced).map(f => renderFormField(f))}
                          <span className="form-hint">
                            Custom credentials update the authorize command above. <a href={`https://rclone.org/${remoteForm.type}/`} target="_blank" rel="noreferrer">rclone docs <ExternalLink size={11} /></a>
                          </span>
                        </div>
                      )}
                    </div>
                  ) : (
                    /* Credential provider wizard */
                    <div className="credential-wizard">
                      <div className="remote-params">
                        {(PROVIDER_FIELDS[remoteForm.type] || []).filter(f => !f.advanced).map(f => renderFormField(f))}
                      </div>

                      {(PROVIDER_FIELDS[remoteForm.type] || []).filter(f => f.advanced).length > 0 && (
                        <>
                          <button type="button" className="advanced-toggle" onClick={() => setShowAdvanced(a => !a)}>
                            {showAdvanced ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            Advanced options
                          </button>
                          {showAdvanced && (
                            <div className="advanced-fields">
                              {(PROVIDER_FIELDS[remoteForm.type] || []).filter(f => f.advanced).map(f => renderFormField(f))}
                            </div>
                          )}
                        </>
                      )}

                      {!PROVIDER_FIELDS[remoteForm.type] && (
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
                  )}
                </div>
                <div className="modal-footer">
                  <button type="button" className="btn btn-secondary" onClick={() => setWizardStep(1)}>← Back</button>
                  <button type="submit" className="btn btn-primary">Create Remote</button>
                </div>
              </form>

            ) : (
              /* ---- CREATE STEP 3: Success ---- */
              <div>
                <div className="modal-body">
                  <div className="wizard-success">
                    <CheckCircle2 size={32} className="success-icon" />
                    <h3>Remote &ldquo;{remoteForm.name}&rdquo; created</h3>
                    {autoTesting ? (
                      <div className="test-progress">
                        <Loader2 size={16} className="spin" /> Testing connection...
                      </div>
                    ) : createTestResult ? (
                      createTestResult.reachable ? (
                        <div className="test-result success">
                          <CheckCircle2 size={14} /> Connected
                          {createTestResult.total ? ` — ${formatBytes(createTestResult.used || 0)} / ${formatBytes(createTestResult.total)}` : ''}
                        </div>
                      ) : (
                        <div className="test-result failure">
                          <XCircle size={14} /> Connection test failed
                          <span className="form-hint">You can reconfigure and test again from the Remotes section.</span>
                        </div>
                      )
                    ) : null}
                  </div>
                </div>
                <div className="modal-footer">
                  <button type="button" className="btn btn-secondary" onClick={() => setShowRemoteForm(false)}>Done</button>
                  <button type="button" className="btn btn-primary" onClick={() => {
                    setShowRemoteForm(false);
                    setForm({ ...defaultForm(), remote_name: remoteForm.name });
                    setNameManual(false);
                    setShowForm(true);
                  }}>Create Sync Job →</button>
                </div>
              </div>
            )}
        </DialogSurface>
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
                  <StatusBadge status={getProgressForConfig(j.id) ? 'active' : j.enabled ? 'enabled' : 'disabled'} />
                  {j.bisync_resync_needed ? <StatusBadge status="queued" label="Resync pending" /> : null}
                </div>
                <div className="config-actions">
                  {auth.isAdmin && <button className="btn btn-primary btn-sm" onClick={() => handleTrigger(j.id)} disabled={!!getProgressForConfig(j.id)}><Play size={14} /> Run</button>}
                  {auth.isAdmin && <button className="btn btn-secondary btn-sm" onClick={() => startEdit(j)}><Pencil size={14} /> Edit</button>}
                  {auth.isAdmin && <button className="btn btn-ghost btn-sm" onClick={() => handleDelete(j.id)} title="Delete job" aria-label={`Delete ${j.name}`}><Trash2 size={14} aria-hidden="true" /></button>}
                </div>
              </div>
              <div className="config-details">
                <div className="config-detail"><span className="detail-label">Local Path</span><code>{j.local_path}</code></div>
                <div className="config-detail"><span className="detail-label">Remote</span><code>{j.remote_name}:{j.remote_path}</code></div>
                <div className="config-detail"><span className="detail-label">Schedule</span><span>{describeCron(j.cron_expression)}</span></div>
              </div>
              <BackupHealth health={j.health} settings={settings} onOpenRun={viewRun} />
              <JobProgress progress={getProgressForConfig(j.id)} feature="rclone" onCancel={auth.isAdmin ? () => { const rid = getRunIdForConfig(j.id); if (rid) cancelRcloneSync(rid).then(() => loadAll()); } : null} />
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
        <DialogSurface ariaLabel={editId ? 'Edit Cloud Backup job' : 'New Cloud Backup job'} onClose={() => setShowForm(false)}>
            <div className="modal-header">
              <h2>{editId ? 'Edit Job' : 'New Cloud Backup Job'}</h2>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowForm(false)} title="Close" aria-label="Close job form">✕</button>
            </div>
            <form onSubmit={handleSubmit} aria-describedby={formError ? 'rclone-form-error' : undefined}>
              <div className="modal-body">
                {formError && <div id="rclone-form-error" className="alert alert-error" role="alert">{formError}</div>}
                <div className="form-group">
                  <label>Job Name</label>
                  <input value={form.name} onChange={e => { setForm({ ...form, name: e.target.value }); setNameManual(true); }} required placeholder="e.g. Nextcloud → Proton Drive" />
                </div>

                <div className="form-group">
                  <label>Local Path</label>
                  <PathPicker value={form.local_path} onChange={v => {
                    const update = { ...form, local_path: v };
                    if (!editId && !nameManual) update.name = suggestName(v, form.remote_name);
                    setForm(update);
                  }} placeholder="/mnt/user/Documents/YourShare/files" />
                </div>

                <div className="form-group">
                  <label>Remote</label>
                  <select value={form.remote_name} onChange={e => {
                    const update = { ...form, remote_name: e.target.value };
                    if (!editId && !nameManual) update.name = suggestName(form.local_path, e.target.value);
                    setForm(update);
                  }} required>
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

                <NotificationPolicyField form={form} onChange={patch => setForm(current => ({ ...current, ...patch }))} />
              </div>
              <div className="modal-footer">
                <div className="toggle-group">
                  <div className={`toggle ${form.enabled ? 'active' : ''}`} onClick={() => setForm({ ...form, enabled: !form.enabled })} />
                  <span>Enabled</span>
                </div>
                <div className="modal-footer-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => setShowForm(false)}>Cancel</button>
                  <button type="submit" className="btn btn-primary" disabled={submitting}>{submitting ? 'Saving...' : editId ? 'Save Changes' : 'Create Job'}</button>
                </div>
              </div>
            </form>
        </DialogSurface>
      )}

      {/* Run history */}
      {deleteTarget && (
        <ConfirmDialog title="Delete Cloud Backup job" confirmLabel="Delete job" destructive busy={deleting} error={deleteError} onClose={() => setDeleteTarget(null)} onConfirm={confirmDelete}>
          <p>Delete <strong>{deleteTarget.name}</strong>?</p>
          <p className="form-hint">This removes the schedule and job configuration. Local and remote data are not deleted.</p>
        </ConfirmDialog>
      )}

      {remoteDeleteTarget && (
        <ConfirmDialog title="Delete Rclone remote" confirmLabel="Delete remote" destructive busy={deleting} error={remoteActionError} onClose={() => setRemoteDeleteTarget(null)} onConfirm={confirmDeleteRemote}>
          <p>Delete <strong>{remoteDeleteTarget}</strong>?</p>
          <p className="form-hint">Cloud data is not deleted, but every backup job using this remote will stop working until reconfigured.</p>
        </ConfirmDialog>
      )}

      {/* Run history */}
      <div className="runs-section">
        <div className="runs-header">
          <h2><ClipboardList size={18} /> Run History</h2>
          <div style={{ display: 'flex', gap: 'var(--space-sm)', alignItems: 'center' }}>
            <select className="form-select" value={runJobFilter} onChange={e => { setRunJobFilter(e.target.value); }} style={{ minWidth: 140, fontSize: '0.85rem' }}>
              <option value="">All jobs</option>
              {jobs.map(j => <option key={j.id} value={j.id}>{j.name}</option>)}
            </select>
            <button className="btn btn-secondary btn-sm" onClick={() => loadRuns(1)}>Refresh</button>
          </div>
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
                      <td className="mono-cell">{r.started_at ? formatDateTime(r.started_at, settings) : '—'}</td>
                      <td>{formatDuration(r.duration_seconds)}</td>
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
        <DialogSurface ariaLabel={`Cloud Backup run ${selectedRun.id}`} style={{ maxWidth: '800px' }} onClose={() => setSelectedRun(null)}>
            <div className="modal-header">
              <h2>Run #{selectedRun.id}</h2>
              <button className="btn btn-ghost btn-sm" onClick={() => setSelectedRun(null)} title="Close" aria-label="Close run details">✕</button>
            </div>
            <div className="modal-body">
              <div className="run-summary">
                <div className="run-stat"><span className="run-stat-label">Status</span><StatusBadge status={selectedRun.status} /></div>
                <div className="run-stat"><span className="run-stat-label">Duration</span><span>{formatDuration(selectedRun.duration_seconds)}</span></div>
                <div className="run-stat"><span className="run-stat-label">Files</span><span>{selectedRun.files_copied || 0}</span></div>
                <div className="run-stat"><span className="run-stat-label">Failed</span><span className={selectedRun.files_failed ? 'danger-text' : ''}>{selectedRun.files_failed || 0}</span></div>
                <div className="run-stat"><span className="run-stat-label">Transferred</span><span>{formatBytes(selectedRun.bytes_transferred || 0)}</span></div>
              </div>
              {selectedRun.status === 'failed' && !selectedRun.diagnosis?.groups?.length && (
                <div className="alert alert-error" style={{ marginTop: 'var(--space-md)', whiteSpace: 'pre-wrap' }}>
                  {selectedRun.error_message || 'Sync failed — no error details were recorded for this run.'}
                </div>
              )}
              {selectedRun.diagnosis?.groups?.length > 0 && (
                <div className="run-diagnosis">
                  {selectedRun.diagnosis.groups.map(group => (
                    <div key={group.code} className="run-diagnosis-group">
                      <h4>{group.count} × {group.title}</h4>
                      <p>{group.explain}</p>
                      <p className="run-diagnosis-remedy">{group.remedy}</p>
                      {group.examples?.length > 0 && (
                        <ul className="run-diagnosis-examples">
                          {group.examples.map((example, i) => <li key={i} className="mono-cell">{example}</li>)}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {selectedRun.files?.length > 0 && (
                <div className="run-files">
                  <h3>Files ({selectedRun.totalFiles ?? selectedRun.files.length}{selectedRun.totalFiles > selectedRun.files.length ? `, showing ${selectedRun.files.length}` : ''})</h3>
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
        </DialogSurface>
      )}
    </div>
  );
}

function formatDuration(seconds) {
  if (!seconds) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
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

const OAUTH_PROVIDERS = new Set(['drive', 'onedrive', 'dropbox', 'box', 'pcloud']);

const PROVIDER_FIELDS = {
  drive: [
    { key: 'token', label: 'OAuth Token', sensitive: true, oauth: true },
    { key: 'client_id', label: 'Client ID', placeholder: 'Leave empty to use rclone defaults', sensitive: false, advanced: true },
    { key: 'client_secret', label: 'Client Secret', placeholder: 'Leave empty to use rclone defaults', sensitive: true, advanced: true },
    { key: 'root_folder_id', label: 'Root Folder ID', placeholder: 'Leave empty for root', sensitive: false, advanced: true },
  ],
  onedrive: [
    { key: 'token', label: 'OAuth Token', sensitive: true, oauth: true },
    { key: 'client_id', label: 'Client ID', placeholder: 'Leave empty to use rclone defaults', sensitive: false, advanced: true },
    { key: 'client_secret', label: 'Client Secret', placeholder: 'Leave empty to use rclone defaults', sensitive: true, advanced: true },
    { key: 'drive_id', label: 'Drive ID', placeholder: 'Discovered automatically from the OAuth token', sensitive: false, advanced: true },
    { key: 'drive_type', label: 'Drive Type', placeholder: 'personal / business / documentLibrary', sensitive: false, advanced: true },
  ],
  protondrive: [
    { key: 'username', label: 'Username', placeholder: 'your@proton.me', sensitive: false, required: true },
    { key: 'password', label: 'Password', placeholder: 'Proton account password', sensitive: true, required: true },
    { key: '2fa', label: '2FA Code', placeholder: 'Leave empty if not set', sensitive: false, advanced: true },
  ],
  s3: [
    { key: 'provider', label: 'Provider', placeholder: 'AWS / Minio / Wasabi / Other', sensitive: false },
    { key: 'access_key_id', label: 'Access Key', placeholder: 'AWS access key', sensitive: false, required: true },
    { key: 'secret_access_key', label: 'Secret Key', placeholder: 'AWS secret key', sensitive: true, required: true },
    { key: 'region', label: 'Region', placeholder: 'us-east-1', sensitive: false, advanced: true },
    { key: 'endpoint', label: 'Endpoint', placeholder: 'Leave empty for AWS', sensitive: false, advanced: true },
  ],
  b2: [
    { key: 'account', label: 'Account ID', placeholder: 'B2 Application Key ID', sensitive: false, required: true },
    { key: 'key', label: 'Application Key', placeholder: 'B2 Application Key', sensitive: true, required: true },
  ],
  dropbox: [
    { key: 'token', label: 'OAuth Token', sensitive: true, oauth: true },
    { key: 'client_id', label: 'Client ID', placeholder: 'Leave empty to use rclone defaults', sensitive: false, advanced: true },
    { key: 'client_secret', label: 'Client Secret', placeholder: 'Leave empty to use rclone defaults', sensitive: true, advanced: true },
  ],
  sftp: [
    { key: 'host', label: 'Host', placeholder: 'hostname or IP', sensitive: false, required: true },
    { key: 'user', label: 'Username', placeholder: 'root', sensitive: false, required: true },
    { key: 'port', label: 'Port', placeholder: '22', sensitive: false, advanced: true },
    { key: 'pass', label: 'Password', placeholder: 'Leave empty for key-based auth', sensitive: true, advanced: true },
    { key: 'key_file', label: 'Key File Path', placeholder: '/root/.ssh/id_rsa', sensitive: false, advanced: true },
  ],
  webdav: [
    { key: 'url', label: 'URL', placeholder: 'https://cloud.example.com/remote.php/webdav', sensitive: false, required: true },
    { key: 'user', label: 'Username', placeholder: 'admin', sensitive: false },
    { key: 'pass', label: 'Password', placeholder: 'App password', sensitive: true },
    { key: 'vendor', label: 'Vendor', placeholder: 'nextcloud / owncloud / sharepoint / other', sensitive: false, advanced: true },
  ],
  ftp: [
    { key: 'host', label: 'Host', placeholder: 'ftp.example.com', sensitive: false, required: true },
    { key: 'user', label: 'Username', placeholder: 'anonymous', sensitive: false },
    { key: 'pass', label: 'Password', placeholder: 'FTP password', sensitive: true },
    { key: 'port', label: 'Port', placeholder: '21', sensitive: false, advanced: true },
  ],
  mega: [
    { key: 'user', label: 'Username', placeholder: 'your@email.com', sensitive: false, required: true },
    { key: 'pass', label: 'Password', placeholder: 'MEGA password', sensitive: true, required: true },
  ],
  box: [
    { key: 'token', label: 'OAuth Token', sensitive: true, oauth: true },
    { key: 'client_id', label: 'Client ID', placeholder: 'Leave empty to use rclone defaults', sensitive: false, advanced: true },
    { key: 'client_secret', label: 'Client Secret', placeholder: 'Leave empty to use rclone defaults', sensitive: true, advanced: true },
  ],
  pcloud: [
    { key: 'token', label: 'OAuth Token', sensitive: true, oauth: true },
    { key: 'client_id', label: 'Client ID', placeholder: 'Leave empty to use rclone defaults', sensitive: false, advanced: true },
    { key: 'client_secret', label: 'Client Secret', placeholder: 'Leave empty to use rclone defaults', sensitive: true, advanced: true },
  ],
  local: [
    { key: 'nounc', label: 'Disable UNC paths', placeholder: 'true', sensitive: false, advanced: true, hint: 'Usually not needed on Linux' },
  ],
};

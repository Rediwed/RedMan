import { useState, useEffect, useCallback, useRef } from 'react';
import {
  getHyperJobs, createHyperJob, updateHyperJob, deleteHyperJob,
  triggerHyperBackup, cancelHyperBackup, getHyperRuns, getHyperRunDetail, getHyperRunProgress,
  getSshStatus, generateSshKey,
  discoverPeers, initiatePairing, getPairingStatus, getPeers,
} from '../api/index.js';
import { RefreshCw, Play, Pencil, Trash2, ClipboardList, CheckCircle2, XCircle, AlertTriangle, Radar, Loader, ShieldCheck, ShieldAlert, X } from 'lucide-react';
import StatusBadge from '../components/StatusBadge.jsx';
import PathPicker from '../components/PathPicker.jsx';
import RemotePathPicker from '../components/RemotePathPicker.jsx';
import JobProgress from '../components/JobProgress.jsx';
import SchedulePicker, { describeCron } from '../components/SchedulePicker.jsx';
import useJobProgress from '../hooks/useJobProgress.js';
import useReconnect from '../hooks/useReconnect.js';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import Dialog, { DialogSurface } from '../components/Dialog.jsx';
import BackupHealth from '../components/BackupHealth.jsx';
import NotificationPolicyField from '../components/NotificationPolicyField.jsx';
import { useSettings } from '../contexts/SettingsContext.jsx';
import { formatDateTime } from '../utils/dateFormat.js';
import { formatBytes } from '../utils/formatBytes.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import './HyperBackupPage.css';

export default function HyperBackupPage() {
  const auth = useAuth();
  const { settings } = useSettings();
  const [jobs, setJobs] = useState([]);
  const [runs, setRuns] = useState({ runs: [], page: 1, totalPages: 0 });
  const [selectedRun, setSelectedRun] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(defaultForm());
  const [loading, setLoading] = useState(true);
  const [manualDestination, setManualDestination] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [formError, setFormError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteError, setDeleteError] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [destinations, setDestinations] = useState([]);
  const [ssh, setSsh] = useState({ keyExists: false, publicKey: null });
  const [showPeerPicker, setShowPeerPicker] = useState(false);
  const [discoveredPeers, setDiscoveredPeers] = useState([]);
  const [discovering, setDiscovering] = useState(false);
  const [discoveryError, setDiscoveryError] = useState(null);
  const [discoveryDismissed, setDiscoveryDismissed] = useState(false);
  const [pairing, setPairing] = useState(null);
  const [pairingPeer, setPairingPeer] = useState(null);
  const pairingCancelled = useRef(false);
  const pairingAttempt = useRef(0);

  const { trackRun, detectRunning, getProgressForConfig, getRunIdForConfig } = useJobProgress(getHyperRunProgress, () => loadAll());

  function defaultForm() {
    return {
      name: '', direction: 'push',
      remote_url: '', remote_api_key: '',
      local_path: '', remote_path: '',
      remote_path_manual: false,
      ssh_user: 'redman-backup', ssh_host: '', ssh_port: 22,
      cron_expression: '0 2 * * *',
      enabled: true, notify_mode: 'global', notify_on_start: true, notify_on_success: true, notify_on_failure: true,
    };
  }

  useEffect(() => {
    loadAll();
    if (auth.isAdmin) scanForPeers();
  }, [auth.isAdmin]);
  useReconnect(useCallback(() => loadAll(), []));

  async function loadAll(silent = false) {
    if (!silent) setLoading(true);
    setLoadError(null);
    try {
      const [j, r, s, p] = auth.isAdmin
        ? await Promise.all([getHyperJobs(), getHyperRuns(1), getSshStatus(), getPeers()])
        : [...await Promise.all([getHyperJobs(), getHyperRuns(1)]), null, null];
      setJobs(j);
      setRuns(r);
      if (s) setSsh(s);
      if (p) setDestinations(p.outgoing || []);
      detectRunning(r.runs);
    } catch (err) {
      setLoadError(err.message);
    }
    if (!silent) setLoading(false);
  }

  async function loadRuns(page = 1) {
    try {
      setLoadError(null);
      const r = await getHyperRuns(page);
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
        await updateHyperJob(editId, data);
      } else {
        await createHyperJob(data);
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
      name: job.name, direction: job.direction,
      remote_url: job.remote_url, remote_api_key: '',
      local_path: job.local_path, remote_path: job.remote_path,
      remote_path_manual: true,
      ssh_user: job.ssh_user || 'redman-backup', ssh_host: job.ssh_host || '',
      ssh_port: job.ssh_port || 22, cron_expression: job.cron_expression,
      enabled: !!job.enabled,
      notify_mode: job.notify_mode || 'global',
      notify_on_start: job.notify_on_start !== undefined ? !!job.notify_on_start : true,
      notify_on_success: !!job.notify_on_success,
      notify_on_failure: !!job.notify_on_failure,
    });
    setEditId(job.id);
    setManualDestination(!destinations.some(destination => destination.remote_url === job.remote_url));
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
      await deleteHyperJob(deleteTarget.id);
      setDeleteTarget(null);
      loadAll();
    } catch (err) {
      setDeleteError(err.message);
    } finally {
      setDeleting(false);
    }
  }

  async function handleTrigger(id) {
    const result = await triggerHyperBackup(id);
    if (result.runId) trackRun(result.runId, id);
  }

  // Filter out already-paired peers from discovered list
  function filterPaired(peers) {
    const pairedUrls = new Set(destinations.map(d => d.remote_url));
    return peers.filter(p => !pairedUrls.has(p.url));
  }

  // Background scan — runs on page load, populates the discovery banner
  async function scanForPeers() {
    try {
      const result = await discoverPeers(false);
      if (!result.error && result.length > 0) {
        setDiscoveredPeers(result);
      }
    } catch { /* silent */ }
  }

  // Manual scan — triggered by Discover button (in form or banner)
  async function handleDiscoverPeers() {
    setDiscovering(true);
    setDiscoveryError(null);
    setDiscoveredPeers([]);
    try {
      const result = await discoverPeers(true);
      if (result.error) {
        setDiscoveryError(result.message);
      } else {
        setDiscoveredPeers(result);
        if (filterPaired(result).length === 0 && result.length > 0) {
          setDiscoveryError('All discovered instances are already paired.');
        } else if (result.length === 0) {
          setDiscoveryError('No other RedMan instances found on your network.');
        }
      }
    } catch (err) {
      setDiscoveryError(err.message);
    }
    setDiscovering(false);
  }

  function selectDiscoveredPeer(peer) {
    setShowPeerPicker(false);
    setDiscoveryDismissed(true);
    setPairingPeer(peer);
    startPairing(peer);
  }

  async function startPairing(peer) {
    const attempt = ++pairingAttempt.current;
    setPairing({ status: 'sending' });
    pairingCancelled.current = false;
    try {
      const result = await initiatePairing(peer.url);
      if (pairingAttempt.current !== attempt) return;
      if (result.status === 'failed') {
        setPairing({ status: 'failed', error: result.error });
        return;
      }
      setPairing({ id: result.id, status: 'pending', remote_instance: result.remote_instance || peer.instance, local_fingerprint: result.local_fingerprint });
      // Start polling for acceptance
      pollPairingStatus(result.id, peer, result.local_fingerprint, attempt);
    } catch (err) {
      if (pairingAttempt.current === attempt) {
        setPairing({ status: 'failed', error: err.message });
      }
    }
  }

  async function pollPairingStatus(id, peer, localFingerprint, attempt) {
    for (let i = 0; i < 120; i++) {
      if (pairingCancelled.current || pairingAttempt.current !== attempt) return;
      await new Promise(resolve => { setTimeout(resolve, 3000); });
      if (pairingCancelled.current || pairingAttempt.current !== attempt) return;
      try {
        const status = await getPairingStatus(id);
        if (pairingCancelled.current || pairingAttempt.current !== attempt) return;
        if (status.status === 'accepted') {
          pairingCancelled.current = true;
          setPairing({ status: 'accepted', remote_instance: peer.instance, local_fingerprint: localFingerprint });
          setShowPeerPicker(false);
          loadAll(true).catch(() => {});
          return;
        }
        if (['failed', 'expired', 'declined'].includes(status.status)) {
          setPairing({ ...status });
          return;
        }
      } catch { /* keep polling */ }
    }
    if (pairingAttempt.current === attempt) {
      setPairing({ status: 'expired', error: 'Timed out waiting for acceptance' });
    }
  }

  function cancelPairing() {
    pairingCancelled.current = true;
    pairingAttempt.current++;
    setPairing(null);
    setPairingPeer(null);
  }

  // Auto-generate SSH key silently if missing (rsync needs it)
  const [nameManual, setNameManual] = useState(false);

  function suggestName(localPath, remoteUrl) {
    const seg = p => p?.replace(/\/+$/, '').split('/').pop() || '';
    const local = seg(localPath);
    const dest = destinations.find(d => d.remote_url === remoteUrl);
    const remote = dest?.name || '';
    return local && remote ? `${local} → ${remote}` : local || '';
  }

  async function ensureSshKey() {
    if (ssh.keyExists) return;
    try {
      const result = await generateSshKey();
      if (result.success) setSsh({ keyExists: true, publicKey: result.publicKey });
    } catch (err) {
      setFormError(`Could not prepare SSH key: ${err.message}`);
    }
  }

  function handleNewJob() {
    // If we have unpaired discovered peers, show the peer picker
    const unpaired = filterPaired(discoveredPeers);
    if (unpaired.length > 0) {
      setShowPeerPicker(true);
    } else {
      // No peers found — go straight to form
      ensureSshKey();
      setEditId(null);
      setForm(defaultForm());
      setNameManual(false);
      setFormError(null);
      setManualDestination(true);
      setShowForm(true);
    }
  }

  function handleNewJobManual() {
    setShowPeerPicker(false);
    ensureSshKey();
    setEditId(null);
    setForm(defaultForm());
    setManualDestination(true);
    setNameManual(false);
    setFormError(null);
    setShowForm(true);
  }

  async function viewRun(id) {
    const detail = await getHyperRunDetail(id);
    setSelectedRun(detail);
  }

  if (loading) return <div className="empty-state"><p>Loading...</p></div>;

  return (
    <div className="hyper-page">
      <div className="page-header">
        <h1><RefreshCw size={24} /> Hyper Backup</h1>
        {auth.isAdmin && <button className="btn btn-primary" onClick={handleNewJob}>
          + New Job
        </button>}
      </div>

      {loadError && (
        <div className="alert alert-error" role="alert">
          <span>{loadError}</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => loadAll()}>Retry</button>
        </div>
      )}

      {/* Discovery banner — shows unpaired RedMan instances found on the network */}
      {auth.isAdmin && filterPaired(discoveredPeers).length > 0 && !discoveryDismissed && !showForm && (
        <div className="discovery-banner card">
          <div className="discovery-banner-header">
            <Radar size={16} />
            <span>Found {filterPaired(discoveredPeers).length} new RedMan instance{filterPaired(discoveredPeers).length > 1 ? 's' : ''} on your network</span>
            <button className="btn btn-ghost btn-sm" onClick={() => setDiscoveryDismissed(true)} title="Dismiss" aria-label="Dismiss discovered peers">✕</button>
          </div>
          <div className="discovery-banner-items">
            {filterPaired(discoveredPeers).map(p => (
              <button key={p.ip} className="discovery-banner-item" onClick={() => selectDiscoveredPeer(p)}>
                <div className="discovery-banner-name">{p.instance}</div>
                <div className="discovery-banner-detail">{p.ip} · v{p.version}</div>
                <span className="btn btn-primary btn-sm">Connect →</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Pairing status modal — shown while waiting for remote to accept */}
      {pairing && !showForm && (
        <Dialog
          title={<><Radar size={18} aria-hidden="true" /> {pairing.status === 'accepted' ? 'Paired!' : 'Pairing'}</>}
          className="pairing-dialog"
          onClose={cancelPairing}
          closeOnOverlay={pairing.status !== 'pending' && pairing.status !== 'sending'}
          footer={(
            <div className="modal-footer-actions">
              {(pairing.status === 'failed' || pairing.status === 'expired' || pairing.status === 'declined') && (
                <>
                  <button type="button" className="btn btn-ghost" onClick={cancelPairing}>Close</button>
                  {pairingPeer && <button type="button" className="btn btn-primary" onClick={() => startPairing(pairingPeer)}>Try Again</button>}
                </>
              )}
              {(pairing.status === 'sending' || pairing.status === 'pending') && <button type="button" className="btn btn-ghost" onClick={cancelPairing}>Cancel</button>}
              {pairing.status === 'accepted' && <button type="button" className="btn btn-primary" onClick={cancelPairing}>Done</button>}
            </div>
          )}
        >
            <div style={{ textAlign: 'center', padding: 'var(--space-md) 0' }}>
              {(pairing.status === 'sending' || pairing.status === 'pending') && (
                <>
                  <Loader size={40} className="spin" style={{ color: 'var(--color-primary)', marginBottom: 'var(--space-md)' }} />
                  <p style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: 'var(--space-xs)' }}>
                    Waiting for {pairingPeer?.instance || 'remote'} to accept...
                  </p>
                  <p className="form-hint">
                    Open RedMan on <strong>{pairingPeer?.instance}</strong> and accept the connection request.
                  </p>
                  {pairing.local_fingerprint && (
                    <p className="form-hint">Compare this fingerprint on the receiver: <code>{pairing.local_fingerprint}</code></p>
                  )}
                </>
              )}
              {pairing.status === 'accepted' && (
                <>
                  <CheckCircle2 size={40} style={{ color: 'var(--color-success)', marginBottom: 'var(--space-md)' }} />
                  <p style={{ fontSize: '1.1rem', fontWeight: 600 }}>
                    Connected to {pairing.remote_instance || pairingPeer?.instance || 'remote'}!
                  </p>
                  <p className="form-hint">You can now create backup jobs to this peer.</p>
                </>
              )}
              {(pairing.status === 'failed' || pairing.status === 'expired' || pairing.status === 'declined') && (
                <>
                  <XCircle size={40} style={{ color: 'var(--color-danger)', marginBottom: 'var(--space-md)' }} />
                  <p style={{ fontSize: '1.1rem', fontWeight: 600 }}>
                    {pairing.status === 'declined' ? 'Request declined' : pairing.status === 'expired' ? 'Request expired' : 'Pairing failed'}
                  </p>
                  {pairing.error && (
                    <p className="form-hint" style={{
                      marginTop: 'var(--space-sm)',
                      fontFamily: 'monospace',
                      fontSize: '0.8rem',
                      color: 'var(--color-text-muted)',
                      userSelect: 'text',
                      wordBreak: 'break-word',
                    }}>{pairing.error}</p>
                  )}
                </>
              )}
            </div>
        </Dialog>
      )}

      {/* Peer picker modal — shown when clicking "+ New Job" */}
      {showPeerPicker && (
        <Dialog
          title={<><Radar size={18} aria-hidden="true" /> Select a Peer</>}
          className="peer-picker-dialog"
          onClose={() => setShowPeerPicker(false)}
          footer={(
            <div className="modal-footer-actions">
              <button type="button" className="btn btn-ghost" onClick={handleNewJobManual}>Enter URL manually</button>
              {discoveredPeers.length > 0 && <button type="button" className="btn btn-secondary btn-sm" onClick={handleDiscoverPeers} disabled={discovering}>{discovering ? 'Scanning...' : 'Rescan'}</button>}
            </div>
          )}
        >
              {filterPaired(discoveredPeers).length > 0 ? (
                <>
                  <p className="form-hint" style={{ marginBottom: 'var(--space-md)' }}>
                    These RedMan instances were found on your network. Select one to set up a backup job.
                  </p>
                  <div className="discovery-banner-items">
                    {filterPaired(discoveredPeers).map(p => (
                      <button key={p.ip} className="discovery-banner-item" onClick={() => selectDiscoveredPeer(p)}>
                        <div className="discovery-banner-name">{p.instance}</div>
                        <div className="discovery-banner-detail">{p.ip} · v{p.version}</div>
                        <span className="btn btn-primary btn-sm">Connect →</span>
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <div className="empty-state" style={{ padding: 'var(--space-lg)' }}>
                  <Radar size={32} style={{ opacity: 0.3 }} />
                  <p>No other RedMan instances found on your network.</p>
                  <button className="btn btn-secondary btn-sm" onClick={handleDiscoverPeers} disabled={discovering} style={{ marginTop: 'var(--space-sm)' }}>
                    {discovering ? <><Radar size={14} className="spin" /> Scanning...</> : <><Radar size={14} /> Scan Again</>}
                  </button>
                </div>
              )}
        </Dialog>
      )}

      {/* Job list */}
      {jobs.length > 0 ? (
        <div className="config-list">
          {jobs.map(j => (
            <div key={j.id} className="card config-card">
              <div className="config-card-header">
                <div>
                  <span className="config-name">{j.name}</span>
                  <StatusBadge status={getProgressForConfig(j.id) ? 'active' : j.enabled ? 'enabled' : 'disabled'} />
                </div>
                <div className="config-actions">
                  {auth.isAdmin && <button className="btn btn-primary btn-sm" onClick={() => { ensureSshKey(); handleTrigger(j.id); }} disabled={!!getProgressForConfig(j.id)}><Play size={14} /> Run</button>}
                  {auth.isAdmin && <button className="btn btn-secondary btn-sm" onClick={() => startEdit(j)}><Pencil size={14} /> Edit</button>}
                  {auth.isAdmin && <button className="btn btn-ghost btn-sm" onClick={() => handleDelete(j.id)} title="Delete job" aria-label={`Delete ${j.name}`}><Trash2 size={14} aria-hidden="true" /></button>}
                </div>
              </div>
              <div className="config-details">
                <div className="config-detail"><span className="detail-label">Local Path</span><code>{j.local_path}</code></div>
                <div className="config-detail"><span className="detail-label">Remote Path</span><code>{j.remote_path}</code></div>
                <div className="config-detail"><span className="detail-label">Remote Instance</span>
                  <code>{destinations.find(d => d.remote_url === j.remote_url)?.name || j.remote_url}
                    {' '}{(() => { const d = destinations.find(d => d.remote_url === j.remote_url); return d?.handshake_version >= 2
                      ? <ShieldCheck size={12} style={{ color: 'var(--color-success)', verticalAlign: 'middle' }} title="Secure — Noise XX handshake" />
                      : <ShieldAlert size={12} style={{ color: 'var(--color-warning)', verticalAlign: 'middle' }} title="Legacy pairing — re-pair to upgrade" />;
                    })()}
                  </code>
                </div>
                <div className="config-detail"><span className="detail-label">Schedule</span><span>{describeCron(j.cron_expression)}</span></div>
              </div>
              <BackupHealth health={j.health} settings={settings} onOpenRun={viewRun} />
              <JobProgress progress={getProgressForConfig(j.id)} feature="hyper-backup" onCancel={auth.isAdmin ? () => { const rid = getRunIdForConfig(j.id); if (rid) cancelHyperBackup(rid).then(() => loadAll()); } : null} />
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
        <DialogSurface ariaLabel={editId ? 'Edit Hyper Backup job' : 'New Hyper Backup job'} onClose={() => setShowForm(false)}>
            <div className="modal-header">
              <h2>{editId ? 'Edit Job' : 'New Hyper Backup Job'}</h2>
              <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="Close" onClick={() => setShowForm(false)}><X size={16} /></button>
            </div>
            <form onSubmit={handleSubmit} aria-describedby={formError ? 'hyper-form-error' : undefined}>
              <div className="modal-body">
                {formError && <div id="hyper-form-error" className="alert alert-error" role="alert">{formError}</div>}
                {/* Peer selection — prominent at top */}
                <div className="form-group">
                  <label>Destination</label>
                  {!manualDestination && destinations.length > 0 ? (
                    <select
                      value={form.remote_url}
                      onChange={e => {
                        const dest = destinations.find(d => d.remote_url === e.target.value);
                        setForm(f => {
                          const update = {
                            ...f,
                            remote_url: e.target.value,
                          };
                          if (!editId && !nameManual) update.name = suggestName(f.local_path, e.target.value);
                          return update;
                        });
                        setManualDestination(false);
                      }}
                      required
                    >
                      <option value="">Select a paired peer...</option>
                      {destinations.map(d => (
                        <option key={d.id} value={d.remote_url}>{d.name} ({d.remote_url})</option>
                      ))}
                    </select>
                  ) : (
                    <>
                      <input
                        type="url"
                        value={form.remote_url}
                        onChange={event => setForm({ ...form, remote_url: event.target.value })}
                        placeholder="http://192.168.1.20:8091"
                        required
                      />
                      <span className="form-hint">Private RedMan peer API URL, including port.</span>
                      <label style={{ marginTop: 'var(--space-sm)' }}>Remote API key</label>
                      <input
                        type="password"
                        value={form.remote_api_key}
                        onChange={event => setForm({ ...form, remote_api_key: event.target.value })}
                        placeholder={editId ? 'Leave blank to keep the stored key' : 'Peer API key'}
                        required={!editId}
                        autoComplete="new-password"
                      />
                    </>
                  )}
                  {destinations.length > 0 && (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => {
                      setManualDestination(value => !value);
                      setForm(current => ({ ...current, remote_url: '', remote_api_key: '' }));
                    }}>
                      {manualDestination ? 'Choose paired peer' : 'Enter URL manually'}
                    </button>
                  )}
                </div>

                <div className="form-group">
                  <label>Direction</label>
                  <div className="segmented" role="group" aria-label="Backup direction">
                    <button type="button" className={`segmented-option ${form.direction === 'push' ? 'active' : ''}`} onClick={() => setForm({ ...form, direction: 'push' })}>Send to peer</button>
                    <button type="button" className={`segmented-option ${form.direction === 'pull' ? 'active' : ''}`} onClick={() => setForm({ ...form, direction: 'pull' })}>Receive from peer</button>
                  </div>
                </div>

                <div className="form-group">
                  <label>Job Name</label>
                  <input value={form.name} onChange={e => { setForm({ ...form, name: e.target.value }); setNameManual(true); }} required placeholder="e.g. Documents → Dad's NAS" />
                </div>

                <div className="form-group">
                  <label>Local Path {settings.instance_name && <span className="label-instance">({settings.instance_name})</span>}</label>
                  <PathPicker value={form.local_path} onChange={v => {
                    const update = { ...form, local_path: v };
                    // Auto-suggest remote path: append source folder name to current remote path
                    if (v && !form.remote_path_manual) {
                      const folderName = v.replace(/\/+$/, '').split('/').pop();
                      const base = (form.remote_path || '/mnt/user/cross-site').replace(/\/+$/, '');
                      if (folderName) {
                        const suffix = '/' + folderName;
                        update.remote_path = base + suffix;
                      }
                    }
                    if (!editId && !nameManual) update.name = suggestName(v, form.remote_url);
                    setForm(update);
                  }} placeholder="/mnt/user/Documents" />
                </div>

                <div className="form-group">
                  <label>Remote Path {(() => { const d = destinations.find(d => d.remote_url === form.remote_url); return d?.name ? <span className="label-instance">({d.name})</span> : null; })()}</label>
                  {manualDestination ? (
                    <input
                      value={form.remote_path}
                      onChange={event => setForm({ ...form, remote_path: event.target.value, remote_path_manual: true })}
                      placeholder="/mnt/user/Backups/Documents"
                      required
                    />
                  ) : (
                    <RemotePathPicker
                      value={form.remote_path}
                      onChange={v => setForm({ ...form, remote_path: v, remote_path_manual: true })}
                      onBrowse={v => setForm({ ...form, remote_path: v })}
                      placeholder="/mnt/user/Backups/Documents"
                      remoteUrl={form.remote_url}
                    />
                  )}
                  <span className="form-hint">Path on the remote system — you can type a path that doesn't exist yet</span>
                </div>

                {manualDestination && (
                  <div className="form-subsection">
                    <label className="subsection-label">SSH connection</label>
                    <div className="form-row">
                      <div className="form-group">
                        <label>User</label>
                        <input value={form.ssh_user} onChange={event => setForm({ ...form, ssh_user: event.target.value })} pattern="[A-Za-z0-9._-]+" required />
                      </div>
                      <div className="form-group">
                        <label>Host override</label>
                        <input value={form.ssh_host} onChange={event => setForm({ ...form, ssh_host: event.target.value })} pattern="[A-Za-z0-9._-]*" placeholder="Defaults to API host" />
                      </div>
                      <div className="form-group">
                        <label>Port</label>
                        <input type="number" min="1" max="65535" value={form.ssh_port} onChange={event => setForm({ ...form, ssh_port: Number(event.target.value) })} required />
                      </div>
                    </div>
                  </div>
                )}

                <div className="form-group">
                  <label>Schedule</label>
                  <SchedulePicker value={form.cron_expression} onChange={v => setForm({ ...form, cron_expression: v })} />
                </div>

                <NotificationPolicyField
                  form={form}
                  variant="segmented"
                  onChange={patch => setForm(current => ({ ...current, ...patch }))}
                />

                <div className="form-group form-row-toggle">
                  <div>
                    <label style={{ marginBottom: 2 }}>Enabled</label>
                    <span className="form-hint">Job will run on schedule. Disable to pause without deleting.</span>
                  </div>
                  <div className="toggle-group" onClick={() => setForm({ ...form, enabled: !form.enabled })}>
                    <div className={`toggle ${form.enabled ? 'active' : ''}`} />
                  </div>
                </div>
              </div>
              <div className="modal-footer">
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
        <ConfirmDialog title="Delete Hyper Backup job" confirmLabel="Delete job" destructive busy={deleting} error={deleteError} onClose={() => setDeleteTarget(null)} onConfirm={confirmDelete}>
          <p>Delete <strong>{deleteTarget.name}</strong>?</p>
          <p className="form-hint">This removes the schedule and RedMan configuration. Data already stored on either peer is not deleted.</p>
        </ConfirmDialog>
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
                      <td className="mono-cell">{r.started_at ? formatDateTime(r.started_at, settings) : '—'}</td>
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
        <DialogSurface ariaLabel={`Hyper Backup run ${selectedRun.id}`} style={{ maxWidth: '800px' }} onClose={() => setSelectedRun(null)}>
            <div className="modal-header">
              <h2>Run #{selectedRun.id}</h2>
              <button className="btn btn-ghost btn-sm" onClick={() => setSelectedRun(null)} title="Close" aria-label="Close run details">✕</button>
            </div>
            <div className="modal-body">
              <div className="run-summary">
                <div className="run-stat"><span className="run-stat-label">Status</span><StatusBadge status={selectedRun.status} /></div>
                <div className="run-stat"><span className="run-stat-label">Duration</span><span>{selectedRun.duration_seconds ? `${Math.round(selectedRun.duration_seconds)}s` : '—'}</span></div>
                <div className="run-stat"><span className="run-stat-label">Files</span><span>{selectedRun.files_copied || 0}</span></div>
                <div className="run-stat"><span className="run-stat-label">Transferred</span><span>{formatBytes(selectedRun.bytes_transferred || 0)}</span></div>
              </div>
              {selectedRun.status === 'failed' && (
                <div className="alert alert-error" style={{ marginTop: 'var(--space-md)', whiteSpace: 'pre-wrap' }}>
                  {selectedRun.error_message || 'Backup failed — no error details were recorded for this run.'}
                </div>
              )}
              {selectedRun.files?.length > 0 && (
                <div className="run-files">
                  <h3>Files ({selectedRun.totalFiles ?? selectedRun.files.length}{selectedRun.totalFiles > selectedRun.files.length ? `, showing ${selectedRun.files.length}` : ''})</h3>
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
        </DialogSurface>
      )}
    </div>
  );
}

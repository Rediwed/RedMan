import { useState, useEffect, useCallback, useMemo } from 'react';
import { getSettings, saveSettings, testNtfy, testBrowserNotify, testImmichConnection, getPeers, getPeerConnectivity, createPeer, updatePeer, deletePeer, regeneratePeerKey, getPeerAuditLog, discoverImmich, discoverPeers, getDiscoverySubnets, getPairingIncoming, acceptPairing as apiAcceptPairing, declinePairing as apiDeclinePairing, deletePairing as apiDeletePairing, syncPairings, getAllFilesystemRoots, getSsdShares } from '../api/index.js';
import useReconnect from '../hooks/useReconnect.js';
import { useSettings } from '../contexts/SettingsContext.jsx';
import { formatPreview, formatDateTime } from '../utils/dateFormat.js';
import {
  Settings as SettingsIcon, Bell, Link, Container, Camera, Save, Eye, EyeOff, Undo2, Monitor,
  CheckCircle, XCircle, AlertTriangle, Info, Copy, Shield, ShieldCheck, ShieldAlert, Send,
  Users, Plus, Trash2, RefreshCw, Clock, FolderLock, Activity, Radar, Wifi, WifiOff, ArrowUpRight, ArrowDownLeft,
  Globe, X, HardDrive, Key, Folder, FolderOpen,
} from 'lucide-react';
import PillTabs from '../components/PillTabs.jsx';
import UpgradeReadinessWizard from '../components/UpgradeReadinessWizard.jsx';
import InfoTip from '../components/InfoTip.jsx';
import Dialog, { DialogSurface } from '../components/Dialog.jsx';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import AccountSettings from '../components/AccountSettings.jsx';
import './SettingsPage.css';

const SETTINGS_TABS = [
  { label: 'General', value: 'general' },
  { label: 'Notifications', value: 'notifications' },
  { label: 'Peers', value: 'peers' },
  { label: 'Integrations', value: 'integrations' },
  { label: 'Accounts', value: 'accounts' },
  { label: 'Infrastructure', value: 'infrastructure' },
  { label: 'Upgrade', value: 'upgrade' },
];

// Progress interval ticks (seconds): 1m–10m (1min steps), 15m–57m (3min steps), 1h–3h (15min steps)
const PROGRESS_TICKS = [
  ...Array.from({ length: 10 }, (_, i) => (i + 1) * 60),
  ...Array.from({ length: 10 }, (_, i) => 900 + i * 180),
  ...Array.from({ length: 8 }, (_, i) => 3600 + i * 900),
];

function formatInterval(seconds) {
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export default function SettingsPage() {
  const { refresh: refreshGlobalSettings } = useSettings();
  const [settings, setSettings] = useState({});
  const [savedSettings, setSavedSettings] = useState({});
  const [saved, setSaved] = useState(false);
  const [activeTab, setActiveTab] = useState('general');
  const [showTokens, setShowTokens] = useState({});
  const [loading, setLoading] = useState(true);
  const [ntfyTestResult, setNtfyTestResult] = useState(null);
  const [browserTestResult, setBrowserTestResult] = useState(null);
  const [immichTestResult, setImmichTestResult] = useState(null);
  const [showNtfyConfig, setShowNtfyConfig] = useState(false);

  // Peers state
  const [peers, setPeers] = useState([]);
  const [outgoingPeers, setOutgoingPeers] = useState([]);
  const [showPeerForm, setShowPeerForm] = useState(false);
  const [editingPeer, setEditingPeer] = useState(null);
  const [peerForm, setPeerForm] = useState({ name: '', allowed_path_prefix: '/', storage_limit_gb: '' });
  const [newPeerKey, setNewPeerKey] = useState(null);
  const [peerKeyCopied, setPeerKeyCopied] = useState(false);
  const [peerAuditLog, setPeerAuditLog] = useState(null);
  const [auditPeerId, setAuditPeerId] = useState(null);
  const [confirmDeletePeer, setConfirmDeletePeer] = useState(null);
  const [confirmRegeneratePeer, setConfirmRegeneratePeer] = useState(null);
  const [peerConnectivity, setPeerConnectivity] = useState({});
  const [checkingConnectivity, setCheckingConnectivity] = useState(false);
  const [subnetInfo, setSubnetInfo] = useState(null);
  const [detectingSubnets, setDetectingSubnets] = useState(false);
  const [incomingPairings, setIncomingPairings] = useState([]);
  const [pairingProcessing, setPairingProcessing] = useState(null);
  const [pairingAccess, setPairingAccess] = useState({});
  const [confirmUnpair, setConfirmUnpair] = useState(null);
  const [discoveredImmich, setDiscoveredImmich] = useState([]);
  const [discoveringImmich, setDiscoveringImmich] = useState(false);
  const [immichDiscoveryError, setImmichDiscoveryError] = useState(null);
  const [hiddenDriveInput, setHiddenDriveInput] = useState('');
  const [availableDrives, setAvailableDrives] = useState([]);
  const [showHiddenDriveModal, setShowHiddenDriveModal] = useState(false);
  const [hiddenDriveScope, setHiddenDriveScope] = useState('local');
  const [showPeerPathPicker, setShowPeerPathPicker] = useState(false);
  const [actionResult, setActionResult] = useState(null);
  const [peerDialogError, setPeerDialogError] = useState(null);
  const [peerActionBusy, setPeerActionBusy] = useState(false);

  useEffect(() => { loadSettings(); }, []);
  useReconnect(useCallback(() => loadSettings(), []));

  function loadSettings() {
    Promise.all([getSettings(), getPeers()])
      .then(([s, peersData]) => {
        setSettings(s);
        setSavedSettings(s);
        setPeers(peersData.incoming || peersData);
        setOutgoingPeers(peersData.outgoing || []);
        setLoading(false);
      })
      .catch(err => {
        setActionResult({ type: 'error', message: err.message });
        setLoading(false);
      });
    // Load extra data in background
    getDiscoverySubnets().then(setSubnetInfo).catch(() => {});
    loadIncomingPairings();
  }

  function loadIncomingPairings() {
    getPairingIncoming().then(setIncomingPairings).catch(() => {});
  }

  // Poll for incoming pairing requests every 5 seconds
  useEffect(() => {
    const interval = setInterval(loadIncomingPairings, 5000);
    return () => clearInterval(interval);
  }, []);

  // Load available drives when General or Peers tab is active
  useEffect(() => {
    if (activeTab !== 'general' && activeTab !== 'peers') return;
    if (availableDrives.length > 0) return; // already loaded
    Promise.all([
      getAllFilesystemRoots().catch(() => []),
      getSsdShares().catch(() => []),
    ]).then(([roots, shares]) => {
      const drives = [];
      const seen = new Set();
      for (const r of roots) {
        if (r.path !== '/' && r.icon !== 'home' && !seen.has(r.path)) {
          seen.add(r.path);
          drives.push({ path: r.path, name: r.name, type: 'root' });
        }
      }
      for (const s of shares) {
        const p = s.userPath || s.cachePath || s.path;
        if (p && !seen.has(p)) {
          seen.add(p);
          drives.push({ path: p, name: s.name || p, type: 'share' });
        }
      }
      setAvailableDrives(drives);
    });
  }, [activeTab]);

  const hasChanges = Object.keys(settings).some(k => settings[k] !== savedSettings[k])
    || Object.keys(savedSettings).some(k => settings[k] !== savedSettings[k]);

  const doSave = useCallback(async (s) => {
    try {
      await saveSettings(s || settings);
      return true;
    } catch (err) {
      setActionResult({ type: 'error', message: err.message });
      return false;
    }
  }, [settings]);

  async function handleSave() {
    setActionResult(null);
    try {
      await saveSettings(settings);
      setSavedSettings({ ...settings });
      refreshGlobalSettings();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setActionResult({ type: 'error', message: err.message });
    }
  }

  function handleDiscard() {
    setSettings({ ...savedSettings });
  }

  function update(key, value) {
    setSettings(s => ({ ...s, [key]: value }));
  }

  function toggleShow(key) {
    setShowTokens(s => ({ ...s, [key]: !s[key] }));
  }

  async function handleNtfyTest() {
    setNtfyTestResult(null);
    if (!await doSave()) return;
    try {
      const result = await testNtfy();
      setNtfyTestResult(result.success ? 'sent' : 'failed');
    } catch {
      setNtfyTestResult('failed');
    }
    setTimeout(() => setNtfyTestResult(null), 5000);
  }

  async function handleBrowserTest() {
    setBrowserTestResult(null);
    if ('Notification' in window && Notification.permission !== 'granted') {
      await Notification.requestPermission();
    }
    if (!await doSave()) return;
    try {
      await testBrowserNotify();
      setBrowserTestResult('sent');
    } catch {
      setBrowserTestResult('failed');
    }
    setTimeout(() => setBrowserTestResult(null), 5000);
  }

  async function handleBrowserToggle(enabled) {
    update('browser_notify_enabled', enabled ? 'true' : 'false');
    if (enabled) {
      if ('Notification' in window && Notification.permission !== 'granted') {
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') return;
      }
      try {
        await saveSettings({ ...settings, browser_notify_enabled: 'true' });
      } catch (err) {
        setActionResult({ type: 'error', message: err.message });
        return;
      }
      try {
        await testBrowserNotify();
        setBrowserTestResult('sent');
        setTimeout(() => setBrowserTestResult(null), 5000);
      } catch (err) {
        setActionResult({ type: 'error', message: err.message });
      }
    }
  }

  async function handleNtfyToggle(enabled) {
    update('ntfy_enabled', enabled ? 'true' : 'false');
    if (enabled) {
      try {
        await saveSettings({ ...settings, ntfy_enabled: 'true' });
      } catch (err) {
        setActionResult({ type: 'error', message: err.message });
        return;
      }
      try {
        const result = await testNtfy();
        setNtfyTestResult(result.success ? 'sent' : 'failed');
        setTimeout(() => setNtfyTestResult(null), 5000);
      } catch (err) {
        setActionResult({ type: 'error', message: err.message });
      }
    }
  }

  async function handleImmichTest() {
    setImmichTestResult(null);
    if (!await doSave()) return;
    try {
      const result = await testImmichConnection();
      setImmichTestResult(result);
    } catch (err) {
      setImmichTestResult({ ok: false, error: err.message });
    }
  }

  async function handleDiscoverImmich() {
    setDiscoveringImmich(true);
    setImmichDiscoveryError(null);
    setDiscoveredImmich([]);
    try {
      const result = await discoverImmich(true);
      if (result.error) {
        setImmichDiscoveryError(result.message);
      } else {
        setDiscoveredImmich(result);
        if (result.length === 0) setImmichDiscoveryError('No Immich instances found on configured subnets.');
      }
    } catch (err) {
      setImmichDiscoveryError(err.message);
    }
    setDiscoveringImmich(false);
  }

  function selectDiscoveredImmich(instance) {
    update('immich_server_url', instance.url);
    setDiscoveredImmich([]);
    setImmichDiscoveryError(null);
  }

  async function handleRedetectSubnets() {
    setDetectingSubnets(true);
    try {
      const info = await getDiscoverySubnets(true);
      setSubnetInfo(info);
    } catch (err) {
      setActionResult({ type: 'error', message: err.message });
    }
    setDetectingSubnets(false);
  }

  async function handleAcceptPairing(id) {
    const access = pairingAccess[id] || {};
    setPairingProcessing(id);
    try {
      const result = await apiAcceptPairing(id, {
        allowed_path_prefix: access.path,
        storage_limit_bytes: Math.round(Number(access.quotaGb) * (1024 ** 3)),
        confirmed_fingerprint: access.fingerprint,
      });
      if (result.error) {
        setActionResult({ type: 'error', message: result.error });
      } else {
        loadIncomingPairings();
        await loadPeers();
      }
    } catch (err) {
      setActionResult({ type: 'error', message: err.message });
    }
    setPairingProcessing(null);
  }

  async function handleDeclinePairing(id) {
    setPairingProcessing(id);
    try {
      await apiDeclinePairing(id);
      loadIncomingPairings();
    } catch (err) {
      setActionResult({ type: 'error', message: err.message });
    }
    setPairingProcessing(null);
  }

  // ── Peer handlers ──
  async function loadPeers() {
    try {
      const data = await getPeers();
      setPeers(data.incoming || data);
      setOutgoingPeers(data.outgoing || []);
      // Sync outgoing quotas from remotes in background, then reload
      if (data.outgoing?.length > 0) {
        syncPairings().then(() => getPeers()).then(d => {
          setOutgoingPeers(d.outgoing || []);
        }).catch(() => {});
      }
    } catch (err) {
      setActionResult({ type: 'error', message: err.message });
    }
  }

  async function handleCreatePeer(e) {
    e.preventDefault();
    try {
      const data = { ...peerForm, storage_limit_bytes: peerForm.storage_limit_gb ? Math.round(parseFloat(peerForm.storage_limit_gb) * 1024 ** 3) : 0 };
      delete data.storage_limit_gb;
      const result = await createPeer(data);
      setNewPeerKey(result.api_key);
      setPeerForm({ name: '', allowed_path_prefix: '/', storage_limit_gb: '' });
      setShowPeerForm(false);
      await loadPeers();
    } catch (err) {
      setActionResult({ type: 'error', message: err.message });
    }
  }

  async function handleUpdatePeer(e) {
    e.preventDefault();
    try {
      const data = { ...peerForm, storage_limit_bytes: peerForm.storage_limit_gb ? Math.round(parseFloat(peerForm.storage_limit_gb) * 1024 ** 3) : 0 };
      delete data.storage_limit_gb;
      await updatePeer(editingPeer.id, data);
      setEditingPeer(null);
      setPeerForm({ name: '', allowed_path_prefix: '/' });
      await loadPeers();
    } catch (err) {
      setActionResult({ type: 'error', message: err.message });
    }
  }

  async function handleDeletePeer(id) {
    setPeerActionBusy(true);
    setPeerDialogError(null);
    try {
      await deletePeer(id);
      setConfirmDeletePeer(null);
      await loadPeers();
    } catch (err) {
      setPeerDialogError(err.message);
    } finally {
      setPeerActionBusy(false);
    }
  }

  async function handleRegenerateKey(id) {
    setPeerActionBusy(true);
    setPeerDialogError(null);
    try {
      const result = await regeneratePeerKey(id);
      setNewPeerKey(result.api_key);
      setConfirmRegeneratePeer(null);
      await loadPeers();
    } catch (err) {
      setPeerDialogError(err.message);
    } finally {
      setPeerActionBusy(false);
    }
  }

  async function handleUnpair() {
    setPeerActionBusy(true);
    setPeerDialogError(null);
    try {
      await apiDeletePairing(confirmUnpair.id);
      setConfirmUnpair(null);
      await loadPeers();
    } catch (err) {
      setPeerDialogError(err.message);
    } finally {
      setPeerActionBusy(false);
    }
  }

  async function handleViewAuditLog(peerId) {
    setAuditPeerId(peerId);
    try {
      const result = await getPeerAuditLog(peerId);
      setPeerAuditLog(result);
    } catch (err) {
      setPeerAuditLog({ entries: [], error: err.message });
    }
  }

  async function handleCheckConnectivity() {
    setCheckingConnectivity(true);
    try {
      const results = await getPeerConnectivity();
      const map = {};
      for (const r of results) map[r.id] = r;
      setPeerConnectivity(map);
    } catch (err) {
      console.error('Connectivity check failed:', err);
    }
    setCheckingConnectivity(false);
  }

  function copyPeerKey() {
    if (newPeerKey) {
      navigator.clipboard.writeText(newPeerKey);
      setPeerKeyCopied(true);
      setTimeout(() => setPeerKeyCopied(false), 3000);
    }
  }

  const notifyDisabled = settings.ntfy_enabled !== 'true' && settings.browser_notify_enabled !== 'true';
  const progressIdx = PROGRESS_TICKS.indexOf(parseInt(settings.ntfy_progress_interval || '60'));
  const progressSliderIdx = progressIdx >= 0 ? progressIdx : 0;

  // Timezone list from browser Intl API
  const timezones = useMemo(() => {
    try { return Intl.supportedValuesOf('timeZone'); }
    catch { return ['UTC', 'Europe/Amsterdam', 'Europe/London', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Asia/Tokyo', 'Asia/Shanghai', 'Australia/Sydney']; }
  }, []);

  // Date/time preview
  const dateTimePreview = useMemo(() => formatPreview(settings), [settings.timezone, settings.date_format, settings.time_format]);

  // Hidden drives helpers
  const hiddenDrives = useMemo(() => {
    try { return JSON.parse(settings.hidden_drives || '[]'); }
    catch { return []; }
  }, [settings.hidden_drives]);

  function addHiddenDrive() {
    const path = hiddenDriveInput.trim();
    if (!path || hiddenDrives.includes(path)) return;
    update('hidden_drives', JSON.stringify([...hiddenDrives, path]));
    setHiddenDriveInput('');
  }

  function removeHiddenDrive(path) {
    update('hidden_drives', JSON.stringify(hiddenDrives.filter(d => d !== path)));
  }

  // Remote hidden drives helpers
  const hiddenRemoteDrives = useMemo(() => {
    try { return JSON.parse(settings.hidden_remote_drives || '[]'); }
    catch { return []; }
  }, [settings.hidden_remote_drives]);

  function addHiddenRemoteDrive() {
    const path = hiddenDriveInput.trim();
    if (!path || hiddenRemoteDrives.includes(path)) return;
    update('hidden_remote_drives', JSON.stringify([...hiddenRemoteDrives, path]));
    setHiddenDriveInput('');
  }

  function removeHiddenRemoteDrive(path) {
    update('hidden_remote_drives', JSON.stringify(hiddenRemoteDrives.filter(d => d !== path)));
  }

  if (loading) return <div className="empty-state"><p>Loading...</p></div>;

  return (
    <div className="settings-page">
      <div className="page-header">
        <div>
          <h1><SettingsIcon size={24} /> Settings</h1>
          <p className="page-subtitle">Configure RedMan instance settings</p>
        </div>
      </div>

      {actionResult && (
        <div className={`alert alert-${actionResult.type}`} role={actionResult.type === 'error' ? 'alert' : 'status'}>
          {actionResult.message}
        </div>
      )}

      <PillTabs tabs={SETTINGS_TABS.map(t => {
        if (t.value === 'peers') {
          const total = peers.length + outgoingPeers.length;
          const badge = incomingPairings.length > 0 ? ` (${incomingPairings.length} new)` : total > 0 ? ` (${total})` : '';
          return { ...t, label: `Peers${badge}` };
        }
        return t;
      })} active={activeTab} onChange={setActiveTab} />

      {/* ── General ── */}
      {activeTab === 'general' && (
        <div className="settings-cards-grid">
          {/* Instance Name */}
          <div className="card">
            <div className="card-header"><h3><SettingsIcon size={16} /> General</h3></div>
            <div className="form-group">
              <label>Instance Name<InfoTip text="A friendly name for this RedMan instance. Shown in notifications, the peer API, and the browser title bar." /></label>
              <input value={settings.instance_name || ''} onChange={e => update('instance_name', e.target.value)} placeholder="RedMan" />
            </div>
            <div className="form-group">
              <label>User Name<InfoTip text="Your personal name or identifier." /></label>
              <input value={settings.user_name || ''} onChange={e => update('user_name', e.target.value)} placeholder="User" />
            </div>
          </div>

          {/* Date & Time Display */}
          <div className="card">
            <div className="card-header"><h3><Clock size={16} /> Date & Time Display</h3></div>
            <div className="form-group">
              <label>Timezone<InfoTip text="Controls how dates and times are displayed throughout the app. Also sets the container's internal clock." /></label>
              <select value={settings.timezone || 'UTC'} onChange={e => update('timezone', e.target.value)}>
                <option value="system">System Default</option>
                {timezones.map(tz => <option key={tz} value={tz}>{tz.replace(/_/g, ' ')}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>Date Format</label>
              <select value={settings.date_format || 'system'} onChange={e => update('date_format', e.target.value)}>
                <option value="system">System Default</option>
                <option value="DD/MM/YYYY">DD/MM/YYYY</option>
                <option value="MM/DD/YYYY">MM/DD/YYYY</option>
                <option value="MMM D, YYYY">MMM D, YYYY</option>
                <option value="YYYY-MM-DD">YYYY-MM-DD</option>
              </select>
            </div>
            <div className="form-group">
              <label>Time Format</label>
              <select value={settings.time_format || 'system'} onChange={e => update('time_format', e.target.value)}>
                <option value="system">System Default</option>
                <option value="24h">24-hour</option>
                <option value="12h">12-hour</option>
              </select>
            </div>
            <p className="datetime-preview">Preview: {dateTimePreview}</p>
          </div>

          {/* Hidden Drives */}
          <div className="card" style={{ gridColumn: '1 / -1' }}>
            <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3><EyeOff size={16} /> Hidden Drives</h3>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setHiddenDriveInput(''); setShowHiddenDriveModal(true); }}>
                <Plus size={14} /> Add
              </button>
            </div>

            <PillTabs
              tabs={[
                { value: 'local', label: `Local${hiddenDrives.length ? ` (${hiddenDrives.length})` : ''}` },
                { value: 'remote', label: `Remote${hiddenRemoteDrives.length ? ` (${hiddenRemoteDrives.length})` : ''}` },
              ]}
              active={hiddenDriveScope}
              onChange={setHiddenDriveScope}
            />

            {hiddenDriveScope === 'local' && (
              <>
                <p className="form-hint" style={{ marginBottom: 'var(--space-md)' }}>
                  Hidden from the local filesystem browser, SSD Backup shares, and Media Import drives.
                </p>
                {hiddenDrives.length === 0 && (
                  <p className="form-hint" style={{ fontStyle: 'italic' }}>No local drives are hidden.</p>
                )}
                {hiddenDrives.length > 0 && (
                  <div className="hidden-drives-list">
                    {hiddenDrives.map(path => (
                      <div key={path} className="hidden-drive-item">
                        <code>{path}</code>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => removeHiddenDrive(path)} title="Remove" aria-label={`Remove hidden drive ${path}`}>
                          <X size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            {hiddenDriveScope === 'remote' && (
              <>
                <p className="form-hint" style={{ marginBottom: 'var(--space-md)' }}>
                  Hidden from the remote file picker when browsing Hyper Backup peer destinations.
                </p>
                {hiddenRemoteDrives.length === 0 && (
                  <p className="form-hint" style={{ fontStyle: 'italic' }}>No remote drives are hidden.</p>
                )}
                {hiddenRemoteDrives.length > 0 && (
                  <div className="hidden-drives-list">
                    {hiddenRemoteDrives.map(path => (
                      <div key={path} className="hidden-drive-item">
                        <code>{path}</code>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => removeHiddenRemoteDrive(path)} title="Remove" aria-label={`Remove hidden remote drive ${path}`}>
                          <X size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Notifications ── */}
      {activeTab === 'notifications' && (
        <div className="settings-cards-grid">
          {/* Notification Channels */}
          <div className="card">
            <div className="card-header"><h3><Bell size={16} /> Notification Channels</h3></div>
            <p className="form-hint" style={{ marginBottom: 'var(--space-md)' }}>Enable one or both notification channels.</p>

            <div className="notify-channel">
              <div className="notify-channel-header">
                <label className="toggle-label">
                  <input
                    type="checkbox"
                    className="toggle"
                    checked={settings.browser_notify_enabled === 'true'}
                    onChange={e => handleBrowserToggle(e.target.checked)}
                  />
                  <Monitor size={14} style={{ marginRight: 4, opacity: 0.6 }} /> Browser Notifications<InfoTip text="Native push notifications via the browser. Works on desktop and mobile. Requires granting notification permission." />
                </label>
                <div className="notify-channel-actions">
                  <button type="button" className="btn btn-ghost btn-sm" onClick={handleBrowserTest}><Send size={14} /> Test</button>
                  {browserTestResult === 'sent' && <span className="test-ok"><CheckCircle size={14} /> Sent!</span>}
                  {browserTestResult === 'failed' && <span className="test-fail"><XCircle size={14} /> Failed</span>}
                </div>
              </div>
              {'Notification' in window && Notification.permission === 'denied' && (
                <div className="alert alert-error" style={{ marginTop: 'var(--space-sm)', padding: 'var(--space-sm)' }}>
                  <AlertTriangle size={14} /> Notifications are blocked. Allow them in your browser's site settings.
                </div>
              )}
              <p className="form-hint" style={{ marginTop: 'var(--space-xs)' }}>
                Native desktop &amp; Android notifications. On iOS, add RedMan to your home screen (requires iOS 16.4+).
              </p>
            </div>

            <div className="notify-channel">
              <div className="notify-channel-header">
                <label className="toggle-label">
                  <input
                    type="checkbox"
                    className="toggle"
                    checked={settings.ntfy_enabled === 'true'}
                    onChange={e => handleNtfyToggle(e.target.checked)}
                  />
                  <Bell size={14} style={{ marginRight: 4, opacity: 0.6 }} /> ntfy.sh<InfoTip text="Push notifications via ntfy.sh — self-hosted or the public server. Delivers to any device with the ntfy app installed." />
                </label>
                <div className="notify-channel-actions">
                  <button type="button" className="btn btn-ghost btn-sm" onClick={handleNtfyTest}><Send size={14} /> Test</button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowNtfyConfig(true)}><SettingsIcon size={14} /> Configure</button>
                  {ntfyTestResult === 'sent' && <span className="test-ok"><CheckCircle size={14} /> Sent!</span>}
                  {ntfyTestResult === 'failed' && <span className="test-fail"><XCircle size={14} /> Failed</span>}
                </div>
              </div>
              <p className="form-hint" style={{ marginTop: 'var(--space-xs)' }}>
                Push notifications via <a href="https://ntfy.sh" target="_blank" rel="noreferrer">ntfy.sh</a> or a self-hosted server.{settings.ntfy_topic && <> Topic: <code>{settings.ntfy_topic}</code></>}
              </p>
            </div>
          </div>

          {/* Events */}
          <div className="card">
            <div className="card-header"><h3><Send size={16} /> Events</h3></div>
            <p className="form-hint" style={{ marginBottom: 'var(--space-md)' }}>
              These are the global defaults. Individual jobs can override with custom or silent notification rules.
              {notifyDisabled && <em> Enable at least one channel to activate.</em>}
            </p>

            <div className="event-toggles">
              <span className="event-group-label">Backup Jobs</span>
              <span className="form-hint" style={{ marginBottom: 'var(--space-sm)' }}>SSD Backup, Hyper Backup, and Cloud Backup jobs</span>
              <label className="toggle-label" data-disabled={notifyDisabled}>
                <input type="checkbox" className="toggle" disabled={notifyDisabled}
                  checked={settings.ntfy_on_job_start === 'true'}
                  onChange={e => update('ntfy_on_job_start', e.target.checked ? 'true' : 'false')} />
                Backup / Import Started
              </label>
              <label className="toggle-label" data-disabled={notifyDisabled}>
                <input type="checkbox" className="toggle" disabled={notifyDisabled}
                  checked={settings.ntfy_on_job_complete === 'true'}
                  onChange={e => update('ntfy_on_job_complete', e.target.checked ? 'true' : 'false')} />
                Backup / Import Completed or Cancelled
              </label>
              <label className="toggle-label" data-disabled={notifyDisabled}>
                <input type="checkbox" className="toggle" disabled={notifyDisabled}
                  checked={settings.ntfy_on_job_error === 'true'}
                  onChange={e => update('ntfy_on_job_error', e.target.checked ? 'true' : 'false')} />
                Backup / Import Failed
              </label>

              <span className="event-group-label" style={{ marginTop: 'var(--space-md)' }}>Media Import — Drive Monitoring</span>
              <span className="form-hint" style={{ marginBottom: 'var(--space-sm)' }}>USB drives and SD cards detected under <code>/mnt/disks</code></span>
              <label className="toggle-label" data-disabled={notifyDisabled}>
                <input type="checkbox" className="toggle" disabled={notifyDisabled}
                  checked={settings.ntfy_on_drive_attach === 'true'}
                  onChange={e => update('ntfy_on_drive_attach', e.target.checked ? 'true' : 'false')} />
                Drive Connected / Ejected
              </label>
              <label className="toggle-label" data-disabled={notifyDisabled}>
                <input type="checkbox" className="toggle" disabled={notifyDisabled}
                  checked={settings.ntfy_on_drive_scan === 'true'}
                  onChange={e => update('ntfy_on_drive_scan', e.target.checked ? 'true' : 'false')} />
                Drive Scan Started / Completed
              </label>
              <label className="toggle-label" data-disabled={notifyDisabled}>
                <input type="checkbox" className="toggle" disabled={notifyDisabled}
                  checked={settings.ntfy_on_drive_lost === 'true'}
                  onChange={e => update('ntfy_on_drive_lost', e.target.checked ? 'true' : 'false')} />
                Drive Unexpectedly Removed
              </label>

              <div className="progress-toggle-group">
                <label className="toggle-label" data-disabled={notifyDisabled}>
                  <input type="checkbox" className="toggle" disabled={notifyDisabled}
                    checked={settings.ntfy_on_progress === 'true'}
                    onChange={e => update('ntfy_on_progress', e.target.checked ? 'true' : 'false')} />
                  Recurring Progress Updates
                </label>
                {settings.ntfy_on_progress === 'true' && (
                  <div className="progress-interval">
                    <label>Progress Interval: <strong>{formatInterval(PROGRESS_TICKS[progressSliderIdx])}</strong></label>
                    <input
                      type="range" min="0" max={PROGRESS_TICKS.length - 1} step="1"
                      value={progressSliderIdx}
                      onChange={e => update('ntfy_progress_interval', String(PROGRESS_TICKS[parseInt(e.target.value)]))}
                    />
                    <div className="progress-range-labels">
                      <span>1m</span><span>3h</span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Authorized Peers ── */}
      {activeTab === 'peers' && (
        <div className="settings-cards-grid">
          {/* Incoming pairing requests banner */}
          {incomingPairings.length > 0 && (
            <div className="card pairing-banner" style={{ gridColumn: '1 / -1' }}>
              <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
                <Radar size={16} style={{ color: 'var(--color-primary)' }} />
                <h3 style={{ margin: 0 }}>Connection Request{incomingPairings.length > 1 ? 's' : ''}</h3>
              </div>
              {incomingPairings.map(p => (
                <div key={p.id} className="pairing-request-card">
                  <div className="pairing-request-info">
                    <span className="pairing-request-name">{p.remote_instance}</span>
                    <span className="pairing-request-detail">wants to connect · {p.remote_url}</span>
                    <span className="pairing-request-detail">Compare on initiator: <code>{p.remote_fingerprint}</code></span>
                    <div className="form-row" style={{ marginTop: 'var(--space-xs)' }}>
                      <input
                        aria-label={`Backup directory for ${p.remote_instance}`}
                        placeholder="/mnt/user/backups/peer"
                        value={pairingAccess[p.id]?.path || ''}
                        onChange={event => setPairingAccess(current => ({
                          ...current,
                          [p.id]: { ...current[p.id], path: event.target.value },
                        }))}
                      />
                      <input
                        aria-label={`Storage quota in GB for ${p.remote_instance}`}
                        type="number"
                        min="1"
                        placeholder="Quota GB"
                        value={pairingAccess[p.id]?.quotaGb || ''}
                        onChange={event => setPairingAccess(current => ({
                          ...current,
                          [p.id]: { ...current[p.id], quotaGb: event.target.value },
                        }))}
                      />
                    </div>
                    <input
                      aria-label={`Confirm fingerprint for ${p.remote_instance}`}
                      placeholder="Type fingerprint to confirm"
                      value={pairingAccess[p.id]?.fingerprint || ''}
                      onChange={event => setPairingAccess(current => ({
                        ...current,
                        [p.id]: { ...current[p.id], fingerprint: event.target.value },
                      }))}
                    />
                  </div>
                  <div className="pairing-request-actions">
                    <button className="btn btn-primary btn-sm" onClick={() => handleAcceptPairing(p.id)} disabled={pairingProcessing === p.id || !pairingAccess[p.id]?.path || !(Number(pairingAccess[p.id]?.quotaGb) > 0) || pairingAccess[p.id]?.fingerprint?.replace(/[^a-f0-9]/gi, '').toUpperCase() !== p.remote_fingerprint?.replace(/[^a-f0-9]/gi, '').toUpperCase()}>
                      {pairingProcessing === p.id ? 'Connecting...' : 'Accept'}
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => handleDeclinePairing(p.id)} disabled={pairingProcessing === p.id}>
                      Decline
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Destinations — peers we push backups TO */}
          {outgoingPeers.length > 0 && (
            <div className="card" style={{ gridColumn: '1 / -1' }}>
              <div className="card-header">
                <h3><ArrowUpRight size={16} /> Destinations</h3>
              </div>
              <p className="form-hint" style={{ marginBottom: 'var(--space-md)' }}>
                Instances this RedMan pushes backups to. Paired via auto-discovery.
              </p>
              <div className="peer-list">
                {outgoingPeers.map(p => (
                  <div key={`out-${p.id}`} className="config-card">
                    <div className="config-card-header">
                      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xs)' }}>
                        <span className="config-name">{p.name}</span>
                        <span className="peer-status peer-status-online"><Wifi size={12} /> Paired</span>
                        {p.handshake_version >= 2
                          ? <span className="peer-status peer-status-secure" title={p.remote_fingerprint ? `Secure — Fingerprint: ${p.remote_fingerprint}` : 'Secure — Noise XX handshake'}><ShieldCheck size={12} /></span>
                          : <span className="peer-status peer-status-insecure" title="Legacy pairing — re-pair to upgrade"><ShieldAlert size={12} /></span>}
                      </div>
                      <div className="config-actions">
                        <button type="button" className="btn btn-ghost btn-sm btn-danger" title="Unpair" aria-label={`Unpair ${p.name}`} onClick={() => setConfirmUnpair(p)}>
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                    <div className="config-details">
                      <div className="config-detail">
                        <span className="detail-label"><ArrowUpRight size={12} /> URL</span>
                        <code>{p.remote_url}</code>
                      </div>
                      {p.remote_storage_limit > 0 && (
                        <div className="config-detail">
                          <span className="detail-label">Quota</span>
                          <span>{(p.remote_storage_limit / (1024 ** 3)).toFixed(0)} GB (set by remote)</span>
                        </div>
                      )}
                      {p.remote_allowed_path && p.remote_allowed_path !== '/' && (
                        <div className="config-detail">
                          <span className="detail-label"><FolderLock size={12} /> Allowed Path</span>
                          <code>{p.remote_allowed_path}</code>
                        </div>
                      )}
                      {p.created_at && (
                        <div className="config-detail">
                          <span className="detail-label"><Clock size={12} /> Paired</span>
                          <span>{formatDateTime(p.created_at, settings)}</span>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Sources — peers authorized to push backups HERE */}
          <div className="card" style={{ gridColumn: '1 / -1' }}>
            <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3><ArrowDownLeft size={16} /> Sources</h3>
              <div style={{ display: 'flex', gap: 'var(--space-xs)' }}>
                <button type="button" className="btn btn-secondary btn-sm" onClick={handleCheckConnectivity} disabled={checkingConnectivity || peers.length === 0}>
                  {checkingConnectivity ? <><Wifi size={14} className="spin" /> Checking...</> : <><Wifi size={14} /> Check Status</>}
                </button>
                <button type="button" className="btn btn-primary btn-sm" onClick={() => {
                  setPeerForm({ name: '', allowed_path_prefix: '/', storage_limit_gb: '' });
                  setEditingPeer(null);
                  setShowPeerForm(true);
                }}>
                  <Plus size={14} /> Add Peer
                </button>
              </div>
            </div>
            <p className="form-hint" style={{ marginBottom: 'var(--space-md)' }}>
              Instances authorized to push backups to this RedMan. Created automatically during pairing.
            </p>

            {peers.length === 0 ? (
              <div className="empty-state" style={{ padding: 'var(--space-lg)' }}>
                <ArrowDownLeft size={32} style={{ opacity: 0.3 }} />
                <p>No incoming peers yet. When another instance pairs with this one, it will appear here.</p>
              </div>
            ) : (
              <div className="peer-list">
                {peers.map(p => (
                  <div key={p.id} className="config-card" style={{ opacity: p.enabled ? 1 : 0.6 }}>
                    <div className="config-card-header">
                      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xs)', flexWrap: 'wrap' }}>
                        <span className="config-name">{p.name}</span>
                        {!p.enabled && <span className="badge badge-muted" style={{ marginLeft: 0 }}>Disabled</span>}
                        {p.static_pubkey
                          ? <span className="peer-status peer-status-secure" title="Secure — Noise XX handshake"><ShieldCheck size={12} /></span>
                          : <span className="peer-status peer-status-insecure" title="Legacy pairing — re-pair to upgrade"><ShieldAlert size={12} /></span>}
                        {peerConnectivity[p.id] && (
                          <span className={`peer-status peer-status-${peerConnectivity[p.id].status}`}>
                            {peerConnectivity[p.id].status === 'online'
                              ? <><Wifi size={12} /> Online{peerConnectivity[p.id].instance ? ` (${peerConnectivity[p.id].instance})` : ''}</>
                              : peerConnectivity[p.id].status === 'unknown'
                                ? <><WifiOff size={12} /> Never connected</>
                                : peerConnectivity[p.id].status === 'disabled'
                                  ? <><WifiOff size={12} /> Disabled</>
                                  : <><WifiOff size={12} /> Unreachable</>}
                          </span>
                        )}
                      </div>
                      <div className="config-actions">
                        <button type="button" className="btn btn-ghost btn-sm" title="View audit log" aria-label={`View audit log for ${p.name}`} onClick={() => handleViewAuditLog(p.id)}>
                          <Activity size={14} />
                        </button>
                        <button type="button" className="btn btn-ghost btn-sm" title="Regenerate key" aria-label={`Regenerate key for ${p.name}`} onClick={() => setConfirmRegeneratePeer(p)}>
                          <RefreshCw size={14} />
                        </button>
                        <button type="button" className="btn btn-ghost btn-sm" title="Edit" onClick={() => {
                          setEditingPeer(p);
                          setPeerForm({ name: p.name, allowed_path_prefix: p.allowed_path_prefix, enabled: !!p.enabled, storage_limit_gb: p.storage_limit_bytes ? (p.storage_limit_bytes / (1024 ** 3)).toFixed(0) : '' });
                          setShowPeerForm(true);
                        }}>
                          Edit
                        </button>
                        <button type="button" className="btn btn-ghost btn-sm btn-danger" title="Delete" aria-label={`Delete ${p.name}`} onClick={() => setConfirmDeletePeer(p)}>
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                    <div className="config-details">
                      <div className="config-detail">
                        <span className="detail-label"><FolderLock size={12} /> Allowed Path</span>
                        <code>{p.allowed_path_prefix}</code>
                      </div>
                      <div className="config-detail">
                        <span className="detail-label"><Key size={12} /> API Key</span>
                        <code>{p.api_key}</code>
                      </div>
                      {p.storage_limit_bytes > 0 && (
                        <div className="config-detail">
                          <span className="detail-label">Storage Limit</span>
                          <span>{(p.storage_limit_bytes / (1024 ** 3)).toFixed(0)} GB (soft)</span>
                        </div>
                      )}
                      {p.last_seen_at && (
                        <div className="config-detail">
                          <span className="detail-label"><Clock size={12} /> Last Seen</span>
                          <span>{formatDateTime(p.last_seen_at, settings)}{p.last_seen_ip ? ` from ${p.last_seen_ip}` : ''}</span>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* New Peer Key Display Modal */}
      {newPeerKey && (
        <Dialog
          title={<><Key size={16} aria-hidden="true" /> Peer API Key</>}
          onClose={() => setNewPeerKey(null)}
          closeOnOverlay={false}
          footer={<div className="modal-footer-actions"><button type="button" className="btn btn-primary" data-autofocus onClick={() => setNewPeerKey(null)}>Done</button></div>}
        >
              <div className="alert alert-error" style={{ display: 'flex', gap: 'var(--space-sm)', alignItems: 'flex-start', marginBottom: 'var(--space-md)' }}>
                <AlertTriangle size={16} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />
                <div><strong>Copy this key now.</strong> It will not be shown again.</div>
              </div>
              <div className="ssh-pubkey-row">
                <code className="ssh-pubkey" style={{ wordBreak: 'break-all' }}>{newPeerKey}</code>
                <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="Copy peer API key" onClick={copyPeerKey}>
                  {peerKeyCopied ? <CheckCircle size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
                </button>
              </div>
              <p className="form-hint" style={{ marginTop: 'var(--space-sm)' }}>
                Enter this key as the "Remote API Key" when creating a Hyper Backup job on the remote RedMan instance.
              </p>
        </Dialog>
      )}

      {/* Add/Edit Peer Modal */}
      {showPeerForm && (
        <DialogSurface ariaLabel={editingPeer ? 'Edit authorized peer' : 'Add authorized peer'} onClose={() => { setShowPeerForm(false); setEditingPeer(null); setShowPeerPathPicker(false); }}>
            <form onSubmit={editingPeer ? handleUpdatePeer : handleCreatePeer}>
              <div className="modal-header"><h3>{editingPeer ? 'Edit Peer' : 'Add Authorized Peer'}</h3></div>
              <div className="modal-body">
                <div className="form-group">
                  <label>Name</label>
                  <input value={peerForm.name} onChange={e => setPeerForm(f => ({ ...f, name: e.target.value }))} placeholder="Dad's NAS" required />
                  <span className="form-hint">A friendly name to identify this peer</span>
                </div>
                <div className="form-group">
                  <label>Allowed Path Prefix</label>
                  <div style={{ display: 'flex', gap: 'var(--space-xs)' }}>
                    <input style={{ flex: 1 }} value={peerForm.allowed_path_prefix} onChange={e => setPeerForm(f => ({ ...f, allowed_path_prefix: e.target.value }))} placeholder="/" required />
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowPeerPathPicker(!showPeerPathPicker)}>
                      <FolderOpen size={14} /> Browse
                    </button>
                  </div>
                  <span className="form-hint">This peer can only write to paths under this prefix (e.g. <code>/backups/from-dad</code>). Use <code>/</code> for unrestricted.</span>
                  {showPeerPathPicker && (() => {
                    const roots = availableDrives.filter(d => d.type === 'root');
                    const shares = availableDrives.filter(d => d.type === 'share');
                    return (
                      <div className="peer-path-picker">
                        {roots.length > 0 && (
                          <>
                            <span className="event-group-label" style={{ marginBottom: 'var(--space-xs)', display: 'block' }}>Mount Points</span>
                            <div className="drive-picker-grid">
                              {roots.map(d => (
                                <button key={d.path} type="button" className="drive-picker-item" onClick={() => {
                                  setPeerForm(f => ({ ...f, allowed_path_prefix: d.path }));
                                  setShowPeerPathPicker(false);
                                }}>
                                  <HardDrive size={14} />
                                  <span className="drive-picker-name">{d.name}</span>
                                  <code className="drive-picker-path">{d.path}</code>
                                </button>
                              ))}
                            </div>
                          </>
                        )}
                        {shares.length > 0 && (
                          <>
                            <span className="event-group-label" style={{ marginTop: roots.length > 0 ? 'var(--space-md)' : 0, marginBottom: 'var(--space-xs)', display: 'block' }}>Detected Storage</span>
                            <div className="drive-picker-grid">
                              {shares.map(d => (
                                <button key={d.path} type="button" className="drive-picker-item" onClick={() => {
                                  setPeerForm(f => ({ ...f, allowed_path_prefix: d.path }));
                                  setShowPeerPathPicker(false);
                                }}>
                                  <Folder size={14} />
                                  <span className="drive-picker-name">{d.name}</span>
                                  <code className="drive-picker-path">{d.path}</code>
                                </button>
                              ))}
                            </div>
                          </>
                        )}
                        {availableDrives.length === 0 && (
                          <p className="form-hint" style={{ fontStyle: 'italic' }}>No drives detected. Type a path manually.</p>
                        )}
                      </div>
                    );
                  })()}
                </div>
                <div className="form-group">
                  <label>Storage Limit (GB)</label>
                  <input type="number" min="0" value={peerForm.storage_limit_gb} onChange={e => setPeerForm(f => ({ ...f, storage_limit_gb: e.target.value }))} placeholder="Unlimited" />
                  <span className="form-hint">Soft cap — checked before each backup starts. A running backup may temporarily exceed this limit. Set lower than available disk space to leave headroom.</span>
                </div>
                {editingPeer && (
                  <div className="form-group">
                    <div className="toggle-group">
                      <div className={`toggle ${peerForm.enabled !== false ? 'active' : ''}`} onClick={() => setPeerForm(f => ({ ...f, enabled: !f.enabled }))} />
                      <span>Enabled</span>
                      <span className="form-hint" style={{ margin: 0 }}>Disabled peers cannot authenticate</span>
                    </div>
                  </div>
                )}
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-ghost" onClick={() => { setShowPeerForm(false); setEditingPeer(null); setShowPeerPathPicker(false); }}>Cancel</button>
                <button type="submit" className="btn btn-primary">{editingPeer ? 'Save' : 'Create Peer'}</button>
              </div>
            </form>
        </DialogSurface>
      )}

      {/* Regenerate Key Confirmation */}
      {confirmRegeneratePeer && (
        <ConfirmDialog title="Regenerate API key" confirmLabel="Regenerate key" destructive busy={peerActionBusy} error={peerDialogError} onClose={() => setConfirmRegeneratePeer(null)} onConfirm={() => handleRegenerateKey(confirmRegeneratePeer.id)}>
              <p>Are you sure you want to regenerate the API key for <strong>{confirmRegeneratePeer.name}</strong>?</p>
              <p style={{ color: 'var(--danger)', marginTop: 'var(--space-xs)' }}>The current key will be permanently invalidated. Remote instances using it lose access until updated.</p>
        </ConfirmDialog>
      )}

      {/* Delete Peer Confirmation */}
      {confirmDeletePeer && (
        <ConfirmDialog title="Delete peer" confirmLabel="Delete peer" destructive busy={peerActionBusy} error={peerDialogError} onClose={() => setConfirmDeletePeer(null)} onConfirm={() => handleDeletePeer(confirmDeletePeer.id)}>
              <p>Are you sure you want to delete <strong>{confirmDeletePeer.name}</strong>? This peer will no longer be able to authenticate.</p>
        </ConfirmDialog>
      )}

      {/* Unpair Destination Confirmation */}
      {confirmUnpair && (
        <ConfirmDialog title="Unpair destination" confirmLabel="Unpair" destructive busy={peerActionBusy} error={peerDialogError} onClose={() => setConfirmUnpair(null)} onConfirm={handleUnpair}>
              <p>Unpair from <strong>{confirmUnpair.name}</strong>? You can re-pair later via auto-discovery.</p>
        </ConfirmDialog>
      )}

      {/* Peer Audit Log Modal */}
      {peerAuditLog && (
        <DialogSurface ariaLabel="Peer audit log" style={{ maxWidth: 700 }} onClose={() => { setPeerAuditLog(null); setAuditPeerId(null); }}>
            <div className="modal-header"><h3><Activity size={16} /> Peer Audit Log</h3></div>
            <div className="modal-body" style={{ maxHeight: 400, overflowY: 'auto' }}>
              {peerAuditLog.error && <p className="test-fail"><XCircle size={14} /> {peerAuditLog.error}</p>}
              {peerAuditLog.entries?.length === 0 && <p className="form-hint">No audit log entries yet.</p>}
              {peerAuditLog.entries?.length > 0 && (
                <div className="table-wrapper">
                  <table>
                    <thead><tr><th>Time</th><th>Action</th><th>IP</th><th>Details</th></tr></thead>
                    <tbody>
                      {peerAuditLog.entries.map(e => (
                        <tr key={e.id}>
                          <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(e.created_at, settings)}</td>
                          <td><code>{e.action}</code></td>
                          <td><code>{e.ip_address}</code></td>
                          <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.details || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-primary" onClick={() => { setPeerAuditLog(null); setAuditPeerId(null); }}>Close</button>
            </div>
        </DialogSurface>
      )}

      {/* ── Integrations ── */}
      {activeTab === 'integrations' && (
        <div className="settings-cards-grid">
          {/* Immich */}
          <div className="card">
            <div className="card-header"><h3><Camera size={16} /> Immich</h3></div>
            <div className="form-group">
              <label>Server URL<InfoTip text="The URL of your Immich instance. Click Discover to auto-detect it on your network." /></label>
              <div style={{ display: 'flex', gap: 'var(--space-xs)' }}>
                <input style={{ flex: 1 }} value={settings.immich_server_url || ''} onChange={e => update('immich_server_url', e.target.value)} placeholder="http://immich:2283" />
                <button type="button" className="btn btn-secondary btn-sm" onClick={handleDiscoverImmich} disabled={discoveringImmich} title="Scan network for Immich instances">
                  {discoveringImmich ? <><Radar size={14} className="spin" /> Scanning...</> : <><Radar size={14} /> Discover</>}
                </button>
              </div>
              {discoveredImmich.length > 0 && (
                <div className="discovery-results">
                  {discoveredImmich.map(inst => (
                    <button key={inst.ip} type="button" className="discovery-item" onClick={() => selectDiscoveredImmich(inst)}>
                      <span className="discovery-name">Immich @ {inst.ip}</span>
                      <span className="discovery-detail">{inst.url} — v{inst.version}</span>
                    </button>
                  ))}
                </div>
              )}
              {immichDiscoveryError && <span className="form-hint" style={{ color: 'var(--warning)' }}>{immichDiscoveryError}</span>}
            </div>
            <div className="form-group">
              <label>API Key<InfoTip text="Generate this in Immich under Administration → API Keys. Needed for uploading media." /></label>
              <div className="token-input">
                <input
                  type={showTokens.immich_api_key ? 'text' : 'password'}
                  value={settings.immich_api_key || ''}
                  onChange={e => update('immich_api_key', e.target.value)}
                  placeholder="Your Immich API key"
                />
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => toggleShow('immich_api_key')} title={showTokens.immich_api_key ? 'Hide API key' : 'Show API key'} aria-label={showTokens.immich_api_key ? 'Hide Immich API key' : 'Show Immich API key'}>
                  {showTokens.immich_api_key ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>
            <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
              <button type="button" className="btn btn-secondary btn-sm" onClick={handleImmichTest}>
                Test Connection
              </button>
              {immichTestResult && (
                <span className={immichTestResult.ok ? 'test-ok' : 'test-fail'}>
                  {immichTestResult.ok
                    ? <><CheckCircle size={14} /> Connected{immichTestResult.user ? ` (${immichTestResult.user})` : ''}</>
                    : <><XCircle size={14} /> {immichTestResult.error}</>
                  }
                </span>
              )}
            </div>
            <div className="alert alert-info" style={{ display: 'flex', gap: 'var(--space-sm)', alignItems: 'flex-start', marginTop: 'var(--space-md)' }}>
              <Info size={16} style={{ flexShrink: 0, marginTop: 2 }} />
              <div>
                <strong>Mount propagation required</strong> — For drive detection to work inside Docker, mount <code>/mnt/disks</code> with <code>rslave</code> propagation in your <code>docker-compose.yml</code>.
              </div>
            </div>
          </div>

        </div>
      )}

      {/* ── Infrastructure ── */}
      {activeTab === 'accounts' && <AccountSettings />}

      {/* ── Infrastructure ── */}
      {activeTab === 'infrastructure' && (
        <div className="settings-cards-grid">
          {/* Network Discovery */}
          <div className="card">
            <div className="card-header"><h3><Radar size={16} /> Network Discovery</h3></div>

            {/* Auto-detected subnets */}
            <div className="form-group">
              <label>Detected LAN</label>
              {subnetInfo ? (
                <div className="subnet-detected">
                  {subnetInfo.auto?.length > 0 ? (
                    <span className="subnet-badge subnet-ok">
                      <Wifi size={14} /> {subnetInfo.auto.join(', ')}
                      <span className="subnet-source">via {subnetInfo.source}</span>
                    </span>
                  ) : (
                    <span className="subnet-badge subnet-none">
                      <WifiOff size={14} /> Not detected — add subnets manually below
                    </span>
                  )}
                  <button type="button" className="btn btn-ghost btn-sm" onClick={handleRedetectSubnets} disabled={detectingSubnets} title="Re-detect" aria-label="Re-detect network subnets">
                    <RefreshCw size={14} className={detectingSubnets ? 'spin' : ''} />
                  </button>
                </div>
              ) : (
                <span className="form-hint">Detecting...</span>
              )}
            </div>

            {/* Manual subnets (optional, for VPN etc.) */}
            <div className="form-group">
              <label>Additional Subnets <small>(optional)</small><InfoTip text="Extra network ranges to scan for RedMan peers. Useful for VPN or multi-site setups. Your LAN is detected automatically." /></label>
              <input value={settings.discovery_subnets || ''} onChange={e => update('discovery_subnets', e.target.value)} placeholder="e.g. 10.0.0.0/24 for VPN" />
            </div>
          </div>

          {/* Peer API */}
          <div className="card">
            <div className="card-header"><h3><Link size={16} /> Peer API (Hyper Backup)</h3></div>
            <div className="form-group">
              <label>Peer API Port<InfoTip text="The port used for peer-to-peer communication between RedMan instances (Hyper Backup). Change requires a container restart." /></label>
              <input type="number" value={settings.peer_api_port || '8091'} onChange={e => update('peer_api_port', e.target.value)} />
            </div>
            <div className="form-group">
              <label>Peer API URL <small>(optional)</small><InfoTip text="The URL other instances use to reach this RedMan's peer API. Required for multi-site or VPN setups where auto-detection picks the wrong address. Example: http://192.168.1.50:8091" /></label>
              <input value={settings.peer_api_url || ''} onChange={e => update('peer_api_url', e.target.value)} placeholder="Auto-detected (leave blank for LAN)" />
            </div>
          </div>

          {/* Docker */}
          <div className="card">
            <div className="card-header"><h3><Container size={16} /> Docker</h3></div>
            <div className="form-group">
              <label>Docker API Endpoint<InfoTip text="Internal socket-proxy origin used for container monitoring and approved actions." /></label>
              <input value={settings.docker_socket || ''} onChange={e => update('docker_socket', e.target.value)} placeholder="http://docker-socket-proxy:2375" />
            </div>
            <div className="form-group">
              <label>Metrics Poll Interval (seconds)<InfoTip text="How often to collect CPU, memory, and network stats from running containers. Lower values = more detail but more disk usage." /></label>
              <input type="number" value={settings.metrics_poll_interval || '30'} onChange={e => update('metrics_poll_interval', e.target.value)} min="10" max="300" />
            </div>
            <div className="form-group">
              <label>Metrics Retention (hours)<InfoTip text="How long to keep container metric history. Older data is automatically purged." /></label>
              <input type="number" value={settings.metrics_retention_hours || '24'} onChange={e => update('metrics_retention_hours', e.target.value)} min="1" max="168" />
            </div>
          </div>

          <div className="card" style={{ gridColumn: '1 / -1' }}>
            <div className="card-header"><h3><HardDrive size={16} /> Backup data retention</h3></div>
            <div className="form-row">
              <div className="form-group">
                <label>Per-file run details (days)</label>
                <input type="number" min="1" max="3650" value={settings.run_files_retention_days || '30'} onChange={event => update('run_files_retention_days', event.target.value)} />
              </div>
              <div className="form-group">
                <label>Run summaries (days)</label>
                <input type="number" min="1" max="3650" value={settings.run_history_retention_days || '365'} onChange={event => update('run_history_retention_days', event.target.value)} />
              </div>
              <div className="form-group">
                <label>Routine peer audit (days)</label>
                <input type="number" min="1" max="3650" value={settings.peer_audit_retention_days || '30'} onChange={event => update('peer_audit_retention_days', event.target.value)} />
              </div>
              <div className="form-group">
                <label>Security peer audit (days)</label>
                <input type="number" min="1" max="3650" value={settings.peer_security_audit_retention_days || '365'} onChange={event => update('peer_security_audit_retention_days', event.target.value)} />
              </div>
              <div className="form-group">
                <label>Authentication audit (days)</label>
                <input type="number" min="1" max="3650" value={settings.auth_audit_retention_days || '365'} onChange={event => update('auth_audit_retention_days', event.target.value)} />
              </div>
            </div>
            <p className="form-hint">Failures and security events use the longer security window. Changes apply on the next six-hour retention cycle or restart.</p>
          </div>

          <div className="card danger-settings" style={{ gridColumn: '1 / -1' }}>
            <div className="card-header"><h3><AlertTriangle size={16} /> Destructive backup behavior</h3></div>
            <label className="toggle-label-sm">
              <input
                type="checkbox"
                checked={settings.ssd_allow_empty_source === '1'}
                onChange={event => update('ssd_allow_empty_source', event.target.checked ? '1' : '0')}
              />
              Allow SSD jobs to sync an empty source
            </label>
            <p className="form-hint">When enabled, an empty or accidentally unmounted source can make rsync delete destination data. Leave this disabled unless an intentionally empty source is a valid state.</p>
          </div>
        </div>
      )}

      {activeTab === 'upgrade' && <UpgradeReadinessWizard />}

      {/* Hidden Drive Picker Modal */}
      {showHiddenDriveModal && (() => {
        const isRemote = hiddenDriveScope === 'remote';
        const currentList = isRemote ? hiddenRemoteDrives : hiddenDrives;
        const addFn = isRemote ? addHiddenRemoteDrive : addHiddenDrive;
        const settingsKey = isRemote ? 'hidden_remote_drives' : 'hidden_drives';
        const unhidden = availableDrives.filter(d => !currentList.includes(d.path));
        const roots = unhidden.filter(d => d.type === 'root');
        const shares = unhidden.filter(d => d.type === 'share');
        return (
        <DialogSurface ariaLabel={`Hide a ${isRemote ? 'remote' : 'local'} drive`} onClose={() => setShowHiddenDriveModal(false)}>
            <div className="modal-header"><h3><EyeOff size={16} /> Hide a {isRemote ? 'Remote' : 'Local'} Drive</h3></div>
            <div className="modal-body">
              {!isRemote && roots.length > 0 && (
                <>
                  <span className="event-group-label" style={{ marginBottom: 'var(--space-xs)', display: 'block' }}>Mount Points</span>
                  <div className="drive-picker-grid">
                    {roots.map(d => (
                      <button key={d.path} type="button" className="drive-picker-item" onClick={() => {
                        update(settingsKey, JSON.stringify([...currentList, d.path]));
                        setShowHiddenDriveModal(false);
                      }}>
                        <HardDrive size={14} />
                        <span className="drive-picker-name">{d.name}</span>
                        <code className="drive-picker-path">{d.path}</code>
                      </button>
                    ))}
                  </div>
                </>
              )}
              {!isRemote && shares.length > 0 && (
                <>
                  <span className="event-group-label" style={{ marginTop: roots.length > 0 ? 'var(--space-md)' : 0, marginBottom: 'var(--space-xs)', display: 'block' }}>Detected Storage</span>
                  <div className="drive-picker-grid">
                    {shares.map(d => (
                      <button key={d.path} type="button" className="drive-picker-item" onClick={() => {
                        update(settingsKey, JSON.stringify([...currentList, d.path]));
                        setShowHiddenDriveModal(false);
                      }}>
                        <Folder size={14} />
                        <span className="drive-picker-name">{d.name}</span>
                        <code className="drive-picker-path">{d.path}</code>
                      </button>
                    ))}
                  </div>
                </>
              )}
              {isRemote && (
                <p className="form-hint" style={{ marginBottom: 'var(--space-md)' }}>
                  Enter the mount point path as it appears on the remote peer (e.g. <code>/mnt/user/Backups</code>).
                </p>
              )}
              {!isRemote && <span className="event-group-label" style={{ marginTop: 'var(--space-md)', marginBottom: 'var(--space-xs)', display: 'block' }}>Custom Path</span>}
              <div className="hidden-drive-add">
                <input
                  value={hiddenDriveInput}
                  onChange={e => setHiddenDriveInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { addFn(); setShowHiddenDriveModal(false); } }}
                  placeholder={isRemote ? '/mnt/user/ShareName' : '/mnt/point'}
                  autoFocus
                />
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => { addFn(); setShowHiddenDriveModal(false); }}>Add</button>
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-ghost" onClick={() => setShowHiddenDriveModal(false)}>Cancel</button>
            </div>
        </DialogSurface>
        );
      })()}

      {/* Floating unsaved changes bar */}
      <div className="unsaved-bar" style={{ bottom: hasChanges && activeTab !== 'upgrade' ? 24 : -120 }}>
        <span className="unsaved-label">You have unsaved changes</span>
        <button className="btn btn-ghost btn-sm" onClick={handleDiscard}><Undo2 size={14} /> Discard</button>
        <button className="btn btn-primary btn-sm" onClick={handleSave}>
          {saved ? <><CheckCircle size={14} /> Saved</> : <><Save size={14} /> Save</>}
        </button>
      </div>

      {/* ntfy Configuration Modal */}
      {showNtfyConfig && (
        <DialogSurface ariaLabel="ntfy.sh configuration" onClose={() => setShowNtfyConfig(false)}>
            <div className="modal-header">
              <h3>ntfy.sh Configuration</h3>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label>Server URL</label>
                <input value={settings.ntfy_server || ''} onChange={e => update('ntfy_server', e.target.value)} placeholder="https://ntfy.sh" />
                <span className="form-hint">Default: https://ntfy.sh — or your self-hosted server URL</span>
              </div>
              <div className="form-group">
                <label>Topic</label>
                <input value={settings.ntfy_topic || ''} onChange={e => update('ntfy_topic', e.target.value)} placeholder="redman-notifications" />
                <span className="form-hint">Keep it unique and hard to guess</span>
              </div>
              <div className="form-group">
                <label>Authentication</label>
                <select value={settings.ntfy_auth_type || 'none'} onChange={e => update('ntfy_auth_type', e.target.value)}>
                  <option value="none">None</option>
                  <option value="token">Access Token</option>
                  <option value="basic">Username & Password</option>
                </select>
              </div>
              {settings.ntfy_auth_type === 'token' && (
                <div className="form-group">
                  <label>Access Token</label>
                  <div className="token-input">
                    <input
                      type={showTokens.ntfy_auth_token ? 'text' : 'password'}
                      value={settings.ntfy_auth_token || ''}
                      onChange={e => update('ntfy_auth_token', e.target.value)}
                      placeholder="tk_..."
                    />
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => toggleShow('ntfy_auth_token')}>
                      {showTokens.ntfy_auth_token ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                </div>
              )}
              {settings.ntfy_auth_type === 'basic' && (
                <>
                  <div className="form-group">
                    <label>Username</label>
                    <input value={settings.ntfy_username || ''} onChange={e => update('ntfy_username', e.target.value)} />
                  </div>
                  <div className="form-group">
                    <label>Password</label>
                    <div className="token-input">
                      <input
                        type={showTokens.ntfy_password ? 'text' : 'password'}
                        value={settings.ntfy_password || ''}
                        onChange={e => update('ntfy_password', e.target.value)}
                      />
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => toggleShow('ntfy_password')}>
                        {showTokens.ntfy_password ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-primary" onClick={() => setShowNtfyConfig(false)}>Done</button>
            </div>
        </DialogSurface>
      )}
    </div>
  );
}

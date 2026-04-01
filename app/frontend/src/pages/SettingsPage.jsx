import { useState, useEffect, useCallback } from 'react';
import { getSettings, saveSettings, testNtfy, testBrowserNotify, testImmichConnection, getSshStatus, generateSshKey, authorizeLocalSsh, testSshConnection } from '../api/index.js';
import {
  Settings, Bell, Link, Container, Camera, Save, Eye, EyeOff, Undo2,
  CheckCircle, XCircle, AlertTriangle, Info, Key, Copy, Shield, Terminal, Send,
} from 'lucide-react';
import PillTabs from '../components/PillTabs.jsx';
import './SettingsPage.css';

const SETTINGS_TABS = [
  { label: 'General', value: 'general' },
  { label: 'Notifications', value: 'notifications' },
  { label: 'Integrations', value: 'integrations' },
  { label: 'Infrastructure', value: 'infrastructure' },
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
  const [ssh, setSsh] = useState({ keyExists: false, publicKey: null });
  const [sshTestResult, setSshTestResult] = useState(null);
  const [sshTestHost, setSshTestHost] = useState('');
  const [sshTestUser, setSshTestUser] = useState('root');
  const [sshGenerating, setSshGenerating] = useState(false);
  const [sshCopied, setSshCopied] = useState(false);

  useEffect(() => {
    Promise.all([getSettings(), getSshStatus()])
      .then(([s, sshData]) => {
        setSettings(s);
        setSavedSettings(s);
        setSsh(sshData);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const hasChanges = Object.keys(settings).some(k => settings[k] !== savedSettings[k])
    || Object.keys(savedSettings).some(k => settings[k] !== savedSettings[k]);

  const doSave = useCallback(async (s) => {
    try { await saveSettings(s || settings); } catch { /* silent */ }
  }, [settings]);

  // SSH handlers
  async function handleGenerateKey() {
    setSshGenerating(true);
    try {
      const result = await generateSshKey();
      if (result.success) setSsh({ keyExists: true, publicKey: result.publicKey, keyPath: null });
    } catch (err) {
      console.error('Key generation failed:', err);
    }
    setSshGenerating(false);
  }

  async function handleAuthorizeLocalhost() {
    try {
      await authorizeLocalSsh();
      setSshTestResult({ ok: true, message: 'Localhost authorized!' });
      setTimeout(() => setSshTestResult(null), 5000);
    } catch (err) {
      setSshTestResult({ ok: false, error: err.message });
    }
  }

  async function handleSshTest() {
    if (!sshTestHost) return;
    setSshTestResult(null);
    const result = await testSshConnection({ host: sshTestHost, user: sshTestUser || 'root', port: 22 });
    setSshTestResult(result);
  }

  function copyPublicKey() {
    if (ssh.publicKey) {
      navigator.clipboard.writeText(ssh.publicKey);
      setSshCopied(true);
      setTimeout(() => setSshCopied(false), 3000);
    }
  }

  async function handleSave() {
    await saveSettings(settings);
    setSavedSettings({ ...settings });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
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
    await doSave();
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
    await doSave();
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
      await saveSettings({ ...settings, browser_notify_enabled: 'true' });
      try {
        await testBrowserNotify();
        setBrowserTestResult('sent');
        setTimeout(() => setBrowserTestResult(null), 5000);
      } catch { /* silent */ }
    }
  }

  async function handleNtfyToggle(enabled) {
    update('ntfy_enabled', enabled ? 'true' : 'false');
    if (enabled) {
      await saveSettings({ ...settings, ntfy_enabled: 'true' });
      try {
        const result = await testNtfy();
        setNtfyTestResult(result.success ? 'sent' : 'failed');
        setTimeout(() => setNtfyTestResult(null), 5000);
      } catch { /* silent */ }
    }
  }

  async function handleImmichTest() {
    setImmichTestResult(null);
    await doSave();
    try {
      const result = await testImmichConnection();
      setImmichTestResult(result);
    } catch (err) {
      setImmichTestResult({ ok: false, error: err.message });
    }
  }

  const notifyDisabled = settings.ntfy_enabled !== 'true' && settings.browser_notify_enabled !== 'true';
  const progressIdx = PROGRESS_TICKS.indexOf(parseInt(settings.ntfy_progress_interval || '60'));
  const progressSliderIdx = progressIdx >= 0 ? progressIdx : 0;

  if (loading) return <div className="empty-state"><p>Loading...</p></div>;

  return (
    <div className="settings-page">
      <div className="page-header">
        <div>
          <h1><Settings size={24} /> Settings</h1>
          <p className="page-subtitle">Configure RedMan instance settings</p>
        </div>
      </div>

      <PillTabs tabs={SETTINGS_TABS} active={activeTab} onChange={setActiveTab} />

      {/* ── General ── */}
      {activeTab === 'general' && (
        <div className="card">
          <div className="card-header"><h3><Settings size={16} /> General</h3></div>
          <div className="form-group">
            <label>Instance Name</label>
            <input value={settings.instance_name || ''} onChange={e => update('instance_name', e.target.value)} placeholder="RedMan" />
            <span className="form-hint">Displayed in the peer API health response and notifications</span>
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
                  Browser Notifications
                </label>
                <div className="notify-channel-actions">
                  <button type="button" className="btn btn-ghost btn-sm" onClick={handleBrowserTest}>Test</button>
                  {browserTestResult === 'sent' && <span className="test-ok"><CheckCircle size={14} /> Sent!</span>}
                  {browserTestResult === 'failed' && <span className="test-fail"><XCircle size={14} /> Failed</span>}
                </div>
              </div>
              <span className="form-hint">Native desktop & mobile push notifications (requires browser permission)</span>
              {'Notification' in window && Notification.permission === 'denied' && (
                <div className="alert alert-error" style={{ marginTop: 'var(--space-sm)', padding: 'var(--space-sm)' }}>
                  <AlertTriangle size={14} /> Browser notifications are blocked. Allow them in your browser settings.
                </div>
              )}
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
                  ntfy.sh
                </label>
                <div className="notify-channel-actions">
                  <button type="button" className="btn btn-ghost btn-sm" onClick={handleNtfyTest}>Test</button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowNtfyConfig(true)}>Configure</button>
                  {ntfyTestResult === 'sent' && <span className="test-ok"><CheckCircle size={14} /> Sent!</span>}
                  {ntfyTestResult === 'failed' && <span className="test-fail"><XCircle size={14} /> Failed</span>}
                </div>
              </div>
              {settings.ntfy_topic && <span className="form-hint">Topic: {settings.ntfy_topic}</span>}
              {!settings.ntfy_topic && <span className="form-hint">Push notifications via ntfy.sh (self-hosted or public)</span>}
            </div>
          </div>

          {/* Events */}
          <div className="card">
            <div className="card-header"><h3><Send size={16} /> Events</h3></div>
            <p className="form-hint" style={{ marginBottom: 'var(--space-md)' }}>
              Choose which events trigger notifications.
              {notifyDisabled && <em> Enable at least one channel to activate.</em>}
            </p>

            <div className="event-toggles">
              <span className="event-group-label">Backup Jobs</span>
              <span className="form-hint" style={{ marginBottom: 'var(--space-sm)' }}>SSD Backup, Hyper Backup, and Rclone Sync jobs</span>
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

      {/* ── Integrations ── */}
      {activeTab === 'integrations' && (
        <div className="settings-cards-grid">
          {/* Immich */}
          <div className="card">
            <div className="card-header"><h3><Camera size={16} /> Immich</h3></div>
            <div className="form-group">
              <label>Server URL</label>
              <input value={settings.immich_server_url || ''} onChange={e => update('immich_server_url', e.target.value)} placeholder="http://immich:2283" />
            </div>
            <div className="form-group">
              <label>API Key</label>
              <div className="token-input">
                <input
                  type={showTokens.immich_api_key ? 'text' : 'password'}
                  value={settings.immich_api_key || ''}
                  onChange={e => update('immich_api_key', e.target.value)}
                  placeholder="Your Immich API key"
                />
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => toggleShow('immich_api_key')}>
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
            <div className="alert alert-info" style={{ display: 'flex', gap: 'var(--space-sm)', alignItems: 'flex-start' }}>
              <Info size={16} style={{ flexShrink: 0, marginTop: 2 }} />
              <div>
                <strong>Mount propagation required</strong> — For drive detection to work inside Docker, mount <code>/mnt/disks</code> with <code>rslave</code> propagation in your <code>docker-compose.yml</code>.
              </div>
            </div>
          </div>

          {/* Peer API */}
          <div className="card">
            <div className="card-header"><h3><Link size={16} /> Peer API (Hyper Backup)</h3></div>
            <div className="form-group">
              <label>Peer API Port</label>
              <input type="number" value={settings.peer_api_port || '8091'} onChange={e => update('peer_api_port', e.target.value)} />
              <span className="form-hint">Requires restart to take effect</span>
            </div>
            <div className="form-group">
              <label>Peer API Key</label>
              <div className="token-input">
                <input
                  type={showTokens.peer_api_key ? 'text' : 'password'}
                  value={settings.peer_api_key || ''}
                  onChange={e => update('peer_api_key', e.target.value)}
                  placeholder="Shared secret for peer authentication"
                />
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => toggleShow('peer_api_key')}>
                  {showTokens.peer_api_key ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
              <span className="form-hint">Must match the API key configured on the remote RedMan instance</span>
            </div>
          </div>
        </div>
      )}

      {/* ── Infrastructure ── */}
      {activeTab === 'infrastructure' && (
        <div className="settings-cards-grid">
          {/* SSH Keys */}
          <div className="card ssh-setup">
            <div className="card-header"><h3><Key size={16} /> SSH Keys</h3></div>
            <p className="form-hint" style={{ marginBottom: 'var(--space-md)' }}>Used by Hyper Backup for rsync over SSH to remote hosts.</p>
            {!ssh.keyExists ? (
              <div className="ssh-no-key">
                <p className="form-hint">No SSH key found. Generate one to enable Hyper Backup.</p>
                <button type="button" className="btn btn-primary btn-sm" onClick={handleGenerateKey} disabled={sshGenerating}>
                  {sshGenerating ? 'Generating...' : <><Key size={14} /> Generate SSH Key</>}
                </button>
              </div>
            ) : (
              <div className="ssh-key-info">
                <div className="ssh-status-row">
                  <span className="ssh-status-ok"><CheckCircle size={14} /> SSH key configured</span>
                </div>
                <div className="form-group" style={{ marginTop: 'var(--space-sm)' }}>
                  <label>Public Key <small>(add this to remote hosts' <code>~/.ssh/authorized_keys</code>)</small></label>
                  <div className="ssh-pubkey-row">
                    <code className="ssh-pubkey">{ssh.publicKey}</code>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={copyPublicKey} title="Copy to clipboard">
                      {sshCopied ? <CheckCircle size={14} /> : <Copy size={14} />}
                    </button>
                  </div>
                </div>
                <div className="ssh-actions">
                  <div className="ssh-test-row">
                    <input
                      placeholder="Host to test (e.g. localhost)"
                      value={sshTestHost}
                      onChange={e => setSshTestHost(e.target.value)}
                      style={{ maxWidth: '200px' }}
                    />
                    <input
                      placeholder="User"
                      value={sshTestUser}
                      onChange={e => setSshTestUser(e.target.value)}
                      style={{ maxWidth: '120px' }}
                    />
                    <button type="button" className="btn btn-secondary btn-sm" onClick={handleSshTest} disabled={!sshTestHost}>
                      <Terminal size={14} /> Test SSH
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={handleAuthorizeLocalhost} title="Add key to local authorized_keys for testing">
                      <Shield size={14} /> Authorize Localhost
                    </button>
                  </div>
                  {sshTestResult && (
                    <div className={`test-result ${sshTestResult.ok ? 'success' : 'failure'}`} style={{ marginTop: 'var(--space-xs)' }}>
                      {sshTestResult.ok
                        ? <><CheckCircle size={14} /> {sshTestResult.message || 'SSH connection successful!'}</>
                        : <><XCircle size={14} /> {sshTestResult.error}</>}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Docker */}
          <div className="card">
            <div className="card-header"><h3><Container size={16} /> Docker</h3></div>
            <div className="form-group">
              <label>Docker Socket Path</label>
              <input value={settings.docker_socket || ''} onChange={e => update('docker_socket', e.target.value)} placeholder="/var/run/docker.sock" />
            </div>
            <div className="form-group">
              <label>Metrics Poll Interval (seconds)</label>
              <input type="number" value={settings.metrics_poll_interval || '30'} onChange={e => update('metrics_poll_interval', e.target.value)} min="10" max="300" />
            </div>
            <div className="form-group">
              <label>Metrics Retention (hours)</label>
              <input type="number" value={settings.metrics_retention_hours || '24'} onChange={e => update('metrics_retention_hours', e.target.value)} min="1" max="168" />
            </div>
          </div>
        </div>
      )}

      {/* Floating unsaved changes bar */}
      <div className="unsaved-bar" style={{ bottom: hasChanges ? 24 : -120 }}>
        <span className="unsaved-label">You have unsaved changes</span>
        <button className="btn btn-ghost btn-sm" onClick={handleDiscard}><Undo2 size={14} /> Discard</button>
        <button className="btn btn-primary btn-sm" onClick={handleSave}>
          {saved ? <><CheckCircle size={14} /> Saved</> : <><Save size={14} /> Save</>}
        </button>
      </div>

      {/* ntfy Configuration Modal */}
      {showNtfyConfig && (
        <div className="modal-overlay" onClick={() => setShowNtfyConfig(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>ntfy.sh Configuration</h3>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label>Server URL</label>
                <input value={settings.ntfy_server || settings.ntfy_url || ''} onChange={e => {
                  update('ntfy_server', e.target.value);
                  update('ntfy_url', e.target.value);
                }} placeholder="https://ntfy.sh" />
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
                      onChange={e => {
                        update('ntfy_auth_token', e.target.value);
                        update('ntfy_token', e.target.value);
                      }}
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
          </div>
        </div>
      )}
    </div>
  );
}

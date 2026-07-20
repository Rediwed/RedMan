import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle,
  Clipboard,
  DatabaseBackup,
  FileCog,
  HardDrive,
  Loader2,
  RefreshCw,
  ServerCog,
  ShieldCheck,
  SlidersHorizontal,
  Terminal,
  XCircle,
} from 'lucide-react';
import {
  createUpgradeFinalConfig,
  createUpgradeHostPlan,
  createUpgradeReadinessBackup,
  getUpgradeReadiness,
  remediateUpgradeReadinessIssue,
} from '../api/index.js';
import './UpgradeReadinessWizard.css';

const STEPS = [
  { label: 'Assess', icon: ShieldCheck },
  { label: 'Back up', icon: DatabaseBackup },
  { label: 'Prepare host', icon: ServerCog },
  { label: 'Configure', icon: FileCog },
  { label: 'Ready', icon: CheckCircle },
];

function validIpv4(value) {
  const parts = value.split('.');
  return parts.length === 4 && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function validExactIp(value) {
  const [address, prefix] = String(value || '').trim().split('/');
  if (validIpv4(address)) return !prefix || prefix === '32';
  if (/^[0-9A-Fa-f:]+$/.test(address) && address.includes(':')) return !prefix || prefix === '128';
  return false;
}

function validPrivatePeer(value) {
  const address = String(value || '').trim().replace(/^\[|\]$/g, '');
  if (validIpv4(address)) {
    const parts = address.split('.').map(Number);
    return parts[0] === 10 || parts[0] === 127
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168)
      || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
      || (parts[0] === 169 && parts[1] === 254);
  }
  return address === '::1' || /^(?:fc|fd|fe[89ab])[0-9A-Fa-f:]*$/i.test(address);
}

function validHttpsOrigin(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && !url.username && !url.password
      && url.pathname === '/' && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function validTimezone(value) {
  const timezone = String(value || '').trim();
  if (!/^[A-Za-z][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9._+-]+)*$/.test(timezone)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

function canonicalHostPath(value) {
  const raw = String(value || '').trim();
  if (!/^\/[A-Za-z0-9._/-]+$/.test(raw) || raw.split('/').includes('..')) return null;
  const normalized = `/${raw.split('/').filter(part => part && part !== '.').join('/')}`;
  return normalized === '/' ? null : normalized;
}

function validHostPath(value) {
  return canonicalHostPath(value) !== null;
}

function isAllUnraidShares(value) {
  return canonicalHostPath(value) === '/mnt/user';
}

function CheckIcon({ status }) {
  if (status === 'pass') return <CheckCircle size={18} />;
  if (status === 'warning') return <AlertTriangle size={18} />;
  return <XCircle size={18} />;
}

function CopyButton({ value, label = 'Copy' }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  return (
    <button type="button" className="btn btn-secondary btn-sm" onClick={copy} disabled={!value}>
      {copied ? <Check size={14} /> : <Clipboard size={14} />}
      {copied ? 'Copied' : label}
    </button>
  );
}

export default function UpgradeReadinessWizard() {
  const [step, setStep] = useState(0);
  const [assessment, setAssessment] = useState(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [hostPlan, setHostPlan] = useState(null);
  const [finalConfig, setFinalConfig] = useState('');
  const [hostForm, setHostForm] = useState({
    platform: null,
    container: null,
    dataDir: null,
    roots: null,
  });
  const [configForm, setConfigForm] = useState({
    authMode: null,
    publicOrigin: null,
    trustedProxy: null,
    peerHost: null,
    dataPath: null,
    storagePath: null,
    mediaPath: null,
    timezone: null,
    allowBroadStorage: null,
    dockerMonitoring: null,
  });

  async function refresh() {
    setLoading(true);
    setError('');
    try {
      const result = await getUpgradeReadiness();
      setAssessment(result);
      const saved = result.finalConfiguration?.status === 'ready'
        ? result.finalConfiguration.receipt.configuration
        : null;
      const detected = saved || result.configurationDefaults || {};
      setConfigForm(current => ({
        authMode: current.authMode ?? detected.authMode ?? 'proxy',
        publicOrigin: current.publicOrigin ?? detected.publicOrigin ?? '',
        trustedProxy: current.trustedProxy ?? detected.trustedProxy ?? '',
        peerHost: current.peerHost ?? detected.peerHost ?? '',
        dataPath: current.dataPath ?? detected.dataPath ?? '',
        storagePath: current.storagePath ?? detected.storagePath ?? '',
        mediaPath: current.mediaPath ?? detected.mediaPath ?? '',
        timezone: current.timezone ?? detected.timezone ?? result.suggestedTimezone ?? 'UTC',
        allowBroadStorage: current.allowBroadStorage ?? detected.allowBroadStorage ?? false,
        dockerMonitoring: current.dockerMonitoring ?? detected.dockerMonitoring ?? false,
      }));
      setHostForm(current => ({
        platform: current.platform ?? result.configurationDefaults?.platform ?? 'unraid',
        container: current.container ?? result.configurationDefaults?.container ?? 'redman',
        dataDir: current.dataDir ?? result.configurationDefaults?.dataPath ?? result.dataDir,
        roots: current.roots ?? (result.configurationDefaults?.backupRoots || []).join('\n'),
      }));
      setFinalConfig(result.finalConfiguration?.status === 'ready'
        ? result.finalConfiguration.receipt.env
        : '');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(); }, []);

  const checks = assessment?.checks || [];
  const backupReady = assessment?.applicationBackup?.status === 'ready';
  const hostReady = assessment?.hostPreparation?.status === 'ready';
  const activeWorkBlocked = checks.some(item => item.id === 'active-runs' && item.status === 'blocked');
  const integrityBlocked = checks.some(item => item.id === 'database-integrity' && item.status === 'blocked');
  const configurationReady = assessment?.finalConfiguration?.status === 'ready' || Boolean(finalConfig);
  const finalReady = backupReady && hostReady && configurationReady && !activeWorkBlocked && !integrityBlocked;
  const nextStep = integrityBlocked || activeWorkBlocked ? 0
    : !backupReady ? 1
      : !hostReady ? 2
        : !configurationReady ? 3 : 4;
  const roots = useMemo(() => String(hostForm.roots || '')
    .split('\n')
    .map(value => value.trim())
    .filter(Boolean), [hostForm.roots]);
  const configIssues = useMemo(() => ({
    publicOrigin: validHttpsOrigin(configForm.publicOrigin) ? '' : 'Use one exact HTTPS origin without a path.',
    trustedProxy: validExactIp(configForm.trustedProxy) ? '' : 'Use one exact IPv4 /32 or IPv6 /128 host.',
    peerHost: validPrivatePeer(configForm.peerHost) ? '' : 'Use a numeric private or VPN IP reachable by the peer.',
    timezone: validTimezone(configForm.timezone) ? '' : 'Use UTC or a valid IANA zone such as Europe/Amsterdam.',
    dataPath: !validHostPath(configForm.dataPath)
      ? 'Use a non-root absolute host path.'
      : (isAllUnraidShares(configForm.dataPath) ? 'App-data may not be all Unraid user shares.' : ''),
    storagePath: !validHostPath(configForm.storagePath)
      ? 'Use a non-root absolute host path.'
      : (isAllUnraidShares(configForm.storagePath) && !configForm.allowBroadStorage
          ? 'Confirm broad scope before authorizing every Unraid share.' : ''),
    mediaPath: !validHostPath(configForm.mediaPath)
      ? 'Use a non-root absolute host path.'
      : (isAllUnraidShares(configForm.mediaPath) ? 'Media scope may not be all Unraid user shares.' : ''),
  }), [configForm]);
  const configValid = Object.values(configIssues).every(value => !value);

  function useDetectedConfiguration() {
    const detected = assessment?.configurationDefaults;
    if (!detected) return;
    setConfigForm({
      authMode: detected.authMode,
      publicOrigin: detected.publicOrigin,
      trustedProxy: detected.trustedProxy,
      peerHost: detected.peerHost,
      dataPath: detected.dataPath,
      storagePath: detected.storagePath,
      mediaPath: detected.mediaPath,
      timezone: detected.timezone,
      allowBroadStorage: detected.allowBroadStorage,
      dockerMonitoring: detected.dockerMonitoring,
    });
  }

  async function createBackup() {
    setWorking(true);
    setError('');
    try {
      await createUpgradeReadinessBackup();
      await refresh();
      setStep(2);
    } catch (err) {
      setError(err.message);
    } finally {
      setWorking(false);
    }
  }

  async function resolveIssue(item) {
    const action = item.resolution?.action;
    if (!action) return;
    if (action.type === 'step') {
      setStep(action.step);
      return;
    }
    if (action.type === 'refresh') {
      await refresh();
      return;
    }
    if (action.type !== 'remediate') return;
    setWorking(true);
    setError('');
    try {
      await remediateUpgradeReadinessIssue(action.issueId);
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setWorking(false);
    }
  }

  async function generateHostPlan() {
    setWorking(true);
    setError('');
    try {
      const result = await createUpgradeHostPlan({
        platform: hostForm.platform,
        container: hostForm.container,
        dataDir: hostForm.dataDir,
        backupRoots: roots,
      });
      setHostPlan(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setWorking(false);
    }
  }

  async function generateFinalConfig() {
    setWorking(true);
    setError('');
    try {
      const result = await createUpgradeFinalConfig(configForm);
      setFinalConfig(result.env);
      await refresh();
      setStep(4);
    } catch (err) {
      setError(err.message);
    } finally {
      setWorking(false);
    }
  }

  function switchPlatform(platform) {
    const unraid = platform === 'unraid';
    setHostForm(current => ({
      ...current,
      platform,
      dataDir: unraid ? '/mnt/user/appdata/redman' : '/srv/redman',
      roots: '',
    }));
    setConfigForm(current => ({
      ...current,
      dataPath: unraid ? '/mnt/user/appdata/redman' : '/srv/redman',
      storagePath: '',
      mediaPath: '',
      allowBroadStorage: false,
    }));
    setHostPlan(null);
  }

  return (
    <section className="upgrade-wizard" aria-labelledby="upgrade-wizard-title">
      <header className="upgrade-wizard-header">
        <div>
          <p className="upgrade-wizard-kicker">Hardened release bridge</p>
          <h2 id="upgrade-wizard-title">Upgrade readiness</h2>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={refresh} disabled={loading || working}>
          <RefreshCw size={15} className={loading ? 'spin' : ''} /> Refresh
        </button>
      </header>

      <div className="upgrade-stepper" role="tablist" aria-label="Upgrade steps">
        {STEPS.map((item, index) => {
          const Icon = item.icon;
          return (
            <button
              key={item.label}
              type="button"
              role="tab"
              aria-selected={step === index}
              className={step === index ? 'active' : ''}
              onClick={() => setStep(index)}
            >
              <span>{index + 1}</span>
              <Icon size={15} />
              {item.label}
            </button>
          );
        })}
      </div>

      {error && <div className="upgrade-error"><XCircle size={17} /> {error}</div>}

      {loading && !assessment ? (
        <div className="upgrade-loading"><Loader2 size={22} className="spin" /> Assessing this installation...</div>
      ) : null}

      {step === 0 && assessment && (
        <div className="upgrade-stage">
          <div className="upgrade-stage-heading">
            <div>
              <h3>Current installation</h3>
              <p>Read-only checks against the running bridge release.</p>
            </div>
            <div className="upgrade-score" aria-label="Assessment summary">
              <span className="pass">{assessment.summary.pass} ready</span>
              <span className="warning">{assessment.summary.warning} planned</span>
              <span className="blocked">{assessment.summary.blocked} blocked</span>
            </div>
          </div>
          <div className="upgrade-next-action">
            <div>
              <span>Next action</span>
              <strong>{nextStep === 0 ? 'Resolve the blocking check'
                : nextStep === 1 ? 'Create the safety backup'
                  : nextStep === 2 ? 'Prepare this NAS'
                    : nextStep === 3 ? 'Confirm the detected setup'
                      : 'No preparation work remains'}</strong>
              <p>{nextStep === 0 ? 'Open the technical checks below and resolve the item marked blocked.'
                : nextStep === 1 ? 'RedMan creates and verifies this automatically.'
                  : nextStep === 2 ? 'Generate one command and run it in the NAS terminal.'
                    : nextStep === 3 ? 'Most values are already detected; confirm this NAS private IP.'
                      : 'Open Ready to see what happens next.'}</p>
            </div>
            {nextStep > 0 && (
              <button type="button" className="btn btn-primary" onClick={() => setStep(nextStep)}>
                Continue <ArrowRight size={15} />
              </button>
            )}
          </div>
          <details className="upgrade-details" defaultOpen={assessment.summary.blocked > 0}>
            <summary>View {checks.length} technical checks</summary>
            <div className="upgrade-check-list">
              {checks.map(item => (
                <div key={item.id} className={`upgrade-check ${item.status}`}>
                  <CheckIcon status={item.status} />
                  <div>
                    <strong>{item.label}</strong>
                    <p>{item.detail}</p>
                    {item.resolution && (
                      <div className="upgrade-resolution">
                        <span className={`upgrade-resolution-timing ${item.resolution.timing}`}>{item.resolution.timing.replace('-', ' ')}</span>
                        <strong>{item.resolution.title}</strong>
                        <ol>{item.resolution.steps.map(instruction => <li key={instruction}>{instruction}</li>)}</ol>
                        {item.resolution.action && (
                          <button type="button" className="btn btn-secondary btn-sm" onClick={() => resolveIssue(item)} disabled={working || loading}>
                            {item.resolution.action.type === 'remediate' ? <ShieldCheck size={14} /> : <FileCog size={14} />}
                            {item.resolution.action.label}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </details>
        </div>
      )}

      {step === 1 && (
        <div className="upgrade-stage upgrade-backup-stage">
          <DatabaseBackup size={34} />
          <div>
            <h3>Verified application backup</h3>
            <p>Creates an online SQLite backup, runs an integrity check, keeps the three latest bridge backups, and leaves the running database untouched.</p>
          </div>
          {backupReady && assessment?.applicationBackup?.receipt && (
            <div className="upgrade-result pass">
              <CheckCircle size={17} />
              <div><strong>Backup verified</strong><code>{assessment.applicationBackup.receipt.backupPath}</code></div>
            </div>
          )}
          <div className="upgrade-actions">
            <button type="button" className="btn btn-primary" onClick={createBackup} disabled={working || activeWorkBlocked || integrityBlocked}>
              {working ? <Loader2 size={15} className="spin" /> : <DatabaseBackup size={15} />}
              {backupReady ? 'Create fresh backup' : 'Create verified backup'}
            </button>
            {backupReady && <button type="button" className="btn btn-secondary" onClick={() => setStep(2)}>Continue</button>}
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="upgrade-stage">
          <div className="upgrade-stage-heading">
            <div><h3>Prepare the host</h3><p>The generated command runs on the NAS host; RedMan never receives host-root access.</p></div>
            {hostReady && <span className="upgrade-ready-badge"><CheckCircle size={15} /> Receipt verified</span>}
          </div>
          {hostReady ? (
            <>
              <div className="upgrade-result pass upgrade-host-ready">
                <CheckCircle size={18} />
                <div>
                  <strong>This NAS is already prepared</strong>
                  <p>The restricted backup account and approved roots are recorded in the verified host receipt.</p>
                  <div className="upgrade-code-list">
                    {(assessment.hostPreparation.receipt.backupRoots || []).map(root => <code key={root}>{root}</code>)}
                  </div>
                </div>
              </div>
              <div className="upgrade-actions"><button type="button" className="btn btn-primary" onClick={() => setStep(3)}>Continue <ArrowRight size={15} /></button></div>
            </>
          ) : (
            <>
              <div className="upgrade-form-grid">
                <div className="form-group upgrade-span-2">
                  <label>Where may the other RedMan NAS store backups?</label>
                  <textarea rows="4" value={hostForm.roots ?? ''} onChange={event => setHostForm({ ...hostForm, roots: event.target.value })} />
                  <span className="upgrade-field-hint">One narrow host directory per line. RedMan will restrict the backup account to these locations.</span>
                  {assessment?.pathCandidates?.length > 0 && (
                    <button type="button" className="btn btn-ghost btn-sm upgrade-detected-roots" onClick={() => setHostForm({ ...hostForm, roots: assessment.pathCandidates.join('\n') })}>
                      Use {assessment.pathCandidates.length} detected path{assessment.pathCandidates.length === 1 ? '' : 's'}
                    </button>
                  )}
                </div>
              </div>
              <details className="upgrade-details upgrade-advanced">
                <summary><SlidersHorizontal size={15} /> Advanced host settings</summary>
                <div className="upgrade-form-grid">
                  <div className="form-group">
                    <label>Host platform</label>
                    <div className="upgrade-segments">
                      <button type="button" className={hostForm.platform === 'unraid' ? 'active' : ''} onClick={() => switchPlatform('unraid')}>Unraid</button>
                      <button type="button" className={hostForm.platform === 'linux' ? 'active' : ''} onClick={() => switchPlatform('linux')}>Generic Linux</button>
                    </div>
                  </div>
                  <div className="form-group"><label>Container name</label><input value={hostForm.container ?? ''} onChange={event => setHostForm({ ...hostForm, container: event.target.value })} /></div>
                  <div className="form-group upgrade-span-2"><label>Host app-data path</label><input value={hostForm.dataDir ?? ''} onChange={event => setHostForm({ ...hostForm, dataDir: event.target.value })} /></div>
                </div>
              </details>
              <div className="upgrade-actions">
                <button type="button" className="btn btn-primary" onClick={generateHostPlan} disabled={working || !backupReady || roots.length === 0}>
                  <Terminal size={15} /> Generate host command
                </button>
                <button type="button" className="btn btn-secondary" onClick={refresh} disabled={working}><RefreshCw size={15} /> Check command result</button>
              </div>
              {hostPlan && (
                <div className="upgrade-command">
                  <div><strong>Run once in the host terminal</strong><CopyButton value={hostPlan.command} label="Copy command" /></div>
                  <pre>{hostPlan.command}</pre>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {step === 3 && (
        <div className="upgrade-stage">
          <div className="upgrade-stage-heading">
            <div><h3>Confirm the detected setup</h3><p>RedMan found the existing bridge, proxy, paths, timezone, and Docker preference.</p></div>
            <span className="upgrade-ready-badge"><ShieldCheck size={15} /> Detected locally</span>
          </div>
          <div className="upgrade-detected-list" aria-label="Detected setup">
            <div><span>Public address</span><strong>{configForm.publicOrigin || 'Not detected'}</strong></div>
            <div><span>Sign-in</span><strong>{configForm.authMode === 'proxy' ? 'Existing reverse proxy' : 'Native RedMan login'}</strong></div>
            <div><span>App data</span><strong>{configForm.dataPath || 'Not detected'}</strong></div>
            <div><span>Storage</span><strong>{configForm.storagePath || 'Not detected'}</strong></div>
            <div><span>Timezone</span><strong>{configForm.timezone || 'Not detected'}</strong></div>
            <div><span>Docker monitoring</span><strong>{configForm.dockerMonitoring ? 'Enabled with restricted proxies' : 'Disabled'}</strong></div>
          </div>
          <div className="upgrade-form-grid">
            <div className="form-group upgrade-span-2 upgrade-primary-field">
              <label htmlFor="upgrade-peer-host">This NAS private IP</label>
              <input id="upgrade-peer-host" aria-invalid={Boolean(configIssues.peerHost)} placeholder="192.168.70.2" value={configForm.peerHost ?? ''} onChange={event => setConfigForm({ ...configForm, peerHost: event.target.value })} />
              <span className="upgrade-field-hint">{configIssues.peerHost || 'The address the other RedMan NAS uses to reach this NAS. Do not enter the other NAS address.'}</span>
            </div>
            {configIssues.publicOrigin && <div className="form-group upgrade-span-2"><label>Public RedMan address</label><input aria-invalid="true" placeholder="https://redman.example.com" value={configForm.publicOrigin ?? ''} onChange={event => setConfigForm({ ...configForm, publicOrigin: event.target.value })} /><span className="upgrade-field-hint">{configIssues.publicOrigin}</span></div>}
            {configForm.authMode === 'proxy' && configIssues.trustedProxy && <div className="form-group upgrade-span-2"><label>Reverse proxy source IP</label><input aria-invalid="true" placeholder="172.20.0.5" value={configForm.trustedProxy ?? ''} onChange={event => setConfigForm({ ...configForm, trustedProxy: event.target.value })} /><span className="upgrade-field-hint">{configIssues.trustedProxy}</span></div>}
            {isAllUnraidShares(configForm.storagePath) && (
              <label className="toggle-label upgrade-span-2 upgrade-broad-confirmation">
                <input type="checkbox" className="toggle" checked={Boolean(configForm.allowBroadStorage)} onChange={event => setConfigForm({ ...configForm, allowBroadStorage: event.target.checked })} />
                This RedMan installation intentionally uses backups across multiple Unraid shares
              </label>
            )}
          </div>
          <details className="upgrade-details upgrade-advanced">
            <summary><SlidersHorizontal size={15} /> Review or change advanced settings</summary>
            <div className="upgrade-form-grid">
              <div className="form-group">
                <label>Authentication mode</label>
                <select value={configForm.authMode ?? 'proxy'} onChange={event => setConfigForm({ ...configForm, authMode: event.target.value })}>
                  <option value="proxy">Trusted proxy</option>
                  <option value="local">Native RedMan login</option>
                </select>
              </div>
              <label className="toggle-label upgrade-toggle"><input type="checkbox" className="toggle" checked={Boolean(configForm.dockerMonitoring)} onChange={event => setConfigForm({ ...configForm, dockerMonitoring: event.target.checked })} />Docker monitoring</label>
              <div className="form-group upgrade-span-2"><label>Exact public HTTPS origin</label><input aria-invalid={Boolean(configIssues.publicOrigin)} value={configForm.publicOrigin ?? ''} onChange={event => setConfigForm({ ...configForm, publicOrigin: event.target.value })} /><span className="upgrade-field-hint">{configIssues.publicOrigin || 'Detected from the running bridge.'}</span></div>
              <div className="form-group"><label>Exact proxy source IP</label><input aria-invalid={Boolean(configIssues.trustedProxy)} value={configForm.trustedProxy ?? ''} onChange={event => setConfigForm({ ...configForm, trustedProxy: event.target.value })} /><span className="upgrade-field-hint">{configIssues.trustedProxy || 'The exact source address RedMan sees.'}</span></div>
              <div className="form-group"><label>Timezone</label><input list="redman-timezones" aria-invalid={Boolean(configIssues.timezone)} value={configForm.timezone ?? ''} onChange={event => setConfigForm({ ...configForm, timezone: event.target.value })} /><span className="upgrade-field-hint">{configIssues.timezone}</span></div>
              <datalist id="redman-timezones"><option value="Europe/Amsterdam" /><option value="UTC" /><option value="Europe/London" /><option value="America/New_York" /><option value="Asia/Tokyo" /></datalist>
              <div className="form-group"><label>Host data path</label><input aria-invalid={Boolean(configIssues.dataPath)} value={configForm.dataPath ?? ''} onChange={event => setConfigForm({ ...configForm, dataPath: event.target.value })} /><span className="upgrade-field-hint">{configIssues.dataPath}</span></div>
              <div className="form-group"><label>Host storage path</label><input aria-invalid={Boolean(configIssues.storagePath)} value={configForm.storagePath ?? ''} onChange={event => setConfigForm({ ...configForm, storagePath: event.target.value })} /><span className="upgrade-field-hint">{configIssues.storagePath}</span></div>
              <div className="form-group upgrade-span-2"><label>Host media path</label><input aria-invalid={Boolean(configIssues.mediaPath)} value={configForm.mediaPath ?? ''} onChange={event => setConfigForm({ ...configForm, mediaPath: event.target.value })} /><span className="upgrade-field-hint">{configIssues.mediaPath}</span></div>
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={useDetectedConfiguration}><RefreshCw size={14} /> Reset to detected values</button>
          </details>
          <div className="upgrade-actions">
            <button type="button" className="btn btn-primary" onClick={generateFinalConfig} disabled={working || !hostReady || !configValid}><FileCog size={15} /> Save and show next step</button>
          </div>
        </div>
      )}

      {step === 4 && (
        <div className="upgrade-stage upgrade-finish">
          {finalReady ? <CheckCircle size={46} /> : <AlertTriangle size={46} />}
          <h3>{finalReady ? 'This NAS is ready' : 'Preparation is not complete'}</h3>
          <div className="upgrade-final-gates">
            <span className={backupReady ? 'pass' : 'blocked'}>{backupReady ? <Check size={15} /> : <XCircle size={15} />} Verified database backup</span>
            <span className={hostReady ? 'pass' : 'blocked'}>{hostReady ? <Check size={15} /> : <XCircle size={15} />} Host preparation receipt</span>
            <span className={configurationReady ? 'pass' : 'blocked'}>{configurationReady ? <Check size={15} /> : <XCircle size={15} />} Upgrade configuration saved</span>
            <span className={!activeWorkBlocked ? 'pass' : 'blocked'}>{!activeWorkBlocked ? <Check size={15} /> : <XCircle size={15} />} No active jobs</span>
          </div>
          {finalReady ? (
            <div className="upgrade-next-action upgrade-stop-here">
              <div>
                <span>What now?</span>
                <strong>Leave the readiness bridge running</strong>
                <p>Complete this wizard on the other RedMan NAS. When both NASes show “This NAS is ready”, stop here. No generated command or configuration needs to be applied until the hardened RedMan release is published.</p>
              </div>
            </div>
          ) : (
            <div className="upgrade-next-action">
              <div><span>Next action</span><strong>Complete the missing preparation step</strong><p>The first incomplete gate is linked here.</p></div>
              <button type="button" className="btn btn-primary" onClick={() => setStep(nextStep)}>Continue <ArrowRight size={15} /></button>
            </div>
          )}
          {assessment?.hostPreparation?.receipt?.rollbackDir && (
            <div className="upgrade-rollback"><HardDrive size={19} /><div><strong>Keep this rollback snapshot</strong><code>{assessment.hostPreparation.receipt.rollbackDir}</code><p>Do not delete it until the hardened release and representative jobs are verified.</p></div></div>
          )}
          {configurationReady && finalConfig && (
            <details className="upgrade-details upgrade-saved-config">
              <summary>Saved hardened-release configuration</summary>
              <div className="upgrade-command"><div><strong>Use only during the later cutover</strong><CopyButton value={finalConfig} label="Copy configuration" /></div><pre>{finalConfig}</pre></div>
            </details>
          )}
          <div className="upgrade-actions"><button type="button" className="btn btn-secondary" onClick={refresh}><RefreshCw size={15} /> Recheck all gates</button></div>
        </div>
      )}
    </section>
  );
}

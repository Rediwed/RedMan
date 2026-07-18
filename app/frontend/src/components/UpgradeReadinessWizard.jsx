import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
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
  Terminal,
  XCircle,
} from 'lucide-react';
import {
  createUpgradeFinalConfig,
  createUpgradeHostPlan,
  createUpgradeReadinessBackup,
  getUpgradeReadiness,
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
  const [address, prefix] = value.trim().split('/');
  if (validIpv4(address)) return !prefix || prefix === '32';
  if (/^[0-9A-Fa-f:]+$/.test(address) && address.includes(':')) return !prefix || prefix === '128';
  return false;
}

function validPrivatePeer(value) {
  const address = value.trim().replace(/^\[|\]$/g, '');
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
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      && url.pathname === '/' && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function canonicalHostPath(value) {
  const raw = value.trim();
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
    platform: 'unraid',
    container: 'redman',
    dataDir: '/mnt/user/appdata/redman',
    roots: '',
  });
  const [configForm, setConfigForm] = useState({
    authMode: 'proxy',
    publicOrigin: '',
    trustedProxy: '',
    peerHost: '',
    dataPath: '/mnt/user/appdata/redman',
    storagePath: '',
    mediaPath: '',
    allowBroadStorage: false,
    dockerMonitoring: false,
  });

  async function refresh() {
    setLoading(true);
    setError('');
    try {
      const result = await getUpgradeReadiness();
      setAssessment(result);
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
  const finalReady = backupReady && hostReady && Boolean(finalConfig) && !activeWorkBlocked && !integrityBlocked;
  const roots = useMemo(() => hostForm.roots
    .split('\n')
    .map(value => value.trim())
    .filter(Boolean), [hostForm.roots]);
  const configIssues = useMemo(() => ({
    publicOrigin: validHttpsOrigin(configForm.publicOrigin) ? '' : 'Use one exact HTTPS origin without a path.',
    trustedProxy: validExactIp(configForm.trustedProxy) ? '' : 'Use one exact IPv4 /32 or IPv6 /128 host.',
    peerHost: validPrivatePeer(configForm.peerHost) ? '' : 'Use a numeric private or VPN IP reachable by the peer.',
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
              <span className="warning">{assessment.summary.warning} review</span>
              <span className="blocked">{assessment.summary.blocked} blocked</span>
            </div>
          </div>
          <div className="upgrade-check-list">
            {checks.map(item => (
              <div key={item.id} className={`upgrade-check ${item.status}`}>
                <CheckIcon status={item.status} />
                <div><strong>{item.label}</strong><p>{item.detail}</p></div>
              </div>
            ))}
          </div>
          <div className="upgrade-actions">
            <button type="button" className="btn btn-primary" onClick={() => setStep(1)} disabled={integrityBlocked || activeWorkBlocked}>
              Continue to backup
            </button>
          </div>
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
          <div className="upgrade-form-grid">
            <div className="form-group">
              <label>Host platform</label>
              <div className="upgrade-segments">
                <button type="button" className={hostForm.platform === 'unraid' ? 'active' : ''} onClick={() => switchPlatform('unraid')}>Unraid</button>
                <button type="button" className={hostForm.platform === 'linux' ? 'active' : ''} onClick={() => switchPlatform('linux')}>Generic Linux</button>
              </div>
            </div>
            <div className="form-group">
              <label>Container name</label>
              <input value={hostForm.container} onChange={event => setHostForm({ ...hostForm, container: event.target.value })} />
            </div>
            <div className="form-group upgrade-span-2">
              <label>Host app-data path</label>
              <input value={hostForm.dataDir} onChange={event => setHostForm({ ...hostForm, dataDir: event.target.value })} />
            </div>
            <div className="form-group upgrade-span-2">
              <label>Approved backup roots <small>(one per line)</small></label>
              <textarea rows="4" value={hostForm.roots} onChange={event => setHostForm({ ...hostForm, roots: event.target.value })} />
              <span className="upgrade-field-hint">Choose the narrowest host directories peers may write. Do not use <code>/mnt/user</code> unless every share is intentionally in scope.</span>
              {assessment?.pathCandidates?.length > 0 && (
                <button type="button" className="btn btn-ghost btn-sm upgrade-detected-roots" onClick={() => setHostForm({ ...hostForm, roots: assessment.pathCandidates.join('\n') })}>
                  Use {assessment.pathCandidates.length} detected path{assessment.pathCandidates.length === 1 ? '' : 's'}
                </button>
              )}
            </div>
          </div>
          <div className="upgrade-actions">
            <button type="button" className="btn btn-primary" onClick={generateHostPlan} disabled={working || !backupReady || roots.length === 0}>
              <Terminal size={15} /> Generate host command
            </button>
            <button type="button" className="btn btn-secondary" onClick={refresh} disabled={working}>
              <RefreshCw size={15} /> Check receipt
            </button>
          </div>
          {hostPlan && (
            <div className="upgrade-command">
              <div><strong>Run once in the host terminal</strong><CopyButton value={hostPlan.command} label="Copy command" /></div>
              <pre>{hostPlan.command}</pre>
            </div>
          )}
          {hostReady && (
            <div className="upgrade-actions"><button type="button" className="btn btn-primary" onClick={() => setStep(3)}>Continue to configuration</button></div>
          )}
        </div>
      )}

      {step === 3 && (
        <div className="upgrade-stage">
          <div className="upgrade-stage-heading"><div><h3>Generate final configuration</h3><p>Produces a non-secret environment template for the hardened release.</p></div></div>
          <div className="upgrade-form-grid">
            <div className="form-group">
              <label>Authentication mode</label>
              <select value={configForm.authMode} onChange={event => setConfigForm({ ...configForm, authMode: event.target.value })}>
                <option value="proxy">Trusted proxy</option>
                <option value="local">Native RedMan login</option>
              </select>
            </div>
            <label className="toggle-label upgrade-toggle">
              <input type="checkbox" className="toggle" checked={configForm.dockerMonitoring} onChange={event => setConfigForm({ ...configForm, dockerMonitoring: event.target.checked })} />
              Docker monitoring
            </label>
            <div className="form-group upgrade-span-2"><label>Exact public HTTPS origin</label><input aria-invalid={Boolean(configIssues.publicOrigin)} placeholder="https://redman.example.com" value={configForm.publicOrigin} onChange={event => setConfigForm({ ...configForm, publicOrigin: event.target.value })} /><span className="upgrade-field-hint">{configIssues.publicOrigin || 'Example: https://redman.example.com'}</span></div>
            <div className="form-group"><label>Exact proxy source IP</label><input aria-invalid={Boolean(configIssues.trustedProxy)} placeholder="172.20.0.5" value={configForm.trustedProxy} onChange={event => setConfigForm({ ...configForm, trustedProxy: event.target.value })} /><span className="upgrade-field-hint">{configIssues.trustedProxy || 'The source address RedMan sees from the proxy.'}</span></div>
            <div className="form-group"><label>Private peer SSH IP</label><input aria-invalid={Boolean(configIssues.peerHost)} placeholder="192.168.50.20" value={configForm.peerHost} onChange={event => setConfigForm({ ...configForm, peerHost: event.target.value })} /><span className="upgrade-field-hint">{configIssues.peerHost || 'Advertised to the other RedMan host.'}</span></div>
            <div className="form-group"><label>Host data path</label><input aria-invalid={Boolean(configIssues.dataPath)} value={configForm.dataPath} onChange={event => setConfigForm({ ...configForm, dataPath: event.target.value })} /><span className="upgrade-field-hint">{configIssues.dataPath}</span></div>
            <div className="form-group"><label>Host storage path</label><input aria-invalid={Boolean(configIssues.storagePath)} value={configForm.storagePath} onChange={event => setConfigForm({ ...configForm, storagePath: event.target.value })} /><span className="upgrade-field-hint">{configIssues.storagePath}</span></div>
            <div className="form-group upgrade-span-2"><label>Host media path</label><input aria-invalid={Boolean(configIssues.mediaPath)} value={configForm.mediaPath} onChange={event => setConfigForm({ ...configForm, mediaPath: event.target.value })} /><span className="upgrade-field-hint">{configIssues.mediaPath}</span></div>
            {isAllUnraidShares(configForm.storagePath) && (
              <label className="toggle-label upgrade-span-2 upgrade-broad-confirmation">
                <input type="checkbox" className="toggle" checked={configForm.allowBroadStorage} onChange={event => setConfigForm({ ...configForm, allowBroadStorage: event.target.checked })} />
                I intentionally authorize every Unraid user share as hardened storage scope
              </label>
            )}
          </div>
          <div className="upgrade-actions">
            <button type="button" className="btn btn-primary" onClick={generateFinalConfig} disabled={working || !hostReady || !configValid}><FileCog size={15} /> Generate configuration</button>
          </div>
          {finalConfig && <div className="upgrade-command"><div><strong>Hardened release environment</strong><CopyButton value={finalConfig} label="Copy configuration" /></div><pre>{finalConfig}</pre></div>}
        </div>
      )}

      {step === 4 && (
        <div className="upgrade-stage upgrade-finish">
          {finalReady ? <CheckCircle size={46} /> : <AlertTriangle size={46} />}
          <h3>{finalReady ? 'Host is prepared for the hardened release' : 'Preparation is not complete'}</h3>
          <div className="upgrade-final-gates">
            <span className={backupReady ? 'pass' : 'blocked'}>{backupReady ? <Check size={15} /> : <XCircle size={15} />} Verified database backup</span>
            <span className={hostReady ? 'pass' : 'blocked'}>{hostReady ? <Check size={15} /> : <XCircle size={15} />} Host preparation receipt</span>
            <span className={finalConfig ? 'pass' : 'blocked'}>{finalConfig ? <Check size={15} /> : <XCircle size={15} />} Final configuration generated</span>
            <span className={!activeWorkBlocked ? 'pass' : 'blocked'}>{!activeWorkBlocked ? <Check size={15} /> : <XCircle size={15} />} No active jobs</span>
          </div>
          {assessment?.hostPreparation?.receipt?.rollbackDir && (
            <div className="upgrade-rollback"><HardDrive size={19} /><div><strong>Keep this rollback snapshot</strong><code>{assessment.hostPreparation.receipt.rollbackDir}</code><p>Do not delete it until the hardened release and representative jobs are verified.</p></div></div>
          )}
          <p>The bridge does not replace the container. Keep the generated configuration and rollback directory for the hardened release upgrade.</p>
          <div className="upgrade-actions"><button type="button" className="btn btn-secondary" onClick={refresh}><RefreshCw size={15} /> Recheck all gates</button></div>
        </div>
      )}
    </section>
  );
}

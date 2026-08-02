import { useState, useEffect, useCallback } from 'react';
import {
  getExternalJobs, createExternalJob, updateExternalJob,
  deleteExternalJob, regenerateExternalJobToken, getExternalJobRuns,
} from '../api/index.js';
import useReconnect from '../hooks/useReconnect.js';
import { useSettings } from '../contexts/SettingsContext.jsx';
import { formatDateTime, parseDbDate } from '../utils/dateFormat.js';
import StatusBadge from '../components/StatusBadge.jsx';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import { DialogSurface } from '../components/Dialog.jsx';
import {
  ListChecks, Plus, RefreshCw, Trash2, KeyRound, Copy, Check,
  AlertTriangle, Clock, Server, ChevronDown, ChevronRight, X,
} from 'lucide-react';
import './ExternalJobsPage.css';

const EMPTY_FORM = { name: '', slug: '', host: '', cron_expression: '', grace_seconds: 900, enabled: true };

// The API state vocabulary matches services/jobHealth.js; overdue is shown as a
// warning rather than a failure because nothing reported an error — that is the
// whole point of a dead man's switch.
function badgeFor(health) {
  if (health.state === 'paused') return { status: 'disabled', label: 'Paused' };
  if (health.state === 'running') return { status: 'running', label: 'Running' };
  // A job that has never checked in is not healthy, it is unproven — calling it
  // healthy would be the same false reassurance this feature exists to remove.
  if (health.neverReported) return { status: 'queued', label: 'Awaiting first report' };
  if (health.state === 'healthy') return { status: 'completed', label: 'Healthy' };
  return health.stale
    ? { status: 'partial', label: 'Overdue' }
    : { status: 'failed', label: 'Failed' };
}

function relativeAge(iso) {
  // parseDbDate, not Date.parse: SQLite timestamps carry no zone and would
  // otherwise be read as local time, ageing every report by the host offset.
  const parsed = parseDbDate(iso);
  if (!parsed) return null;
  const minutes = Math.floor((Date.now() - parsed.getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

export default function ExternalJobsPage() {
  const { settings } = useSettings();
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [newToken, setNewToken] = useState(null);
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(null);
  const [runs, setRuns] = useState({});
  const [confirmDelete, setConfirmDelete] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await getExternalJobs();
      setJobs(data.jobs || []);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useReconnect(load);

  // Overdue is derived from elapsed time, so the view must refresh on its own or
  // a job silently stays "healthy" on screen after it stops reporting.
  useEffect(() => {
    const timer = setInterval(load, 60_000);
    return () => clearInterval(timer);
  }, [load]);

  async function toggleRuns(job) {
    if (expanded === job.id) { setExpanded(null); return; }
    setExpanded(job.id);
    if (!runs[job.id]) {
      const data = await getExternalJobRuns(job.id, 1, 20);
      setRuns(prev => ({ ...prev, [job.id]: data.runs || [] }));
    }
  }

  async function submit(event) {
    event.preventDefault();
    try {
      const result = await createExternalJob(form);
      setNewToken({ token: result.token, slug: result.job.slug });
      setForm(EMPTY_FORM);
      setShowForm(false);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function toggleEnabled(job) {
    await updateExternalJob(job.id, { enabled: !job.enabled });
    load();
  }

  async function regenerate(job) {
    const { token } = await regenerateExternalJobToken(job.id);
    setNewToken({ token, slug: job.slug });
  }

  async function remove(job) {
    await deleteExternalJob(job.id);
    setConfirmDelete(null);
    load();
  }

  const heartbeatUrl = slug => `${window.location.origin}/api/external-jobs/heartbeat/${slug}`;

  function snippetFor(slug, token) {
    return `curl -fsS -X POST \\
  -H "Authorization: Bearer ${token}" \\
  -H 'Content-Type: application/json' \\
  -d "{\\"exit_code\\":$?,\\"duration_seconds\\":$SECONDS}" \\
  ${heartbeatUrl(slug)}`;
  }

  async function copySnippet(text) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Copying failed — select the command manually');
    }
  }

  const counts = jobs.reduce((acc, job) => {
    const key = job.health.neverReported && job.health.state === 'healthy' ? 'unproven' : job.health.state;
    acc[key] = (acc[key] || 0) + 1;
    if (job.health.stale) acc.overdue = (acc.overdue || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="external-jobs-page">
      <div className="page-header">
        <h1><ListChecks size={24} /> External Jobs</h1>
        <div className="page-header-actions">
          <button className="btn btn-ghost btn-sm" onClick={load}>
            <RefreshCw size={14} /> Refresh
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => setShowForm(true)}>
            <Plus size={14} /> Register job
          </button>
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      <div className="ext-summary">
        <div className={`ext-summary-tile${counts.overdue ? ' is-alert' : ''}`}>
          <span className="ext-summary-value">{counts.overdue || 0}</span>
          <span className="ext-summary-label"><AlertTriangle size={13} /> Overdue</span>
        </div>
        <div className="ext-summary-tile">
          <span className="ext-summary-value">{counts.healthy || 0}</span>
          <span className="ext-summary-label">Healthy</span>
        </div>
        <div className="ext-summary-tile">
          <span className="ext-summary-value">{counts.attention || 0}</span>
          <span className="ext-summary-label">Needs attention</span>
        </div>
        <div className="ext-summary-tile">
          <span className="ext-summary-value">{counts.unproven || 0}</span>
          <span className="ext-summary-label">Awaiting first report</span>
        </div>
        <div className="ext-summary-tile">
          <span className="ext-summary-value">{counts.paused || 0}</span>
          <span className="ext-summary-label">Paused</span>
        </div>
      </div>

      {loading && <div className="empty-state">Loading…</div>}

      {!loading && jobs.length === 0 && (
        <div className="empty-state">
          <p>No external jobs registered yet.</p>
          <p className="form-hint">
            Register a cron job, systemd timer, or container updater from any host and let it
            report in after each run. RedMan then tells you when a report stops arriving.
          </p>
        </div>
      )}

      <div className="ext-job-list">
        {jobs.map(job => {
          const badge = badgeFor(job.health);
          const isOpen = expanded === job.id;
          return (
            <div key={job.id} className={`card ext-job${job.health.stale ? ' is-overdue' : ''}`}>
              <div className="ext-job-main">
                <button className="ext-job-toggle" onClick={() => toggleRuns(job)} aria-expanded={isOpen}>
                  {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </button>
                <div className="ext-job-identity">
                  <div className="ext-job-name">{job.name}</div>
                  <div className="ext-job-meta">
                    {job.host && <span><Server size={12} /> {job.host}</span>}
                    <code>{job.slug}</code>
                    {job.cron_expression
                      ? <span><Clock size={12} /> {job.cron_expression}</span>
                      : <span className="ext-job-unscheduled">no schedule</span>}
                  </div>
                </div>
                <div className="ext-job-status">
                  <StatusBadge status={badge.status} label={badge.label} />
                  <div className="ext-job-timing">
                    {job.health.neverReported
                      ? <span className="ext-job-unscheduled">never reported</span>
                      : <span>last {relativeAge(job.last_reported_at)}</span>}
                    {job.health.nextRun && !job.health.stale && (
                      <span>next {formatDateTime(job.health.nextRun, settings)}</span>
                    )}
                    {job.health.overdueSince && (
                      <span className="ext-job-overdue">
                        overdue since {formatDateTime(job.health.overdueSince, settings)}
                      </span>
                    )}
                  </div>
                </div>
                <div className="ext-job-actions">
                  <button className="btn btn-ghost btn-sm" onClick={() => toggleEnabled(job)}>
                    {job.enabled ? 'Pause' : 'Resume'}
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => regenerate(job)} title="Regenerate token">
                    <KeyRound size={14} />
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(job)} title="Delete">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>

              {job.health.lastIssue && (
                <div className="ext-job-issue">
                  <AlertTriangle size={13} /> last failure: exit {job.health.lastIssue.exit_code ?? '?'}
                  {job.health.lastIssue.message ? ` — ${job.health.lastIssue.message}` : ''}
                </div>
              )}

              {isOpen && (
                <div className="ext-job-runs">
                  {(runs[job.id] || []).length === 0
                    ? <div className="form-hint">No heartbeats recorded yet.</div>
                    : (
                      <table className="ext-run-table">
                        <thead>
                          <tr><th>Reported</th><th>Status</th><th>Exit</th><th>Duration</th><th>Message</th></tr>
                        </thead>
                        <tbody>
                          {(runs[job.id] || []).map(run => (
                            <tr key={run.id}>
                              <td>{formatDateTime(run.reported_at, settings)}</td>
                              <td><StatusBadge status={run.status} /></td>
                              <td>{run.exit_code ?? '—'}</td>
                              <td>{run.duration_seconds != null ? `${run.duration_seconds}s` : '—'}</td>
                              <td className="ext-run-message">{run.message || '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {showForm && (
        <DialogSurface onClose={() => setShowForm(false)}>
          <form onSubmit={submit}>
            <div className="modal-header">
              <h2>Register external job</h2>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowForm(false)}>
                <X size={16} />
              </button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label htmlFor="ext-name">Name</label>
                <input id="ext-name" value={form.name} required
                  onChange={e => setForm({ ...form, name: e.target.value })}
                  placeholder="Cloudbuddy OS snapshot" />
              </div>
              <div className="form-group">
                <label htmlFor="ext-slug">Identifier</label>
                <input id="ext-slug" value={form.slug}
                  onChange={e => setForm({ ...form, slug: e.target.value })}
                  placeholder="cloudbuddy-snapshot" />
                <div className="form-hint">Used in the heartbeat URL. Derived from the name when left empty.</div>
              </div>
              <div className="form-group">
                <label htmlFor="ext-host">Host</label>
                <input id="ext-host" value={form.host}
                  onChange={e => setForm({ ...form, host: e.target.value })}
                  placeholder="cloudbuddy" />
              </div>
              <div className="form-group">
                <label htmlFor="ext-cron">Expected schedule</label>
                <input id="ext-cron" value={form.cron_expression}
                  onChange={e => setForm({ ...form, cron_expression: e.target.value })}
                  placeholder="0 3 * * 0" />
                <div className="form-hint">
                  Cron expression. Leave empty for irregular jobs — those are never reported late.
                </div>
              </div>
              <div className="form-group">
                <label htmlFor="ext-grace">Grace period (seconds)</label>
                <input id="ext-grace" type="number" min="0" value={form.grace_seconds}
                  onChange={e => setForm({ ...form, grace_seconds: Number(e.target.value) })} />
                <div className="form-hint">How long a report may be late before the job is flagged.</div>
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={() => setShowForm(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary">Register</button>
            </div>
          </form>
        </DialogSurface>
      )}

      {newToken && (
        <DialogSurface onClose={() => setNewToken(null)}>
          <div className="modal-header">
            <h2>Heartbeat token</h2>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setNewToken(null)}>
              <X size={16} />
            </button>
          </div>
          <div className="modal-body">
            <div className="alert alert-error ext-token-warning">
              This token is shown once. RedMan only stores its hash, so it cannot be recovered later.
            </div>
            <div className="form-group">
              <label htmlFor="ext-token">Token</label>
              <input id="ext-token" readOnly value={newToken.token} onFocus={e => e.target.select()} />
            </div>
            <div className="form-group">
              <div className="ext-snippet-head">
                <label htmlFor="ext-snippet">Add this to the end of the job</label>
                <button type="button" className="btn btn-secondary btn-sm"
                  onClick={() => copySnippet(snippetFor(newToken.slug, newToken.token))}>
                  {copied ? <><Check size={14} /> Copied</> : <><Copy size={14} /> Copy command</>}
                </button>
              </div>
              <pre id="ext-snippet" className="ext-snippet">{snippetFor(newToken.slug, newToken.token)}</pre>
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-primary" onClick={() => setNewToken(null)}>Done</button>
          </div>
        </DialogSurface>
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="Delete external job"
          confirmLabel="Delete"
          destructive
          onConfirm={() => remove(confirmDelete)}
          onClose={() => setConfirmDelete(null)}
        >
          Delete &quot;{confirmDelete.name}&quot; and its heartbeat history? The job itself keeps
          running; RedMan simply stops watching it.
        </ConfirmDialog>
      )}
    </div>
  );
}

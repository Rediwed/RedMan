import { useState, useEffect, useCallback } from 'react';
import { getEvents, getEventSummary, getSystemStatus } from '../api/index.js';
import useReconnect from '../hooks/useReconnect.js';
import { useSettings } from '../contexts/SettingsContext.jsx';
import { formatDateTime, parseDbDate } from '../utils/dateFormat.js';
import { splitBody } from '../utils/describe.js';
import DetailStats from '../components/DetailStats.jsx';
import { Link } from 'react-router-dom';
import {
  Activity, RefreshCw, AlertTriangle, XCircle, Info, Filter, ChevronDown, ChevronRight,
  CheckCircle2, HelpCircle, PauseCircle,
} from 'lucide-react';
import './StatusPage.css';

const STATE_META = {
  fail: { icon: XCircle, className: 'st-fail', label: 'Failing' },
  warn: { icon: AlertTriangle, className: 'st-warn', label: 'Attention' },
  unknown: { icon: HelpCircle, className: 'st-unknown', label: 'Unknown' },
  paused: { icon: PauseCircle, className: 'st-paused', label: 'Paused' },
  ok: { icon: CheckCircle2, className: 'st-ok', label: 'Healthy' },
};

const WINDOWS = [
  { value: '-1 hours', label: 'Last hour' },
  { value: '-24 hours', label: 'Last 24 hours' },
  { value: '-7 days', label: 'Last 7 days' },
  { value: '-30 days', label: 'Last 30 days' },
];

const SEVERITY_META = {
  error: { icon: XCircle, className: 'sev-error', label: 'Error' },
  warning: { icon: AlertTriangle, className: 'sev-warning', label: 'Warning' },
  info: { icon: Info, className: 'sev-info', label: 'Info' },
};

function relativeAge(value) {
  const parsed = parseDbDate(value);
  if (!parsed) return '';
  const minutes = Math.floor((Date.now() - parsed.getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

export default function StatusPage() {
  const { settings } = useSettings();
  const [board, setBoard] = useState(null);
  const [summary, setSummary] = useState(null);
  const [data, setData] = useState({ events: [], total: 0 });
  const [filters, setFilters] = useState({ severity: '', category: '', since: '-24 hours' });
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [openCategory, setOpenCategory] = useState(null);

  const load = useCallback(async () => {
    try {
      const [events, sum, status] = await Promise.all([
        getEvents(filters, page, 50),
        getEventSummary(filters.since),
        getSystemStatus(),
      ]);
      setData(events);
      setSummary(sum);
      setBoard(status);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [filters, page]);

  useEffect(() => { load(); }, [load]);
  useReconnect(load);

  // New events arrive while the page is open; without this the timeline silently
  // goes stale and looks like nothing is happening.
  useEffect(() => {
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [load]);

  function setFilter(key, value) {
    setPage(1);
    setFilters(prev => ({ ...prev, [key]: value }));
  }

  const counts = summary?.bySeverity || {};
  const totalPages = Math.max(1, Math.ceil(data.total / 50));

  return (
    <div className="status-page">
      <div className="page-header">
        <h1><Activity size={24} /> Status</h1>
        <div className="page-header-actions">
          <button className="btn btn-ghost btn-sm" onClick={load}>
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {board && (
        <section className="status-board">
          <div className={`status-board-head ${STATE_META[board.overall].className}`}>
            {(() => { const Icon = STATE_META[board.overall].icon; return <Icon size={20} />; })()}
            <div>
              <strong>
                {board.overall === 'ok'
                  ? 'Everything RedMan can see is healthy'
                  : `${(board.counts.fail || 0) + (board.counts.warn || 0)} of ${
                    Object.values(board.counts).reduce((a, b) => a + b, 0)} checks need attention`}
              </strong>
              <div className="status-board-counts">
                {['fail', 'warn', 'unknown', 'paused', 'ok'].map(state =>
                  board.counts[state]
                    ? <span key={state} className={STATE_META[state].className}>
                      {board.counts[state]} {STATE_META[state].label.toLowerCase()}
                    </span>
                    : null)}
              </div>
            </div>
          </div>

          {board.failedCollectors.length > 0 && (
            <div className="alert alert-error status-collector-error">
              Some checks could not run: {board.failedCollectors.map(f => f.collector).join(', ')}.
              The rest of the board is still accurate.
            </div>
          )}

          <div className="status-board-grid">
            {board.categories.map(cat => {
              const meta = STATE_META[cat.state];
              const Icon = meta.icon;
              const isOpen = openCategory === cat.name;
              // Anything that is not plainly healthy stays visible when collapsed:
              // hiding "unknown" behind an "all healthy" summary would be the
              // false reassurance this board exists to remove.
              const notable = cat.checks.filter(c => c.state !== 'ok');
              const shown = isOpen ? cat.checks : notable;
              return (
                <div key={cat.name} className={`status-card ${meta.className}`}>
                  <button className="status-card-head" onClick={() => setOpenCategory(isOpen ? null : cat.name)}>
                    <Icon size={16} />
                    <span className="status-card-title">{cat.name}</span>
                    <span className="status-card-count">{cat.checks.length}</span>
                    {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                  {shown.length === 0 && !isOpen && (
                    <div className="status-card-ok">All {cat.checks.length} healthy</div>
                  )}
                  {shown.map(item => {
                    const cm = STATE_META[item.state];
                    const CIcon = cm.icon;
                    return (
                      <div key={item.id} className={`status-check ${cm.className}`}>
                        <CIcon size={13} />
                        <div className="status-check-main">
                          <div className="status-check-subject">
                            {item.link
                              ? <Link to={item.link}>{item.subject}</Link>
                              : item.subject}
                          </div>
                          <div className="status-check-summary">
                            {item.summary}{item.at ? ` ${formatDateTime(item.at, settings)}` : ''}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </section>
      )}

      <h2 className="status-section-title">Recent activity</h2>

      <div className="status-summary">
        {['error', 'warning', 'info'].map(sev => {
          const meta = SEVERITY_META[sev];
          const Icon = meta.icon;
          const active = filters.severity === sev;
          return (
            <button
              key={sev}
              className={`status-tile ${meta.className}${active ? ' is-active' : ''}`}
              onClick={() => setFilter('severity', active ? '' : sev)}
              aria-pressed={active}
            >
              <span className="status-tile-value">{counts[sev] || 0}</span>
              <span className="status-tile-label"><Icon size={13} /> {meta.label}</span>
            </button>
          );
        })}
      </div>

      {summary?.latestIssue && !data.events.some(e => e.id === summary.latestIssue.id) && (
        <div className="status-latest">
          <AlertTriangle size={15} />
          <div>
            <strong>{summary.latestIssue.title}</strong>
            <span className="status-latest-age">
              {relativeAge(summary.latestIssue.created_at)}
            </span>
          </div>
        </div>
      )}

      <div className="status-filters">
        <Filter size={14} />
        <select value={filters.since} onChange={e => setFilter('since', e.target.value)} aria-label="Time window">
          {WINDOWS.map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
        </select>
        <select value={filters.category} onChange={e => setFilter('category', e.target.value)} aria-label="Category">
          <option value="">All categories</option>
          {(summary?.categories || []).map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        {(filters.severity || filters.category) && (
          <button className="btn btn-ghost btn-sm" onClick={() => setFilters({ ...filters, severity: '', category: '' })}>
            Clear filters
          </button>
        )}
        <span className="status-count">{data.total} event{data.total === 1 ? '' : 's'}</span>
      </div>

      {loading && <div className="empty-state">Loading…</div>}

      {!loading && data.events.length === 0 && (
        <div className="empty-state">
          <p>Nothing recorded in this window.</p>
          <p className="form-hint">
            Events are written as they happen, whether or not notifications are switched on.
          </p>
        </div>
      )}

      <div className="status-timeline">
        {data.events.map(event => {
          const meta = SEVERITY_META[event.severity] || SEVERITY_META.info;
          const Icon = meta.icon;
          const isOpen = expanded === event.id;
          const { lead, stats } = splitBody(event.body);
          const hasDetail = event.detail && Object.keys(event.detail).length > 0;
          const hasMore = hasDetail || stats.length > 0;
          return (
            <div key={event.id} className={`status-event ${meta.className}`}>
              <div className="status-event-row">
                <span className="status-event-icon"><Icon size={15} /></span>
                <div className="status-event-main">
                  <div className="status-event-title">{event.title}</div>
                  {lead && <div className="status-event-body">{lead}</div>}
                  <div className="status-event-meta">
                    <span className="status-chip">{event.category}</span>
                    {event.subject && <span>{event.subject}</span>}
                  </div>
                </div>
                <div className="status-event-time" title={formatDateTime(event.created_at, settings)}>
                  {relativeAge(event.created_at)}
                </div>
                {hasMore && (
                  <button
                    className="status-event-toggle"
                    onClick={() => setExpanded(isOpen ? null : event.id)}
                    aria-expanded={isOpen}
                    aria-label="Show details"
                  >
                    {isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                  </button>
                )}
              </div>
              {isOpen && hasMore && (
                hasDetail
                  ? <DetailStats detail={event.detail} />
                  : (
                    <dl className="detail-stats-grid">
                      {stats.map(stat => (
                        <div key={stat.label} className="detail-stat">
                          <dt>{stat.label}</dt>
                          <dd>{stat.value}</dd>
                        </div>
                      ))}
                    </dl>
                  )
              )}
            </div>
          );
        })}
      </div>

      {totalPages > 1 && (
        <div className="status-pager">
          <button className="btn btn-ghost btn-sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
            Previous
          </button>
          <span>Page {page} of {totalPages}</span>
          <button className="btn btn-ghost btn-sm" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>
            Next
          </button>
        </div>
      )}
    </div>
  );
}

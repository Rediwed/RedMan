import { useState, useEffect, useCallback } from 'react';
import { getOverviewSummary, getDockerContainers, getDockerStatus, dockerAction, getContainerMetrics } from '../api/index.js';
import { LayoutDashboard, HardDrive, RefreshCw, Cloud, Container, RotateCw, Square, Play, CheckCircle2, XCircle } from 'lucide-react';
import StatusBadge from '../components/StatusBadge.jsx';
import MetricsChart from '../components/MetricsChart.jsx';
import './OverviewPage.css';

export default function OverviewPage() {
  const [summary, setSummary] = useState(null);
  const [containers, setContainers] = useState([]);
  const [dockerAvailable, setDockerAvailable] = useState(false);
  const [expandedContainer, setExpandedContainer] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(null);

  const load = useCallback(async () => {
    try {
      const [sum, status] = await Promise.all([
        getOverviewSummary(),
        getDockerStatus(),
      ]);
      setSummary(sum);
      setDockerAvailable(status.available);
      if (status.available) {
        const c = await getDockerContainers();
        setContainers(c);
      }
    } catch (err) {
      console.error('Failed to load overview:', err);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 15000);
    return () => clearInterval(interval);
  }, [load]);

  async function handleAction(containerId, action) {
    setActionLoading(`${containerId}:${action}`);
    try {
      await dockerAction(containerId, action);
      setTimeout(load, 1500);
    } catch (err) {
      alert(`Action failed: ${err.message}`);
    }
    setActionLoading(null);
  }

  async function toggleExpand(containerId) {
    if (expandedContainer === containerId) {
      setExpandedContainer(null);
      setMetrics(null);
      return;
    }
    setExpandedContainer(containerId);
    try {
      const m = await getContainerMetrics(containerId);
      setMetrics(m);
    } catch {
      setMetrics([]);
    }
  }

  if (loading) return <div className="empty-state"><p>Loading dashboard...</p></div>;

  const features = [
    { key: 'ssd-backup', name: 'SSD Backup', icon: HardDrive, color: 'var(--color-ssd)', link: '/ssd-backup' },
    { key: 'hyper-backup', name: 'Hyper Backup', icon: RefreshCw, color: 'var(--color-hyper)', link: '/hyper-backup' },
    { key: 'rclone', name: 'Rclone Sync', icon: Cloud, color: 'var(--color-rclone)', link: '/rclone' },
  ];

  return (
    <div className="overview-page">
      <div className="page-header">
        <h1><LayoutDashboard size={24} /> Overview</h1>
        <span className="overview-meta">
          {summary?.activeJobs || 0} scheduled jobs active
        </span>
      </div>

      {/* Feature summary cards */}
      <div className="feature-cards">
        {features.map(f => {
          const data = summary?.[f.key];
          return (
            <a key={f.key} href={f.link} className="feature-card" style={{ '--accent': f.color }}>
              <div className="feature-card-header">
                <span className="feature-icon"><f.icon size={20} /></span>
                <span className="feature-name">{f.name}</span>
              </div>
              <div className="feature-card-body">
                <div className="feature-stat">
                  <span className="feature-stat-value">{data?.enabledCount || 0}</span>
                  <span className="feature-stat-label">Active Jobs</span>
                </div>
                <div className="feature-stat">
                  <span className="feature-stat-value">
                    {data?.lastRun ? (
                      <StatusBadge status={data.lastRun.status} />
                    ) : '—'}
                  </span>
                  <span className="feature-stat-label">Last Run</span>
                </div>
                <div className="feature-stat">
                  <span className="feature-stat-value feature-stat-small">
                    {data?.lastRun?.started_at
                      ? new Date(data.lastRun.started_at).toLocaleString()
                      : 'Never'}
                  </span>
                  <span className="feature-stat-label">Last Run Time</span>
                </div>
              </div>
              {data?.recentRuns && Object.keys(data.recentRuns).length > 0 && (
                <div className="feature-card-footer">
                  <span className="feature-footer-label">Last 7 days:</span>
                  {data.recentRuns.completed && <span className="run-count success"><CheckCircle2 size={12} /> {data.recentRuns.completed}</span>}
                  {data.recentRuns.failed && <span className="run-count danger"><XCircle size={12} /> {data.recentRuns.failed}</span>}
                </div>
              )}
            </a>
          );
        })}
      </div>

      {/* Docker containers */}
      <div className="docker-section">
        <div className="docker-header">
          <h2><Container size={20} /> Docker Containers</h2>
          {!dockerAvailable && <span className="docker-unavailable">Docker not available</span>}
        </div>

        {dockerAvailable && containers.length > 0 ? (
          <div className="container-grid">
            {containers.map(c => (
              <div key={c.id} className={`container-card ${expandedContainer === c.id ? 'expanded' : ''}`}>
                <div className="container-card-main" onClick={() => toggleExpand(c.id)}>
                  <div className="container-info">
                    <span className="container-name">{c.name}</span>
                    <span className="container-image">{c.image}</span>
                  </div>
                  <div className="container-right">
                    <StatusBadge status={c.state} />
                    <div className="container-actions">
                      {c.state === 'running' ? (
                        <>
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={(e) => { e.stopPropagation(); handleAction(c.id, 'restart'); }}
                            disabled={actionLoading === `${c.id}:restart`}
                          ><RotateCw size={14} /></button>
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={(e) => { e.stopPropagation(); handleAction(c.id, 'stop'); }}
                            disabled={actionLoading === `${c.id}:stop`}
                          ><Square size={14} /></button>
                        </>
                      ) : (
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={(e) => { e.stopPropagation(); handleAction(c.id, 'start'); }}
                          disabled={actionLoading === `${c.id}:start`}
                        ><Play size={14} /></button>
                      )}
                    </div>
                  </div>
                </div>

                {expandedContainer === c.id && metrics && (
                  <div className="container-metrics">
                    {metrics.length > 0 ? (
                      <div className="metrics-row">
                        <MetricsChart data={metrics} dataKey="cpu_percent" label="CPU" color="#4f8ff7" maxValue={100} unit="%" />
                        <MetricsChart data={metrics} dataKey="memory_usage" label="Memory" color="#22c55e" unit="bytes" />
                      </div>
                    ) : (
                      <p className="metrics-empty">No metrics data available yet</p>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : dockerAvailable ? (
          <div className="empty-state"><p>No containers found</p></div>
        ) : null}
      </div>
    </div>
  );
}

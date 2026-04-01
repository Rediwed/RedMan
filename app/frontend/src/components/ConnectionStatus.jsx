import { useState, useEffect, useRef } from 'react';
import './ConnectionStatus.css';

export default function ConnectionStatus() {
  const [status, setStatus] = useState('connecting');
  const [info, setInfo] = useState(null);
  const [showPopover, setShowPopover] = useState(false);
  const intervalRef = useRef(null);
  const hideTimer = useRef(null);

  async function checkHealth() {
    const start = Date.now();
    try {
      const res = await fetch('/api/health');
      const data = await res.json();
      const latency = Date.now() - start;
      setStatus('connected');
      setInfo({ ...data, latency });
    } catch {
      setStatus('disconnected');
      setInfo(null);
    }
  }

  useEffect(() => {
    checkHealth();
    intervalRef.current = setInterval(checkHealth, 15000);
    return () => clearInterval(intervalRef.current);
  }, []);

  const handleEnter = () => {
    clearTimeout(hideTimer.current);
    checkHealth();
    setShowPopover(true);
  };
  const handleLeave = () => {
    hideTimer.current = setTimeout(() => setShowPopover(false), 200);
  };

  return (
    <div
      className="connection-wrapper"
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      <button
        className={`connection-status status-${status}`}
        onClick={checkHealth}
      >
        <span className="connection-dot" />
        <span className="connection-label">
          {status === 'connected' ? 'Connected' : status === 'connecting' ? '...' : 'Offline'}
        </span>
      </button>

      {showPopover && (
        <div className="connection-popover">
          <span className="popover-arrow" />
          <div className="popover-header">
            <span className={`popover-dot status-${status}`} />
            <strong>{status === 'connected' ? 'Connected to RedMan' : 'Connection Lost'}</strong>
          </div>

          {info ? (
            <div className="popover-grid">
              <Row label="Version" value={`v${info.version}`} />
              <Row label="Latency" value={`${info.latency}ms`} />
              <Row label="Uptime" value={formatUptime(info.uptime)} />
              <Row label="Host" value={info.hostname} />
              <Row label="Platform" value={info.platform} />
              <Row label="Node" value={info.nodeVersion} />
              <Row label="Scheduled jobs" value={info.activeJobs} />
              <Row label="Memory" value={formatBytes(info.memory?.heapUsed)} />
              <Row label="PID" value={info.pid} />
            </div>
          ) : (
            <p className="popover-offline">Backend is unreachable. Check if the RedMan server is running.</p>
          )}

          <div className="popover-footer">Click badge to refresh</div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="popover-row">
      <span className="popover-label">{label}</span>
      <span className="popover-value">{value ?? '—'}</span>
    </div>
  );
}

function formatUptime(seconds) {
  if (!seconds && seconds !== 0) return '—';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h < 24) return `${h}h ${m}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function formatBytes(bytes) {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

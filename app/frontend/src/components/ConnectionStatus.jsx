import { useState, useEffect, useRef } from 'react';
import { ShieldCheck, ShieldAlert } from 'lucide-react';
import { dispatchReconnect } from '../hooks/useReconnect.js';
import { formatBytes } from '../utils/formatBytes.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import './ConnectionStatus.css';

const POLL_CONNECTED = 5000;
const POLL_DISCONNECTED = 2000;

export default function ConnectionStatus() {
  const auth = useAuth();
  const [status, setStatus] = useState('connecting');
  const [info, setInfo] = useState(null);
  const [peers, setPeers] = useState([]);
  const [showPopover, setShowPopover] = useState(false);
  const intervalRef = useRef(null);
  const hideTimer = useRef(null);
  const wasDisconnected = useRef(false);

  async function checkHealth() {
    const start = Date.now();
    try {
      const res = await fetch(auth.user ? '/api/health/details' : '/api/health');
      if (!res.ok) throw new Error('Health check failed');
      const data = await res.json();
      const latency = Date.now() - start;

      if (wasDisconnected.current) {
        wasDisconnected.current = false;
        dispatchReconnect();
      }

      setStatus('connected');
      setInfo({ ...data, latency });

      // Fetch peer connectivity in parallel (non-blocking)
      if (auth.isAdmin) {
        fetch('/api/peers/connectivity')
          .then(r => r.ok ? r.json() : [])
          .then(setPeers)
          .catch(() => setPeers([]));
      } else {
        setPeers([]);
      }

      return true;
    } catch {
      wasDisconnected.current = true;
      setStatus('disconnected');
      setInfo(null);
      setPeers([]);
      return false;
    }
  }

  useEffect(() => {
    let active = true;

    async function poll() {
      if (!active) return;
      const ok = await checkHealth();
      const delay = ok ? POLL_CONNECTED : POLL_DISCONNECTED;
      intervalRef.current = setTimeout(poll, delay);
    }

    poll();
    return () => {
      active = false;
      clearTimeout(intervalRef.current);
    };
  }, [auth.isAdmin, auth.user]);

  const handleEnter = () => {
    clearTimeout(hideTimer.current);
    checkHealth();
    setShowPopover(true);
  };
  const handleLeave = () => {
    hideTimer.current = setTimeout(() => setShowPopover(false), 200);
  };

  const onlineCount = peers.filter(p => p.status === 'online').length;

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
        {status === 'connected' && peers.length > 0 && (
          <span className="peer-dots" title={`${onlineCount}/${peers.length} peers online`}>
            {peers.map(p => (
              <span key={p.id} className={`peer-dot peer-${p.status}`} />
            ))}
          </span>
        )}
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
              <Row label="Memory" value={formatBytes(info.memory?.heapUsed, { zero: '—' })} />
              <Row label="PID" value={info.pid} />
            </div>
          ) : (
            <p className="popover-offline">Backend is unreachable. Check if the RedMan server is running.</p>
          )}

          {peers.length > 0 && (
            <div className="popover-peers">
              <div className="popover-peers-header">
                Peers
                <span className="popover-peers-count">{onlineCount}/{peers.length} online</span>
              </div>
              {peers.map(p => (
                <div key={p.id} className="popover-peer-card">
                  <div className="popover-peer-row">
                    <span className={`peer-dot peer-${p.status}`} />
                    <span className="popover-peer-name">{p.name || p.instance || `Peer ${p.id}`}</span>
                    {p.handshake_version >= 2
                      ? <span className="peer-shield-secure" title={p.fingerprint ? `Secure — ${p.fingerprint}` : 'Secure'}><ShieldCheck size={12} /></span>
                      : <span className="peer-shield-legacy" title="Legacy — re-pair to upgrade"><ShieldAlert size={12} /></span>}
                    <span className={`popover-peer-status peer-status-${p.status}`}>{p.status}</span>
                  </div>
                  <div className="popover-peer-details">
                    {p.hostname && <span>{p.hostname}</span>}
                    {p.version && <span>v{p.version}</span>}
                    {p.last_seen_at && <span>Seen {formatRelativeTime(p.last_seen_at)}</span>}
                  </div>
                </div>
              ))}
            </div>
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

function formatRelativeTime(iso) {
  if (!iso) return null;
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 0) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  const d = Math.floor(diff / 86400);
  return `${d}d ago`;
}

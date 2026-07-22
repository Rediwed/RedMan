import { AlertTriangle, CheckCircle2, Clock, PauseCircle, RefreshCw, RotateCcw } from 'lucide-react';
import { formatDateTime } from '../utils/dateFormat.js';
import './BackupHealth.css';

const STATE_LABELS = {
  healthy: 'Protected on schedule',
  attention: 'Needs attention',
  running: 'Backup in progress',
  paused: 'Schedule paused',
};

export default function BackupHealth({ health, settings, onOpenRun, onOpenRestore, restoreSupported = false }) {
  if (!health) return null;
  const StateIcon = health.state === 'healthy'
    ? CheckCircle2
    : health.state === 'running'
      ? RefreshCw
      : health.state === 'paused'
        ? PauseCircle
        : AlertTriangle;

  return (
    <div className={`backup-health health-${health.state}`}>
      <div className="backup-health-summary">
        <StateIcon size={16} aria-hidden="true" className={health.state === 'running' ? 'spin' : ''} />
        <strong>{STATE_LABELS[health.state] || 'Health unknown'}</strong>
        {health.stale && <span>Expected backup is overdue</span>}
      </div>
      <div className="backup-health-grid">
        <HealthValue
          label="Last success"
          value={health.lastSuccess ? formatDateTime(health.lastSuccess.completed_at, settings) : 'Never'}
          onClick={health.lastSuccess && onOpenRun ? () => onOpenRun(health.lastSuccess.id) : null}
        />
        <HealthValue
          label="Last issue"
          value={health.lastIssue ? `${formatDateTime(health.lastIssue.completed_at, settings)} (${health.lastIssue.status})` : 'None recorded'}
          onClick={health.lastIssue && onOpenRun ? () => onOpenRun(health.lastIssue.id) : null}
        />
        <HealthValue
          label="Verified restore"
          value={restoreSupported
            ? health.lastVerifiedRestore ? formatDateTime(health.lastVerifiedRestore.verified_at, settings) : 'Never verified'
            : 'Not available for this job type'}
          onClick={health.lastVerifiedRestore && onOpenRestore ? onOpenRestore : null}
          icon={RotateCcw}
        />
        <HealthValue
          label="Next run"
          value={health.nextRun ? formatDateTime(health.nextRun, settings) : health.state === 'paused' ? 'Paused' : 'Unavailable'}
          icon={Clock}
        />
      </div>
    </div>
  );
}

function HealthValue({ label, value, onClick, icon: Icon }) {
  const content = <>{Icon && <Icon size={13} aria-hidden="true" />}<span>{value}</span></>;
  return (
    <div className="backup-health-value">
      <span className="detail-label">{label}</span>
      {onClick ? <button type="button" className="health-link" onClick={onClick}>{content}</button> : <div>{content}</div>}
    </div>
  );
}
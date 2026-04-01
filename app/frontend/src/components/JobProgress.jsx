import { useState, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import './JobProgress.css';

/**
 * Live progress indicator for running backup/sync jobs.
 * Adapts display based on the feature type and available data.
 *
 * @param {{ progress: object, feature: string }} props
 * feature: 'ssd-backup' | 'hyper-backup' | 'rclone' | 'media-import'
 */
export default function JobProgress({ progress, feature }) {
  const [elapsed, setElapsed] = useState(0);

  // Tick elapsed every second for a smooth counter
  useEffect(() => {
    if (!progress?.startedAt) return;
    const update = () => setElapsed(Math.round((Date.now() - progress.startedAt) / 1000));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [progress?.startedAt]);

  if (!progress) return null;

  const hasPercent = progress.percent != null && progress.percent > 0;
  const percent = hasPercent ? Math.min(progress.percent, 100) : null;

  // Stage label for hyper backup
  const stageLabels = {
    preparing: 'Preparing remote...',
    transferring: 'Transferring files...',
    completing: 'Completing...',
  };
  const label = feature === 'hyper-backup' && stageLabels[progress.status]
    ? stageLabels[progress.status]
    : 'Running...';

  return (
    <div className="job-progress">
      <div className="job-progress-header">
        <span className="job-progress-status">
          <Loader2 size={14} className="spin" />
          {label}
        </span>
        {progress.startedAt && (
          <span className="job-progress-elapsed">{formatElapsed(elapsed)}</span>
        )}
      </div>

      <div className="job-progress-bar-row">
        <div className="job-progress-bar">
          <div
            className={`job-progress-fill ${percent == null ? 'indeterminate' : ''}`}
            style={percent != null ? { width: `${percent}%` } : undefined}
          />
        </div>
        {percent != null && <span className="job-progress-pct">{percent}%</span>}
      </div>

      <div className="job-progress-stats">
        {renderStats(progress, feature)}
      </div>

      {progress.currentFile && (
        <div className="job-progress-file" title={progress.currentFile}>
          {progress.currentFile}
        </div>
      )}
    </div>
  );
}

function renderStats(p, feature) {
  const parts = [];

  if (feature === 'rclone') {
    if (p.percent != null) parts.push(`${p.percent}%`);
    if (p.bytesTransferred > 0) {
      let text = formatBytes(p.bytesTransferred);
      if (p.bytesTotal > 0) text += ` / ${formatBytes(p.bytesTotal)}`;
      parts.push(text);
    }
    if (p.speed) parts.push(p.speed);
    if (p.eta) parts.push(`ETA ${p.eta}`);
    if (p.filesCopied != null) {
      let text = `${p.filesCopied} files`;
      if (p.filesTotal) text += ` / ${p.filesTotal}`;
      parts.push(text);
    }
  } else if (feature === 'media-import') {
    if (p.uploaded != null) parts.push(`${p.uploaded} uploaded`);
    if (p.duplicates) parts.push(`${p.duplicates} dupes`);
    if (p.errors) parts.push(`${p.errors} errors`);
    if (p.assetsFound) parts.push(`${p.assetsFound} found`);
  } else {
    // ssd-backup, hyper-backup (rsync-based)
    if (p.filesTotal > 0) {
      let text = `${p.filesTotal} checked`;
      if (p.filesCopied > 0) text += ` · ${p.filesCopied} transferred`;
      parts.push(text);
    }
    if (p.filesFailed > 0) parts.push(`${p.filesFailed} failed`);
    if (p.bytesTransferred > 0) parts.push(`${formatBytes(p.bytesTransferred)} transferred`);
    if (p.speed) parts.push(p.speed);
  }

  return parts.map((text, i) => <span key={i}>{text}</span>);
}

function formatElapsed(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

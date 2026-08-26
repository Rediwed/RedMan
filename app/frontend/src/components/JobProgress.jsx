import { useState, useEffect } from 'react';
import { Check, Cloud, Download, FileCheck2, FileSearch, Loader2, Send, Sparkles, Trash2, XCircle } from 'lucide-react';
import { formatBytes } from '../utils/formatBytes.js';
import './JobProgress.css';

/**
 * Live progress indicator for running backup/sync jobs.
 * Adapts display based on the feature type and available data.
 *
 * @param {{ progress: object, feature: string }} props
 * feature: 'ssd-backup' | 'hyper-backup' | 'rclone' | 'media-import'
 */
export default function JobProgress({ progress, feature, onCancel }) {
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

  if (progress.status === 'running' && !progress.startedAt) {
    return <StartingJobProgress onCancel={onCancel} />;
  }

  if (feature === 'media-import' && progress.archivesTotal != null) {
    return <MediaImportProgress progress={progress} onCancel={onCancel} elapsed={elapsed} />;
  }

  const view = getAtomicJobView(progress, feature);

  return (
    <div className="job-progress atomic-job-progress">
      <div className="job-progress-header">
        <span className="job-progress-status">
          <Loader2 size={14} className="spin" />
          {view.label}
        </span>
        {progress.startedAt && (
          <span className="job-progress-elapsed">{formatElapsed(elapsed)}</span>
        )}
        {onCancel && (
          <button type="button" className="btn btn-ghost btn-sm job-progress-cancel" onClick={onCancel} title="Cancel">
            <XCircle size={14} /> Cancel
          </button>
        )}
      </div>

      <ProgressSteps steps={view.steps} activeIndex={view.activeIndex} />

      <div className="job-progress-bar-row">
        <div className="job-progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={view.percent ?? undefined}>
          <div
            className={`job-progress-fill ${view.percent == null ? 'indeterminate' : ''}`}
            style={view.percent != null ? { width: `${view.percent}%` } : undefined}
          />
        </div>
        {view.percent != null && <span className="job-progress-pct">{view.percent}%</span>}
      </div>

      <div className="media-progress-metrics">
        {view.metrics.map(metric => <Metric key={metric.label} {...metric} />)}
      </div>

      {progress.currentFile && (
        <div className="job-progress-file" title={progress.currentFile}>
          {progress.currentFile}
        </div>
      )}
    </div>
  );
}

function StartingJobProgress({ onCancel }) {
  return (
    <div className="job-progress starting-job-progress">
      <div className="job-progress-header">
        <span className="job-progress-status">
          <Loader2 size={14} className="spin" />
          Starting job
        </span>
        {onCancel && (
          <button type="button" className="btn btn-ghost btn-sm job-progress-cancel" onClick={onCancel} title="Cancel">
            <XCircle size={14} /> Cancel
          </button>
        )}
      </div>
      <div className="starting-job-rail" aria-hidden="true">
        <span className="starting-job-line" />
        {[0, 1, 2].map(index => <span className="starting-job-node" key={index} style={{ '--starting-index': index }} />)}
      </div>
      <div className="starting-job-caption" role="status" aria-live="polite">Waiting for the first progress update</div>
    </div>
  );
}

const MEDIA_STEPS = [
  { key: 'scan', label: 'Scan', icon: FileSearch },
  { key: 'download', label: 'Download', icon: Download },
  { key: 'import', label: 'Import', icon: Sparkles },
  { key: 'cleanup', label: 'Cleanup', icon: Trash2 },
];

const JOB_VIEWS = {
  'ssd-backup': {
    steps: [
      { label: 'Prepare', icon: FileSearch },
      { label: 'Transfer', icon: Send },
      { label: 'Finalize', icon: FileCheck2 },
    ],
    labels: { preparing: 'Preparing', transferring: 'Transferring', completing: 'Finalizing' },
  },
  'hyper-backup': {
    steps: [
      { label: 'Connect', icon: Cloud },
      { label: 'Transfer', icon: Send },
      { label: 'Confirm', icon: FileCheck2 },
    ],
    labels: { preparing: 'Connecting', transferring: 'Transferring', completing: 'Confirming' },
  },
  rclone: {
    steps: [
      { label: 'Check', icon: FileSearch },
      { label: 'Transfer', icon: Cloud },
      { label: 'Finalize', icon: FileCheck2 },
    ],
    labels: { preparing: 'Checking', transferring: 'Transferring', completing: 'Finalizing' },
  },
  'media-import': {
    steps: [
      { label: 'Scan', icon: FileSearch },
      { label: 'Upload', icon: Sparkles },
      { label: 'Finish', icon: FileCheck2 },
    ],
    labels: { preparing: 'Scanning', transferring: 'Uploading', completing: 'Finishing' },
  },
};

function getAtomicJobView(progress, feature) {
  const config = JOB_VIEWS[feature] || JOB_VIEWS['ssd-backup'];
  let status = progress.status;
  if (feature === 'media-import') {
    const processed = (progress.scanned || 0) + (progress.uploaded || 0) + (progress.duplicates || 0);
    status = processed > 0 ? 'transferring' : 'preparing';
  } else if (!['preparing', 'transferring', 'completing'].includes(status)) {
    status = progress.stage ? 'completing' : progress.percent != null ? 'transferring' : 'preparing';
  }
  const activeIndex = status === 'completing' ? 2 : status === 'transferring' ? 1 : 0;
  const processed = (progress.scanned || 0) || (progress.uploaded || 0) + (progress.duplicates || 0) + (progress.errors || 0);
  let percent = progress.percent > 0 ? Math.min(progress.percent, 100) : null;
  if (feature === 'media-import' && progress.assetsFound > 0) {
    percent = Math.min(100, Math.round(processed / progress.assetsFound * 100));
  }
  return {
    steps: config.steps,
    activeIndex,
    label: progress.stage || config.labels[status] || 'Running',
    percent,
    metrics: getJobMetrics(progress, feature, processed),
  };
}

function getJobMetrics(progress, feature, processed) {
  if (feature === 'rclone') return [
    { value: progress.filesCopied || 0, label: 'Files' },
    { value: formatBytes(progress.bytesTransferred || 0), label: 'Transferred' },
    { value: progress.speed || '—', label: 'Speed' },
    { value: progress.eta || '—', label: 'ETA' },
  ];
  if (feature === 'media-import') return [
    { value: processed, label: 'Scanned' },
    { value: progress.uploaded || 0, label: 'Uploaded' },
    { value: progress.duplicates || 0, label: 'Already there' },
    { value: progress.errors || 0, label: 'Errors', danger: progress.errors > 0 },
  ];
  return [
    { value: progress.filesTotal || 0, label: 'Checked' },
    { value: progress.filesCopied || 0, label: 'Transferred' },
    { value: formatBytes(progress.bytesTransferred || 0), label: 'Data' },
    { value: progress.filesFailed || 0, label: 'Failed', danger: progress.filesFailed > 0 },
  ];
}

function MediaImportProgress({ progress, onCancel, elapsed }) {
  const phaseStep = {
    listing: 0,
    'checking-space': 0,
    downloading: 1,
    importing: 2,
    cleanup: 3,
    completed: 4,
  }[progress.phase] ?? 0;
  const archivesTotal = progress.archivesTotal || 0;
  const archivesCompleted = progress.archivesCompleted || 0;
  const scanned = progress.scanned || 0;
  const assetsFound = progress.assetsFound || 0;
  const importFraction = assetsFound > 0
    ? Math.min(scanned / assetsFound, 1)
    : Math.min((progress.archivePercent || 0) / 100, 1);
  const currentFraction = progress.phase === 'downloading'
    ? Math.min((progress.archivePercent || 0) / 100, 1) * 0.3
    : progress.phase === 'importing' ? 0.3 + importFraction * 0.65
      : progress.phase === 'cleanup' ? 0.98 : 0;
  const overallPercent = archivesTotal > 0
    ? Math.min(100, Math.round((archivesCompleted + currentFraction) / archivesTotal * 100))
    : 0;

  return (
    <div className="job-progress media-step-progress">
      <div className="job-progress-header">
        <span className="job-progress-status">
          <Loader2 size={14} className="spin" />
          {archivesTotal > 0 ? `Archive ${Math.min(archivesCompleted + 1, archivesTotal)} of ${archivesTotal}` : 'Finding archives'}
        </span>
        {progress.startedAt && <span className="job-progress-elapsed">{formatElapsed(elapsed)}</span>}
        {onCancel && (
          <button type="button" className="btn btn-ghost btn-sm job-progress-cancel" onClick={onCancel} title="Cancel">
            <XCircle size={14} /> Cancel
          </button>
        )}
      </div>

      <ProgressSteps steps={MEDIA_STEPS} activeIndex={phaseStep} label="Import stages" />

      <div className="job-progress-bar-row">
        <div className="job-progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={overallPercent}>
          <div className={`job-progress-fill ${archivesTotal === 0 ? 'indeterminate' : ''}`} style={archivesTotal > 0 ? { width: `${overallPercent}%` } : undefined} />
        </div>
        <span className="job-progress-pct">{overallPercent}%</span>
      </div>

      <div className="media-progress-metrics">
        <Metric value={scanned} label="Scanned" />
        <Metric value={progress.uploaded || 0} label="Uploaded" />
        <Metric value={progress.duplicates || 0} label="Already there" />
        <Metric value={progress.errors || 0} label="Errors" danger={progress.errors > 0} />
      </div>
    </div>
  );
}

function Metric({ value, label, danger = false }) {
  const displayValue = typeof value === 'number' ? value.toLocaleString() : value;
  return (
    <div className={`media-progress-metric ${danger ? 'danger' : ''}`}>
      <strong>{displayValue}</strong>
      <span>{label}</span>
    </div>
  );
}

function ProgressSteps({ steps, activeIndex, label = 'Job stages' }) {
  return (
    <div className="media-progress-steps" aria-label={label} style={{ '--progress-step-count': steps.length }}>
      {steps.map((step, index) => {
        const Icon = step.icon;
        const state = index < activeIndex ? 'complete' : index === activeIndex ? 'active' : 'pending';
        return (
          <div className={`media-progress-step ${state}`} key={step.key || step.label}>
            {index > 0 && (
              <span className={`media-progress-connector ${index < activeIndex ? 'complete' : index === activeIndex ? 'active' : ''}`} aria-hidden="true" />
            )}
            <span className="media-progress-node">{state === 'complete' ? <Check size={13} /> : <Icon size={13} />}</span>
            <span>{step.label}</span>
          </div>
        );
      })}
    </div>
  );
}

function formatElapsed(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

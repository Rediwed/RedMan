import { CheckCircle2, Loader2, Clock, XCircle, Power, Pause, Box, RotateCw, ArrowUp, ArrowDown, ArrowUpDown, AlertTriangle, Ban } from 'lucide-react';
import './StatusBadge.css';

const statusConfig = {
  completed: { label: 'Completed', className: 'badge-success', icon: CheckCircle2 },
  partial: { label: 'Partial', className: 'badge-warning', icon: AlertTriangle },
  cancelled: { label: 'Cancelled', className: 'badge-warning', icon: Ban },
  running: { label: 'Running', className: 'badge-success', icon: Loader2 },
  active: { label: 'Active', className: 'badge-success', icon: Loader2 },
  enabled: { label: 'Enabled', className: 'badge-info', icon: Clock },
  disabled: { label: 'Disabled', className: 'badge-default', icon: Power },
  queued: { label: 'Queued', className: 'badge-info', icon: Clock },
  failed: { label: 'Failed', className: 'badge-danger', icon: XCircle },
  // Container states
  exited: { label: 'Exited', className: 'badge-danger', icon: Power },
  paused: { label: 'Paused', className: 'badge-warning', icon: Pause },
  created: { label: 'Created', className: 'badge-info', icon: Box },
  restarting: { label: 'Restarting', className: 'badge-warning', icon: RotateCw },
  // Directions
  push: { label: 'Push', className: 'badge-push', icon: ArrowUp },
  pull: { label: 'Pull', className: 'badge-pull', icon: ArrowDown },
  // Sync directions
  upload: { label: 'Upload', className: 'badge-push', icon: ArrowUp },
  download: { label: 'Download', className: 'badge-pull', icon: ArrowDown },
  bisync: { label: 'Bisync', className: 'badge-bisync', icon: ArrowUpDown },
};

export default function StatusBadge({ status, label }) {
  const config = statusConfig[status] || { label: status, className: 'badge-default' };
  const Icon = config.icon;
  return (
    <span className={`status-badge ${config.className}`}>
      {Icon && <Icon size={12} />}
      {label || config.label}
    </span>
  );
}

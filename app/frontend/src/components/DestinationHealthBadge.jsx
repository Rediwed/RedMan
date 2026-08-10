import { CheckCircle2, AlertTriangle, XCircle, HelpCircle } from 'lucide-react';
import './DestinationHealthBadge.css';

const STATE = {
  ok: { icon: CheckCircle2, className: 'dh-ok' },
  warn: { icon: AlertTriangle, className: 'dh-warn' },
  fail: { icon: XCircle, className: 'dh-fail' },
  unknown: { icon: HelpCircle, className: 'dh-unknown' },
};

// What the destination said, not what we hope: a redundancy summary next to
// the verdict, because the same disk means different things under each.
export default function DestinationHealthBadge({ health }) {
  const meta = STATE[health.state] || STATE.unknown;
  const Icon = meta.icon;

  const layout = health.profile
    ? `${health.profile}${health.redundant ? '' : ', no redundancy'}`
    : null;

  return (
    <span className={`destination-health ${meta.className}`} title={health.reason || undefined}>
      <Icon size={13} />
      <span className="destination-health-text">
        {health.spill || health.reason || 'Fit to receive backups'}
      </span>
      {layout && <span className="destination-health-layout">{layout}</span>}
    </span>
  );
}

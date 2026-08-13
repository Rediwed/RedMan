import { CheckCircle2, AlertTriangle, XCircle, HelpCircle } from 'lucide-react';
import './DestinationHealthBadge.css';

const STATE = {
  ok: { icon: CheckCircle2, className: 'dh-ok', label: 'Healthy' },
  warn: { icon: AlertTriangle, className: 'dh-warn', label: 'Needs attention' },
  fail: { icon: XCircle, className: 'dh-fail', label: 'Not safe to write' },
  unknown: { icon: HelpCircle, className: 'dh-unknown', label: 'Not reported' },
};

// The verdict is short enough to sit in a table cell; the sentence explaining it
// is a hover away. Putting the sentence itself here truncated it mid-word, which
// left the reader with neither the verdict nor the reason.
export default function DestinationHealthBadge({ health }) {
  const meta = STATE[health.state] || STATE.unknown;
  const Icon = meta.icon;

  const layout = health.profile
    ? `${health.profile}${health.redundant === false ? ', no redundancy' : ''}`
    : null;

  const explanation = [health.reason, health.spill].filter(Boolean).join(' — ');

  return (
    <span className={`destination-health ${meta.className}`} title={explanation || undefined}>
      <Icon size={13} />
      <span className="destination-health-text">{meta.label}</span>
      {layout && <span className="destination-health-layout">{layout}</span>}
    </span>
  );
}

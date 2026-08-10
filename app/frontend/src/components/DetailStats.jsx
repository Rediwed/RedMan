import { describeDetail } from '../utils/describe.js';
import './DetailStats.css';

// Replaces a raw JSON dump: the same facts, read as values rather than parsed.
export default function DetailStats({ detail, columns = 3 }) {
  const entries = describeDetail(detail);
  if (entries.length === 0) return null;

  const stats = entries.filter(e => e.value !== null && !e.nested);
  const longform = entries.filter(e => e.nested || (e.value && String(e.value).length > 60));

  return (
    <div className="detail-stats">
      {stats.length > 0 && (
        <dl className="detail-stats-grid" style={{ '--detail-columns': columns }}>
          {stats.map(entry => (
            <div key={entry.key} className={`detail-stat${entry.tone ? ` is-${entry.tone}` : ''}`}>
              <dt>{entry.label}</dt>
              <dd className={entry.numeric ? 'is-numeric' : undefined}>{entry.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {longform.map(entry => (
        <div key={entry.key} className="detail-stat-long">
          <span className="detail-stat-long-label">{entry.label}</span>
          <p>{entry.value ?? `${Array.isArray(entry.nested) ? entry.nested.length : Object.keys(entry.nested).length} entries`}</p>
        </div>
      ))}
    </div>
  );
}

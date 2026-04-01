import { useState, useEffect, useMemo } from 'react';
import './SchedulePicker.css';

/**
 * User-friendly schedule picker that generates cron expressions.
 * Replaces raw cron text inputs with dropdowns for frequency, time, and day.
 *
 * @param {{ value: string, onChange: (cron: string) => void }} props
 */
export default function SchedulePicker({ value, onChange }) {
  const parsed = useMemo(() => parseCron(value), [value]);
  const [showCron, setShowCron] = useState(false);
  const [customCron, setCustomCron] = useState(value);

  // Sync custom input when value changes externally
  useEffect(() => { setCustomCron(value); }, [value]);

  const handleFrequencyChange = (freq) => {
    const defaults = {
      '15min': '*/15 * * * *',
      '30min': '*/30 * * * *',
      'hourly': '0 * * * *',
      '2h': '0 */2 * * *',
      '4h': '0 */4 * * *',
      '6h': '0 */6 * * *',
      '12h': '0 */12 * * *',
      'daily': `0 ${parsed.hour} * * *`,
      'weekly': `0 ${parsed.hour} * * ${parsed.dow}`,
      'monthly': `0 ${parsed.hour} ${parsed.dom} * *`,
      'custom': value,
    };
    onChange(defaults[freq] || value);
  };

  const handleHourChange = (hour) => {
    const h = parseInt(hour);
    if (parsed.frequency === 'daily') onChange(`0 ${h} * * *`);
    else if (parsed.frequency === 'weekly') onChange(`0 ${h} * * ${parsed.dow}`);
    else if (parsed.frequency === 'monthly') onChange(`0 ${h} ${parsed.dom} * *`);
  };

  const handleMinuteChange = (minute) => {
    const m = parseInt(minute);
    if (parsed.frequency === 'hourly') onChange(`${m} * * * *`);
    else if (['2h', '4h', '6h', '12h'].includes(parsed.frequency)) {
      const interval = parsed.frequency.replace('h', '');
      onChange(`${m} */${interval} * * *`);
    }
  };

  const handleDowChange = (dow) => {
    onChange(`0 ${parsed.hour} * * ${dow}`);
  };

  const handleDomChange = (dom) => {
    onChange(`0 ${parsed.hour} ${dom} * *`);
  };

  const handleCustomApply = () => {
    onChange(customCron);
  };

  const description = describeCron(value);

  return (
    <div className="schedule-picker">
      <div className="schedule-picker-row">
        <label className="schedule-label">Frequency</label>
        <select
          value={parsed.frequency}
          onChange={e => handleFrequencyChange(e.target.value)}
          className="schedule-select"
        >
          <optgroup label="Minutes">
            <option value="15min">Every 15 minutes</option>
            <option value="30min">Every 30 minutes</option>
          </optgroup>
          <optgroup label="Hours">
            <option value="hourly">Every hour</option>
            <option value="2h">Every 2 hours</option>
            <option value="4h">Every 4 hours</option>
            <option value="6h">Every 6 hours</option>
            <option value="12h">Every 12 hours</option>
          </optgroup>
          <optgroup label="Days">
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </optgroup>
          <optgroup label="Advanced">
            <option value="custom">Custom cron</option>
          </optgroup>
        </select>
      </div>

      {/* Time-of-day picker for daily/weekly/monthly */}
      {['daily', 'weekly', 'monthly'].includes(parsed.frequency) && (
        <div className="schedule-picker-row">
          <label className="schedule-label">Time</label>
          <select
            value={parsed.hour}
            onChange={e => handleHourChange(e.target.value)}
            className="schedule-select"
          >
            {Array.from({ length: 24 }, (_, i) => (
              <option key={i} value={i}>{String(i).padStart(2, '0')}:00</option>
            ))}
          </select>
        </div>
      )}

      {/* Minute-of-hour picker for hourly/Nh intervals */}
      {['hourly', '2h', '4h', '6h', '12h'].includes(parsed.frequency) && (
        <div className="schedule-picker-row">
          <label className="schedule-label">At minute</label>
          <select
            value={parsed.minute}
            onChange={e => handleMinuteChange(e.target.value)}
            className="schedule-select"
          >
            {[0, 5, 10, 15, 20, 30, 45].map(m => (
              <option key={m} value={m}>:{String(m).padStart(2, '0')}</option>
            ))}
          </select>
        </div>
      )}

      {/* Day-of-week for weekly */}
      {parsed.frequency === 'weekly' && (
        <div className="schedule-picker-row">
          <label className="schedule-label">Day</label>
          <select
            value={parsed.dow}
            onChange={e => handleDowChange(e.target.value)}
            className="schedule-select"
          >
            {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((name, i) => (
              <option key={i} value={i}>{name}</option>
            ))}
          </select>
        </div>
      )}

      {/* Day-of-month for monthly */}
      {parsed.frequency === 'monthly' && (
        <div className="schedule-picker-row">
          <label className="schedule-label">Day</label>
          <select
            value={parsed.dom}
            onChange={e => handleDomChange(e.target.value)}
            className="schedule-select"
          >
            {Array.from({ length: 28 }, (_, i) => (
              <option key={i + 1} value={i + 1}>{ordinal(i + 1)}</option>
            ))}
          </select>
        </div>
      )}

      {/* Custom cron input */}
      {parsed.frequency === 'custom' && (
        <div className="schedule-picker-row schedule-custom">
          <input
            value={customCron}
            onChange={e => setCustomCron(e.target.value)}
            onBlur={handleCustomApply}
            onKeyDown={e => e.key === 'Enter' && handleCustomApply()}
            placeholder="0 2 * * *"
            className="schedule-cron-input"
            spellCheck={false}
          />
          <span className="schedule-hint">5-field cron: min hour dom month dow</span>
        </div>
      )}

      {/* Human-readable description */}
      <div className="schedule-description">{description}</div>

      {/* Toggle raw cron display */}
      {parsed.frequency !== 'custom' && (
        <button
          type="button"
          className="schedule-toggle-cron"
          onClick={() => setShowCron(!showCron)}
        >
          {showCron ? '▾ Hide cron' : '▸ Show cron'}
        </button>
      )}
      {showCron && parsed.frequency !== 'custom' && (
        <code className="schedule-cron-display">{value}</code>
      )}
    </div>
  );
}

/** Parse a cron expression into a structured object for the UI */
function parseCron(cron) {
  const parts = (cron || '0 * * * *').trim().split(/\s+/);
  const [min, hour, dom, , dow] = parts;

  // Detect frequency from pattern
  if (min.startsWith('*/15')) return { frequency: '15min', minute: 0, hour: 0, dow: 0, dom: 1 };
  if (min.startsWith('*/30')) return { frequency: '30min', minute: 0, hour: 0, dow: 0, dom: 1 };

  const m = min === '*' ? 0 : parseInt(min) || 0;

  if (hour.startsWith('*/')) {
    const interval = parseInt(hour.replace('*/', ''));
    const freqMap = { 2: '2h', 4: '4h', 6: '6h', 8: '6h', 12: '12h' };
    return { frequency: freqMap[interval] || 'custom', minute: m, hour: 0, dow: 0, dom: 1 };
  }

  if (hour === '*' && dom === '*') return { frequency: 'hourly', minute: m, hour: 0, dow: 0, dom: 1 };

  const h = parseInt(hour) || 0;

  if (dow !== '*' && dom === '*') return { frequency: 'weekly', minute: m, hour: h, dow: parseInt(dow) || 0, dom: 1 };
  if (dom !== '*' && dow === '*') return { frequency: 'monthly', minute: m, hour: h, dow: 0, dom: parseInt(dom) || 1 };
  if (hour !== '*' && dom === '*' && dow === '*') return { frequency: 'daily', minute: m, hour: h, dow: 0, dom: 1 };

  return { frequency: 'custom', minute: m, hour: h, dow: parseInt(dow) || 0, dom: parseInt(dom) || 1 };
}

/** Generate human-readable description of a cron expression */
export function describeCron(cron) {
  const p = parseCron(cron);
  const pad = n => String(n).padStart(2, '0');
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  switch (p.frequency) {
    case '15min': return 'Runs every 15 minutes';
    case '30min': return 'Runs every 30 minutes';
    case 'hourly': return `Runs every hour at :${pad(p.minute)}`;
    case '2h': return `Runs every 2 hours at :${pad(p.minute)}`;
    case '4h': return `Runs every 4 hours at :${pad(p.minute)}`;
    case '6h': return `Runs every 6 hours at :${pad(p.minute)}`;
    case '12h': return `Runs every 12 hours at :${pad(p.minute)}`;
    case 'daily': return `Runs daily at ${pad(p.hour)}:00`;
    case 'weekly': return `Runs every ${days[p.dow]} at ${pad(p.hour)}:00`;
    case 'monthly': return `Runs on the ${ordinal(p.dom)} of each month at ${pad(p.hour)}:00`;
    case 'custom': return `Custom schedule: ${cron}`;
    default: return cron;
  }
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

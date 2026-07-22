import { useState, useEffect, useMemo } from 'react';
import { describeCron, ordinal, parseCron } from '../utils/schedule.js';
import './SchedulePicker.css';

export { describeCron } from '../utils/schedule.js';

/**
 * User-friendly schedule picker that generates cron expressions.
 * Replaces raw cron text inputs with dropdowns for frequency, time, and day.
 *
 * @param {{ value: string, onChange: (cron: string) => void }} props
 */
export default function SchedulePicker({ value, onChange }) {
  const parsed = useMemo(() => parseCron(value), [value]);
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
      '8h': '0 */8 * * *',
      '12h': '0 */12 * * *',
      'daily': `${parsed.minute} ${parsed.hour} * * *`,
      'weekly': `${parsed.minute} ${parsed.hour} * * ${parsed.dow}`,
      'monthly': `${parsed.minute} ${parsed.hour} ${parsed.dom} * *`,
      'custom': value,
    };
    onChange(defaults[freq] || value);
  };

  const handleHourChange = (hour) => {
    const h = parseInt(hour);
    if (parsed.frequency === 'daily') onChange(`${parsed.minute} ${h} * * *`);
    else if (parsed.frequency === 'weekly') onChange(`${parsed.minute} ${h} * * ${parsed.dow}`);
    else if (parsed.frequency === 'monthly') onChange(`${parsed.minute} ${h} ${parsed.dom} * *`);
  };

  const handleMinuteChange = (minute) => {
    const m = parseInt(minute);
    if (parsed.frequency === 'hourly') onChange(`${m} * * * *`);
    else if (['2h', '4h', '6h', '8h', '12h'].includes(parsed.frequency)) {
      const interval = parsed.frequency.replace('h', '');
      onChange(`${m} */${interval} * * *`);
    }
  };

  const handleTimeMinuteChange = (minute) => {
    const value = parseInt(minute);
    if (parsed.frequency === 'daily') onChange(`${value} ${parsed.hour} * * *`);
    else if (parsed.frequency === 'weekly') onChange(`${value} ${parsed.hour} * * ${parsed.dow}`);
    else if (parsed.frequency === 'monthly') onChange(`${value} ${parsed.hour} ${parsed.dom} * *`);
  };

  const handleDowChange = (dow) => {
    onChange(`${parsed.minute} ${parsed.hour} * * ${dow}`);
  };

  const handleDomChange = (dom) => {
    onChange(`${parsed.minute} ${parsed.hour} ${dom} * *`);
  };

  const handleCustomApply = () => {
    onChange(customCron);
  };

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
            <option value="8h">Every 8 hours</option>
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
              <option key={i} value={i}>{String(i).padStart(2, '0')}</option>
            ))}
          </select>
          <span>:</span>
          <select value={parsed.minute} onChange={e => handleTimeMinuteChange(e.target.value)} className="schedule-select">
            {[0, 5, 10, 15, 20, 30, 45].map(minute => (
              <option key={minute} value={minute}>{String(minute).padStart(2, '0')}</option>
            ))}
          </select>
        </div>
      )}

      {/* Minute-of-hour picker for hourly/Nh intervals */}
      {['hourly', '2h', '4h', '6h', '8h', '12h'].includes(parsed.frequency) && (
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


    </div>
  );
}

const MODES = [
  { value: 'global', label: 'Use global' },
  { value: 'custom', label: 'Custom' },
  { value: 'silent', label: 'Silent' },
];

const EVENTS = [
  { key: 'notify_on_start', label: 'On start' },
  { key: 'notify_on_success', label: 'On success' },
  { key: 'notify_on_failure', label: 'On failure' },
];

export default function NotificationPolicyField({ form, onChange, variant = 'buttons' }) {
  const segmented = variant === 'segmented';

  return (
    <div className="form-group notification-policy">
      <label>Notifications</label>
      <div
        className={segmented ? 'segmented' : undefined}
        style={segmented ? undefined : { display: 'flex', gap: 'var(--space-sm)' }}
        role="group"
        aria-label="Notification mode"
      >
        {MODES.map(mode => (
          <button
            key={mode.value}
            type="button"
            aria-pressed={form.notify_mode === mode.value}
            className={segmented
              ? `segmented-option ${form.notify_mode === mode.value ? 'active' : ''}`
              : `btn btn-sm ${form.notify_mode === mode.value ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => onChange({ notify_mode: mode.value })}
          >
            {mode.label}
          </button>
        ))}
      </div>

      <span className="form-hint" aria-live="polite">
        {form.notify_mode === 'global' && 'Follows notification settings from Settings → Notifications'}
        {form.notify_mode === 'silent' && 'No notifications for this job'}
      </span>

      {form.notify_mode === 'custom' && (
        <div
          className={segmented ? 'custom-notify-row' : undefined}
          style={segmented ? undefined : { display: 'flex', gap: 'var(--space-md)', marginTop: 'var(--space-xs)' }}
        >
          {EVENTS.map(event => (
            <div key={event.key} className="toggle-group">
              <button
                type="button"
                className={`toggle ${form[event.key] ? 'active' : ''}`}
                aria-label={event.label}
                aria-pressed={Boolean(form[event.key])}
                onClick={() => onChange({ [event.key]: !form[event.key] })}
              />
              <span>{event.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
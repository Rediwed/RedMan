import { useState } from 'react';
import { KeyRound, UserRound } from 'lucide-react';
import { changeAuthPassword } from '../api/index.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import './AccountPage.css';

export default function AccountPage() {
  const auth = useAuth();
  const [form, setForm] = useState({ current_password: '', new_password: '', confirm: '' });
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);

  async function submit(event) {
    event.preventDefault();
    setResult(null);
    if (form.new_password !== form.confirm) {
      setResult({ type: 'error', message: 'Passwords do not match' });
      return;
    }
    setSubmitting(true);
    try {
      await changeAuthPassword(form);
      setForm({ current_password: '', new_password: '', confirm: '' });
      setResult({ type: 'success', message: 'Password changed and other sessions revoked.' });
    } catch (err) {
      setResult({ type: 'error', message: err.message });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="account-page">
      <div className="page-header"><h1><UserRound size={24} aria-hidden="true" /> Account</h1></div>
      {result && <div className={`alert alert-${result.type}`} role={result.type === 'error' ? 'alert' : 'status'}>{result.message}</div>}
      <div className="settings-cards-grid">
        <section className="card">
          <div className="card-header"><h3><UserRound size={16} aria-hidden="true" /> Current identity</h3></div>
          <dl className="self-account-details">
            <dt>Name</dt><dd>{auth.user.displayName || auth.user.username}</dd>
            <dt>Username</dt><dd><code>{auth.user.username}</code></dd>
            <dt>Provider</dt><dd>{auth.user.provider}</dd>
            <dt>Role</dt><dd>{auth.user.role}</dd>
          </dl>
        </section>
        {auth.mode === 'local' && auth.user.provider === 'local' && (
          <section className="card">
            <div className="card-header"><h3><KeyRound size={16} aria-hidden="true" /> Change password</h3></div>
            <form onSubmit={submit}>
              <div className="form-group"><label htmlFor="self-current-password">Current password</label><input id="self-current-password" type="password" autoComplete="current-password" value={form.current_password} onChange={event => setForm({ ...form, current_password: event.target.value })} required /></div>
              <div className="form-group"><label htmlFor="self-new-password">New password</label><input id="self-new-password" type="password" autoComplete="new-password" minLength="12" maxLength="128" value={form.new_password} onChange={event => setForm({ ...form, new_password: event.target.value })} required /></div>
              <div className="form-group"><label htmlFor="self-confirm-password">Confirm password</label><input id="self-confirm-password" type="password" autoComplete="new-password" minLength="12" maxLength="128" value={form.confirm} onChange={event => setForm({ ...form, confirm: event.target.value })} required /></div>
              <button type="submit" className="btn btn-primary" disabled={submitting}>{submitting ? 'Changing...' : 'Change password'}</button>
            </form>
          </section>
        )}
      </div>
    </div>
  );
}

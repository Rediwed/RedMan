import { useState } from 'react';
import { KeyRound, Loader2, RotateCcw, ShieldCheck } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext.jsx';
import './LoginPage.css';

export default function LoginPage() {
  const auth = useAuth();
  const [view, setView] = useState('login');
  const [form, setForm] = useState({
    username: '',
    password: '',
    confirmPassword: '',
    displayName: '',
    email: '',
    bootstrapToken: '',
    recoveryToken: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(auth.error);
  const [message, setMessage] = useState(null);

  function update(key, value) {
    setForm(current => ({ ...current, [key]: value }));
  }

  async function submit(event) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    if (form.password !== form.confirmPassword && (auth.requiresBootstrap || view === 'recover')) {
      setError('Passwords do not match');
      return;
    }
    setSubmitting(true);
    try {
      if (auth.requiresBootstrap) {
        await auth.bootstrap({
          bootstrap_token: form.bootstrapToken,
          username: form.username,
          password: form.password,
          display_name: form.displayName,
          email: form.email,
        });
      } else if (view === 'recover') {
        await auth.recover({
          username: form.username,
          recovery_token: form.recoveryToken,
          new_password: form.password,
        });
        setMessage('Password reset. Sign in with your new password.');
        setView('login');
        setForm(current => ({ ...current, password: '', confirmPassword: '', recoveryToken: '' }));
      } else {
        await auth.login({ username: form.username, password: form.password });
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  if (auth.mode === 'proxy') {
    return (
      <main className="auth-page">
        <section className="auth-panel" aria-labelledby="auth-title">
          <div className="auth-brand"><ShieldCheck size={30} aria-hidden="true" /><span>RedMan</span></div>
          <h1 id="auth-title">Proxy authentication required</h1>
          <p>Open RedMan through its authenticated Pangolin address. Direct requests cannot supply a trusted identity.</p>
          {auth.error && <div className="alert alert-error" role="alert">{auth.error}</div>}
          <button type="button" className="btn btn-primary" onClick={auth.refresh}>
            <RotateCcw size={16} aria-hidden="true" /> Retry
          </button>
        </section>
      </main>
    );
  }

  const bootstrap = auth.requiresBootstrap;
  const recovery = !bootstrap && view === 'recover';
  return (
    <main className="auth-page">
      <section className="auth-panel" aria-labelledby="auth-title">
        <div className="auth-brand"><ShieldCheck size={30} aria-hidden="true" /><span>RedMan</span></div>
        <h1 id="auth-title">{bootstrap ? 'Create the first administrator' : recovery ? 'Recover account' : 'Sign in'}</h1>
        {bootstrap && !auth.bootstrapConfigured && (
          <div className="alert alert-error" role="alert">Set REDMAN_BOOTSTRAP_TOKEN and restart RedMan before creating the first administrator.</div>
        )}
        <form onSubmit={submit}>
          {bootstrap && (
            <div className="form-group">
              <label htmlFor="bootstrap-token">Bootstrap token</label>
              <input id="bootstrap-token" type="password" autoComplete="off" value={form.bootstrapToken} onChange={event => update('bootstrapToken', event.target.value)} required />
            </div>
          )}
          <div className="form-group">
            <label htmlFor="auth-username">Username</label>
            <input id="auth-username" autoComplete="username" value={form.username} onChange={event => update('username', event.target.value)} minLength="3" maxLength="64" required autoFocus />
          </div>
          {bootstrap && (
            <>
              <div className="form-group">
                <label htmlFor="auth-display-name">Display name</label>
                <input id="auth-display-name" autoComplete="name" value={form.displayName} onChange={event => update('displayName', event.target.value)} />
              </div>
              <div className="form-group">
                <label htmlFor="auth-email">Email</label>
                <input id="auth-email" type="email" autoComplete="email" value={form.email} onChange={event => update('email', event.target.value)} />
              </div>
            </>
          )}
          {recovery && (
            <div className="form-group">
              <label htmlFor="recovery-token">One-time recovery token</label>
              <input id="recovery-token" type="password" autoComplete="off" value={form.recoveryToken} onChange={event => update('recoveryToken', event.target.value)} required />
            </div>
          )}
          <div className="form-group">
            <label htmlFor="auth-password">{recovery ? 'New password' : 'Password'}</label>
            <input id="auth-password" type="password" autoComplete={recovery || bootstrap ? 'new-password' : 'current-password'} value={form.password} onChange={event => update('password', event.target.value)} minLength="12" maxLength="128" required />
          </div>
          {(bootstrap || recovery) && (
            <div className="form-group">
              <label htmlFor="auth-confirm-password">Confirm password</label>
              <input id="auth-confirm-password" type="password" autoComplete="new-password" value={form.confirmPassword} onChange={event => update('confirmPassword', event.target.value)} minLength="12" maxLength="128" required />
            </div>
          )}
          {error && <div className="alert alert-error" role="alert">{error}</div>}
          {message && <div className="alert alert-success" role="status">{message}</div>}
          <button type="submit" className="btn btn-primary auth-submit" disabled={submitting || (bootstrap && !auth.bootstrapConfigured)}>
            {submitting ? <Loader2 size={16} className="spin" aria-hidden="true" /> : <KeyRound size={16} aria-hidden="true" />}
            {submitting ? 'Working...' : bootstrap ? 'Create administrator' : recovery ? 'Reset password' : 'Sign in'}
          </button>
        </form>
        {!bootstrap && (
          <button type="button" className="auth-link" onClick={() => { setView(recovery ? 'login' : 'recover'); setError(null); setMessage(null); }}>
            {recovery ? 'Back to sign in' : 'Use a recovery token'}
          </button>
        )}
      </section>
    </main>
  );
}

import { useEffect, useState } from 'react';
import { KeyRound, Plus, RefreshCw, ShieldCheck, UserRound, Users } from 'lucide-react';
import {
  changeAuthPassword,
  createAuthUser,
  getAuthAudit,
  getAuthUsers,
  revokeAuthUserSessions,
  updateAuthUser,
} from '../api/index.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import Dialog from './Dialog.jsx';
import './AccountSettings.css';

export default function AccountSettings() {
  const auth = useAuth();
  const [users, setUsers] = useState([]);
  const [audit, setAudit] = useState({ entries: [], page: 1, totalPages: 1 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState({ username: '', display_name: '', email: '', role: 'viewer', password: '', confirm: '' });
  const [passwordForm, setPasswordForm] = useState({ current_password: '', new_password: '', confirm: '' });
  const [changingPassword, setChangingPassword] = useState(false);

  async function load(page = 1) {
    setLoading(true);
    setError(null);
    try {
      const [userRows, auditRows] = await Promise.all([getAuthUsers(), getAuthAudit(page)]);
      setUsers(userRows);
      setAudit(auditRows);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function createUser(event) {
    event.preventDefault();
    setError(null);
    if (createForm.password !== createForm.confirm) {
      setError('Passwords do not match');
      return;
    }
    setCreating(true);
    try {
      await createAuthUser(createForm);
      setShowCreate(false);
      setCreateForm({ username: '', display_name: '', email: '', role: 'viewer', password: '', confirm: '' });
      setResult('Account created.');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  }

  async function updateUser(user, updates) {
    setError(null);
    try {
      await updateAuthUser(user.id, updates);
      setResult(`${user.username} updated.`);
      await load(audit.page);
    } catch (err) {
      setError(err.message);
    }
  }

  async function revokeSessions(user) {
    setError(null);
    try {
      const response = await revokeAuthUserSessions(user.id);
      setResult(`Revoked ${response.revoked} session(s) for ${user.username}.`);
      await load(audit.page);
    } catch (err) {
      setError(err.message);
    }
  }

  async function changePassword(event) {
    event.preventDefault();
    setError(null);
    if (passwordForm.new_password !== passwordForm.confirm) {
      setError('Passwords do not match');
      return;
    }
    setChangingPassword(true);
    try {
      await changeAuthPassword(passwordForm);
      setPasswordForm({ current_password: '', new_password: '', confirm: '' });
      setResult('Password changed and other sessions revoked.');
    } catch (err) {
      setError(err.message);
    } finally {
      setChangingPassword(false);
    }
  }

  return (
    <div className="account-settings">
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      {result && <div className="alert alert-success" role="status">{result}</div>}

      <div className="settings-cards-grid">
        <div className="card">
          <div className="card-header"><h3><UserRound size={16} aria-hidden="true" /> Current session</h3></div>
          <dl className="account-summary">
            <dt>Account</dt><dd>{auth.user.displayName || auth.user.username}</dd>
            <dt>Username</dt><dd><code>{auth.user.username}</code></dd>
            <dt>Provider</dt><dd>{auth.user.provider}</dd>
            <dt>Role</dt><dd>{auth.user.role}</dd>
          </dl>
        </div>

        {auth.mode === 'local' && auth.user.provider === 'local' && (
          <div className="card">
            <div className="card-header"><h3><KeyRound size={16} aria-hidden="true" /> Change password</h3></div>
            <form onSubmit={changePassword}>
              <div className="form-group">
                <label htmlFor="current-password">Current password</label>
                <input id="current-password" type="password" autoComplete="current-password" value={passwordForm.current_password} onChange={event => setPasswordForm({ ...passwordForm, current_password: event.target.value })} required />
              </div>
              <div className="form-group">
                <label htmlFor="new-password">New password</label>
                <input id="new-password" type="password" autoComplete="new-password" minLength="12" maxLength="128" value={passwordForm.new_password} onChange={event => setPasswordForm({ ...passwordForm, new_password: event.target.value })} required />
              </div>
              <div className="form-group">
                <label htmlFor="confirm-new-password">Confirm password</label>
                <input id="confirm-new-password" type="password" autoComplete="new-password" minLength="12" maxLength="128" value={passwordForm.confirm} onChange={event => setPasswordForm({ ...passwordForm, confirm: event.target.value })} required />
              </div>
              <button type="submit" className="btn btn-primary" disabled={changingPassword}>{changingPassword ? 'Changing...' : 'Change password'}</button>
            </form>
          </div>
        )}
      </div>

      <section className="account-section">
        <div className="account-section-header">
          <h2><Users size={18} aria-hidden="true" /> Accounts</h2>
          {auth.mode === 'local' && <button type="button" className="btn btn-primary btn-sm" onClick={() => setShowCreate(true)}><Plus size={14} aria-hidden="true" /> Add account</button>}
        </div>
        {loading ? <p>Loading accounts...</p> : (
          <div className="table-wrapper">
            <table>
              <thead><tr><th>Account</th><th>Provider</th><th>Role</th><th>Enabled</th><th>Last login</th><th></th></tr></thead>
              <tbody>
                {users.map(user => (
                  <tr key={user.id}>
                    <td><strong>{user.displayName || user.username}</strong><br /><code>{user.username}</code></td>
                    <td>{user.provider}</td>
                    <td>
                      <select value={user.role} aria-label={`Role for ${user.username}`} onChange={event => updateUser(user, { role: event.target.value })}>
                        <option value="admin">Admin</option>
                        <option value="viewer">Viewer</option>
                      </select>
                    </td>
                    <td><input type="checkbox" aria-label={`Enable ${user.username}`} checked={user.enabled} onChange={event => updateUser(user, { enabled: event.target.checked })} /></td>
                    <td>{user.lastLoginAt || 'Never'}</td>
                    <td><button type="button" className="btn btn-secondary btn-sm" onClick={() => revokeSessions(user)}><RefreshCw size={14} aria-hidden="true" /> Revoke sessions</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="account-section">
        <div className="account-section-header"><h2><ShieldCheck size={18} aria-hidden="true" /> Authentication audit</h2></div>
        <div className="table-wrapper">
          <table>
            <thead><tr><th>Time</th><th>Event</th><th>Account</th><th>Actor</th><th>IP</th></tr></thead>
            <tbody>
              {audit.entries.map(entry => (
                <tr key={entry.id}>
                  <td>{entry.created_at}</td><td><code>{entry.event}</code></td><td>{entry.username || '—'}</td><td>{entry.actor_username || '—'}</td><td><code>{entry.ip_address || '—'}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {audit.totalPages > 1 && (
          <div className="pagination">
            <button type="button" className="btn btn-secondary btn-sm" disabled={audit.page <= 1} onClick={() => load(audit.page - 1)}>Prev</button>
            <span>Page {audit.page} of {audit.totalPages}</span>
            <button type="button" className="btn btn-secondary btn-sm" disabled={audit.page >= audit.totalPages} onClick={() => load(audit.page + 1)}>Next</button>
          </div>
        )}
      </section>

      {showCreate && (
        <Dialog
          title="Add local account"
          onClose={() => setShowCreate(false)}
          closeOnOverlay={!creating}
          footer={(
            <div className="modal-footer-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setShowCreate(false)} disabled={creating}>Cancel</button>
              <button type="submit" form="create-auth-user" className="btn btn-primary" disabled={creating}>{creating ? 'Creating...' : 'Create account'}</button>
            </div>
          )}
        >
          <form id="create-auth-user" onSubmit={createUser}>
            <div className="form-group"><label htmlFor="new-user-username">Username</label><input id="new-user-username" value={createForm.username} onChange={event => setCreateForm({ ...createForm, username: event.target.value })} minLength="3" maxLength="64" required /></div>
            <div className="form-group"><label htmlFor="new-user-display-name">Display name</label><input id="new-user-display-name" value={createForm.display_name} onChange={event => setCreateForm({ ...createForm, display_name: event.target.value })} /></div>
            <div className="form-group"><label htmlFor="new-user-email">Email</label><input id="new-user-email" type="email" value={createForm.email} onChange={event => setCreateForm({ ...createForm, email: event.target.value })} /></div>
            <div className="form-group"><label htmlFor="new-user-role">Role</label><select id="new-user-role" value={createForm.role} onChange={event => setCreateForm({ ...createForm, role: event.target.value })}><option value="viewer">Viewer</option><option value="admin">Admin</option></select></div>
            <div className="form-group"><label htmlFor="new-user-password">Password</label><input id="new-user-password" type="password" autoComplete="new-password" minLength="12" maxLength="128" value={createForm.password} onChange={event => setCreateForm({ ...createForm, password: event.target.value })} required /></div>
            <div className="form-group"><label htmlFor="new-user-confirm">Confirm password</label><input id="new-user-confirm" type="password" autoComplete="new-password" minLength="12" maxLength="128" value={createForm.confirm} onChange={event => setCreateForm({ ...createForm, confirm: event.target.value })} required /></div>
          </form>
        </Dialog>
      )}
    </div>
  );
}

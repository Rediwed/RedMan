import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import {
  bootstrapAuth,
  getAuthSession,
  getAuthStatus,
  loginAuth,
  logoutAuth,
  recoverAuth,
} from '../api/index.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [state, setState] = useState({
    loading: true,
    mode: null,
    user: null,
    requiresBootstrap: false,
    bootstrapConfigured: false,
    error: null,
  });

  const refresh = useCallback(async () => {
    setState(current => ({ ...current, loading: true, error: null }));
    try {
      const status = await getAuthStatus();
      if (status.mode === 'local' && status.requiresBootstrap) {
        setState({ ...status, loading: false, user: null, error: null });
        return;
      }
      try {
        const session = await getAuthSession();
        setState({ ...status, mode: session.mode, loading: false, user: session.user, error: null });
      } catch (err) {
        setState({
          ...status,
          loading: false,
          user: null,
          error: err.status && err.status !== 401 ? err.message : null,
        });
      }
    } catch (err) {
      setState(current => ({ ...current, loading: false, user: null, error: err.message }));
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    const requireAuth = () => setState(current => ({ ...current, user: null, error: 'Your session expired. Sign in again.' }));
    globalThis.addEventListener('redman:auth-required', requireAuth);
    return () => globalThis.removeEventListener('redman:auth-required', requireAuth);
  }, []);

  const login = useCallback(async credentials => {
    const result = await loginAuth(credentials);
    setState(current => ({ ...current, loading: false, user: result.user, mode: result.mode, error: null, requiresBootstrap: false }));
    return result;
  }, []);

  const bootstrap = useCallback(async data => {
    const result = await bootstrapAuth(data);
    setState(current => ({ ...current, loading: false, user: result.user, mode: result.mode, error: null, requiresBootstrap: false }));
    return result;
  }, []);

  const recover = useCallback(data => recoverAuth(data), []);

  const logout = useCallback(async () => {
    try { await logoutAuth(); } finally {
      setState(current => ({ ...current, user: null, error: null }));
    }
  }, []);

  const isAdmin = state.user?.role === 'admin';
  const can = useCallback(permission => {
    if (!state.user) return false;
    if (state.user.role === 'admin') return true;
    return ['read', 'account:self'].includes(permission);
  }, [state.user]);

  return (
    <AuthContext.Provider value={{ ...state, isAdmin, can, login, bootstrap, recover, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
}

const VALID_MODES = new Set(['proxy', 'local']);
const VALID_ROLES = new Set(['admin', 'viewer']);

function boundedInteger(value, fallback, minimum, maximum, name) {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function validateTrustedProxies(value) {
  const entries = String(value || '').split(',').map(entry => entry.trim()).filter(Boolean);
  if (entries.length === 0) throw new Error('TRUSTED_PROXIES must explicitly list the proxy source IP/CIDR in production');
  for (const entry of entries) {
    if (entry === '*') throw new Error('TRUSTED_PROXIES=* is forbidden in production');
    const [address, prefixText] = entry.split('/');
    if (!/^[0-9a-f:.]+$/i.test(address)) throw new Error(`Invalid TRUSTED_PROXIES entry: ${entry}`);
    if (prefixText !== undefined) {
      const prefix = Number.parseInt(prefixText, 10);
      const required = address.includes(':') ? 128 : 32;
      if (!Number.isFinite(prefix) || prefix !== required) {
        throw new Error(`TRUSTED_PROXIES must identify exact proxy hosts (${address.includes(':') ? '/128' : '/32'}): ${entry}`);
      }
    }
  }
  return entries;
}

export function getAuthConfig(env = process.env) {
  const developmentBypass =
    env.AUTH_DISABLED === 'true' &&
    env.REDMAN_LOCAL_DEV === '1' &&
    env.NODE_ENV !== 'production';

  if (env.AUTH_DISABLED === 'true' && !developmentBypass) {
    console.warn('[SECURITY] AUTH_DISABLED ignored outside the double-gated development mode');
  }

  let mode = env.AUTH_MODE?.trim().toLowerCase();
  if (developmentBypass) mode = 'development';
  if (!mode) {
    if (env.NODE_ENV === 'production') {
      throw new Error('AUTH_MODE must be explicitly set to proxy or local in production');
    }
    mode = 'proxy';
  }
  if (mode !== 'development' && !VALID_MODES.has(mode)) {
    throw new Error('AUTH_MODE must be proxy or local');
  }

  const proxyAutoProvisionRole = env.PROXY_AUTO_PROVISION_ROLE?.trim().toLowerCase() || null;
  if (proxyAutoProvisionRole && !VALID_ROLES.has(proxyAutoProvisionRole)) {
    throw new Error('PROXY_AUTO_PROVISION_ROLE must be admin, viewer, or unset');
  }

  const sessionIdleMinutes = boundedInteger(env.SESSION_IDLE_MINUTES, 30, 5, 1440, 'SESSION_IDLE_MINUTES');
  const sessionAbsoluteHours = boundedInteger(env.SESSION_ABSOLUTE_HOURS, 24, 1, 720, 'SESSION_ABSOLUTE_HOURS');
  if (sessionAbsoluteHours * 60 <= sessionIdleMinutes) {
    throw new Error('SESSION_ABSOLUTE_HOURS must exceed SESSION_IDLE_MINUTES');
  }

  const secureCookies = env.NODE_ENV === 'production'
    ? env.SESSION_COOKIE_SECURE !== 'false'
    : env.SESSION_COOKIE_SECURE === 'true';
  if (mode === 'local' && env.NODE_ENV === 'production' && !secureCookies) {
    throw new Error('Local authentication requires secure session cookies in production');
  }

  let publicOrigin = null;
  if (env.REDMAN_PUBLIC_ORIGIN) {
    try {
      const parsed = new URL(env.REDMAN_PUBLIC_ORIGIN);
      if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error();
      publicOrigin = parsed.origin;
    } catch {
      throw new Error('REDMAN_PUBLIC_ORIGIN must be an origin such as https://redman.example.com');
    }
  }
  if (mode === 'local' && env.NODE_ENV === 'production' && (!publicOrigin || !publicOrigin.startsWith('https://'))) {
    throw new Error('Production local authentication requires an HTTPS REDMAN_PUBLIC_ORIGIN');
  }
  if (mode === 'proxy' && env.NODE_ENV === 'production' && (!publicOrigin || !publicOrigin.startsWith('https://'))) {
    throw new Error('Production proxy authentication requires an HTTPS REDMAN_PUBLIC_ORIGIN');
  }
  const trustedProxies = env.NODE_ENV === 'production'
    ? validateTrustedProxies(env.TRUSTED_PROXIES)
    : String(env.TRUSTED_PROXIES || '127.0.0.1/8,::1/128').split(',').map(entry => entry.trim()).filter(Boolean);
  const allowedCredentialOrigins = new Set(publicOrigin
    ? [publicOrigin]
    : ['http://localhost:5173', 'http://localhost:5175', 'http://localhost:8090']);

  return Object.freeze({
    mode,
    developmentBypass,
    proxyAutoProvisionRole,
    bootstrapConfigured: Boolean(env.REDMAN_BOOTSTRAP_TOKEN),
    bootstrapToken: env.REDMAN_BOOTSTRAP_TOKEN || null,
    secureCookies,
    sessionIdleMinutes,
    sessionAbsoluteHours,
    recoveryMinutes: boundedInteger(env.RECOVERY_TOKEN_MINUTES, 15, 5, 60, 'RECOVERY_TOKEN_MINUTES'),
    publicOrigin,
    allowedCredentialOrigins,
    trustedProxies,
  });
}

export const authConfig = getAuthConfig();

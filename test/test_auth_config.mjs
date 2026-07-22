import assert from 'node:assert/strict';
import { getAuthConfig } from '../app/backend/src/services/authConfig.js';

assert.throws(() => getAuthConfig({ NODE_ENV: 'production' }), /AUTH_MODE/);
assert.throws(() => getAuthConfig({ NODE_ENV: 'production', AUTH_MODE: 'oidc' }), /proxy or local/);
assert.throws(() => getAuthConfig({ NODE_ENV: 'production', AUTH_MODE: 'local', SESSION_COOKIE_SECURE: 'false' }), /secure session cookies/);
assert.throws(() => getAuthConfig({ NODE_ENV: 'production', AUTH_MODE: 'local' }), /REDMAN_PUBLIC_ORIGIN/);
assert.throws(() => getAuthConfig({ NODE_ENV: 'production', AUTH_MODE: 'local', REDMAN_PUBLIC_ORIGIN: 'http://redman.example.com' }), /HTTPS/);
assert.throws(() => getAuthConfig({ NODE_ENV: 'production', AUTH_MODE: 'proxy', REDMAN_PUBLIC_ORIGIN: 'https://redman.example.com' }), /TRUSTED_PROXIES/);
assert.throws(() => getAuthConfig({ NODE_ENV: 'production', AUTH_MODE: 'proxy', REDMAN_PUBLIC_ORIGIN: 'https://redman.example.com', TRUSTED_PROXIES: '*' }), /forbidden/);
assert.throws(() => getAuthConfig({ NODE_ENV: 'production', AUTH_MODE: 'proxy', REDMAN_PUBLIC_ORIGIN: 'https://redman.example.com', TRUSTED_PROXIES: '192.168.0.0/24' }), /exact proxy hosts/);
assert.throws(() => getAuthConfig({ NODE_ENV: 'production', AUTH_MODE: 'proxy', REDMAN_PUBLIC_ORIGIN: 'https://redman.example.com', TRUSTED_PROXIES: 'fd00::/64' }), /exact proxy hosts/);
assert.throws(() => getAuthConfig({ NODE_ENV: 'production', AUTH_MODE: 'proxy', PROXY_AUTO_PROVISION_ROLE: 'owner' }), /admin, viewer/);

const proxy = getAuthConfig({
  NODE_ENV: 'production',
  AUTH_MODE: 'proxy',
  PROXY_AUTO_PROVISION_ROLE: 'viewer',
  REDMAN_PUBLIC_ORIGIN: 'https://redman.example.com',
  TRUSTED_PROXIES: '172.20.0.5/32',
});
assert.equal(proxy.mode, 'proxy');
assert.equal(proxy.proxyAutoProvisionRole, 'viewer');
assert.equal(proxy.secureCookies, true);
assert.deepEqual(proxy.trustedProxies, ['172.20.0.5/32']);

const local = getAuthConfig({
  NODE_ENV: 'production',
  AUTH_MODE: 'local',
  REDMAN_BOOTSTRAP_TOKEN: 'configured-outside-app',
  REDMAN_PUBLIC_ORIGIN: 'https://redman.example.com',
  TRUSTED_PROXIES: '172.20.0.5/32',
  SESSION_IDLE_MINUTES: '30',
  SESSION_ABSOLUTE_HOURS: '24',
});
assert.equal(local.mode, 'local');
assert.equal(local.bootstrapConfigured, true);
assert.equal(local.publicOrigin, 'https://redman.example.com');

const development = getAuthConfig({
  NODE_ENV: 'development',
  AUTH_DISABLED: 'true',
  REDMAN_LOCAL_DEV: '1',
});
assert.equal(development.mode, 'development');
assert.equal(development.developmentBypass, true);

console.log('Authentication config: explicit modes, secure cookies, roles, and development gate passed');
import { normalizePath } from '../middleware/validation.js';
import { validatePrivatePeerBaseUrl } from './peerUrlPolicy.js';

function text(value, maxLength = 500) {
  const normalized = String(value ?? '');
  if (normalized.length > maxLength || /[\0\r\n]/u.test(normalized)) throw new Error('contains invalid or excessive text');
  return normalized;
}

function boolean(value) {
  if (value === true || value === 'true' || value === 1 || value === '1') return 'true';
  if (value === false || value === 'false' || value === 0 || value === '0') return 'false';
  throw new Error('must be a boolean');
}

function integer(min, max) {
  return value => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`must be an integer from ${min} to ${max}`);
    return String(parsed);
  };
}

function enumeration(values) {
  return value => {
    const normalized = String(value);
    if (!values.includes(normalized)) throw new Error(`must be one of: ${values.join(', ')}`);
    return normalized;
  };
}

function httpUrl(value, allowEmpty = true) {
  const normalized = text(value, 2048);
  if (!normalized && allowEmpty) return '';
  const parsed = new URL(normalized);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('must be an HTTP(S) URL without credentials');
  }
  return normalized.replace(/\/$/, '');
}

function pathValue(value) {
  const normalized = normalizePath(String(value));
  if (!normalized) throw new Error('must be a valid absolute path');
  return normalized;
}

function dockerEndpoint(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  const parsed = new URL(normalized);
  if (!['http:', 'https:', 'tcp:'].includes(parsed.protocol)
      || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('must be a credential-free Docker proxy origin');
  }
  return normalized.replace(/\/$/, '');
}

function pathArray(value) {
  let parsed;
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    throw new Error('must be a JSON array');
  }
  if (!Array.isArray(parsed) || parsed.length > 100) throw new Error('must be an array with at most 100 paths');
  return JSON.stringify(parsed.map(pathValue));
}

function timezone(value) {
  const normalized = String(value);
  if (normalized === 'system') return normalized;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: normalized }).format();
    return normalized;
  } catch {
    throw new Error('must be a valid IANA timezone or system');
  }
}

function peerApiUrl(value) {
  const normalized = text(value, 2048);
  return normalized ? validatePrivatePeerBaseUrl(normalized, 'peer_api_url') : '';
}

const validators = {
  instance_name: value => text(value, 100),
  user_name: value => text(value, 100),
  ntfy_enabled: boolean,
  browser_notify_enabled: boolean,
  ntfy_server: value => httpUrl(value, false),
  ntfy_topic: value => text(value, 200),
  ntfy_auth_type: enumeration(['none', 'token', 'basic']),
  ntfy_auth_token: value => text(value, 2048),
  ntfy_username: value => text(value, 200),
  ntfy_password: value => text(value, 2048),
  ntfy_on_job_start: boolean,
  ntfy_on_job_complete: boolean,
  ntfy_on_job_error: boolean,
  ntfy_on_progress: boolean,
  ntfy_progress_interval: integer(10, 86400),
  ntfy_on_drive_attach: boolean,
  ntfy_on_drive_lost: boolean,
  ntfy_on_drive_scan: boolean,
  docker_socket: dockerEndpoint,
  peer_api_port: integer(1, 65535),
  peer_api_url: peerApiUrl,
  metrics_poll_interval: integer(10, 300),
  metrics_retention_hours: integer(1, 8760),
  immich_server_url: value => httpUrl(value, true),
  immich_api_key: value => text(value, 4096),
  media_import_poll_interval: integer(1, 300),
  discovery_subnets: value => text(value, 2048),
  timezone,
  date_format: enumeration(['system', 'DD/MM/YYYY', 'MM/DD/YYYY', 'MMM D, YYYY', 'YYYY-MM-DD']),
  time_format: enumeration(['system', '24h', '12h']),
  hidden_drives: pathArray,
  hidden_remote_drives: pathArray,
  run_files_retention_days: integer(1, 3650),
  run_history_retention_days: integer(1, 3650),
  peer_audit_retention_days: integer(1, 3650),
  peer_security_audit_retention_days: integer(1, 3650),
  auth_audit_retention_days: integer(1, 3650),
  ssd_allow_empty_source: value => boolean(value) === 'true' ? '1' : '0',
};

export function validateSettingsUpdates(updates) {
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    throw new Error('Request body must be an object of key-value pairs');
  }
  const normalized = {};
  for (const [key, value] of Object.entries(updates)) {
    const validator = validators[key];
    if (!validator) throw new Error(`Unknown setting: ${key}`);
    try {
      normalized[key] = validator(value);
    } catch (err) {
      throw new Error(`${key} ${err.message}`);
    }
  }
  return normalized;
}
import { isIP } from 'node:net';

function isPrivateIpv4(hostname) {
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
    || (parts[0] === 169 && parts[1] === 254);
}

function isPrivateIpv6(hostname) {
  const normalized = hostname.toLowerCase();
  return normalized === '::1'
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || /^fe[89ab]/.test(normalized);
}

export function validatePrivatePeerHost(rawHost, label = 'Peer SSH host') {
  const host = String(rawHost || '').trim().replace(/^\[|\]$/g, '');
  const version = isIP(host);
  if ((version === 4 && isPrivateIpv4(host)) || (version === 6 && isPrivateIpv6(host))) return host;
  throw new Error(`${label} must use a numeric private IP address`);
}

export function validatePrivatePeerBaseUrl(rawUrl, label = 'Peer URL') {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`${label} is invalid`);
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`${label} must use HTTP or HTTPS`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${label} may not contain credentials`);
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(`${label} must not contain a path, query, or fragment`);
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  validatePrivatePeerHost(host, label);

  const port = parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} has an invalid port`);
  }
  return parsed.origin;
}

export function validateSignedCallbackUrl(rawUrl) {
  return validatePrivatePeerBaseUrl(rawUrl, 'Signed callback URL');
}
const SESSION_COOKIE = 'redman_session';
const CSRF_COOKIE = 'redman_csrf';

export function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try { cookies[key] = decodeURIComponent(value); } catch { cookies[key] = value; }
  }
  return cookies;
}

function serializeCookie(name, value, {
  secure,
  httpOnly,
  maxAgeSeconds,
} = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'SameSite=Strict',
  ];
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  if (maxAgeSeconds !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`);
  return parts.join('; ');
}

export function setSessionCookies(res, session, config) {
  const maxAgeSeconds = config.sessionAbsoluteHours * 60 * 60;
  res.append('Set-Cookie', serializeCookie(SESSION_COOKIE, session.token, {
    secure: config.secureCookies,
    httpOnly: true,
    maxAgeSeconds,
  }));
  res.append('Set-Cookie', serializeCookie(CSRF_COOKIE, session.csrfToken, {
    secure: config.secureCookies,
    httpOnly: false,
    maxAgeSeconds,
  }));
}

export function clearSessionCookies(res, config) {
  res.append('Set-Cookie', serializeCookie(SESSION_COOKIE, '', {
    secure: config.secureCookies,
    httpOnly: true,
    maxAgeSeconds: 0,
  }));
  res.append('Set-Cookie', serializeCookie(CSRF_COOKIE, '', {
    secure: config.secureCookies,
    httpOnly: false,
    maxAgeSeconds: 0,
  }));
}

export function getSessionCookie(req) {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE] || null;
}

export function getCsrfCookie(req) {
  return parseCookies(req.headers.cookie)[CSRF_COOKIE] || null;
}
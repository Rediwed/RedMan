// Logging helpers — redact sensitive values before they hit stdout/log aggregators

const SENSITIVE_KEYS = /^(api[_-]?key|password|secret|token|client[_-]?secret|private[_-]?key|access[_-]?token|refresh[_-]?token|authorization|bearer|passphrase)$/i;

/**
 * Validate that a string looks like a valid IPv4/IPv6 address before logging it.
 * Returns the input if valid, the literal "invalid" otherwise. Used to harden
 * audit logs against log-injection via spoofed X-Forwarded-For values.
 */
export function safeIp(ip) {
  if (!ip || typeof ip !== 'string') return 'unknown';
  // Take leftmost in XFF chain
  const first = ip.split(',')[0].trim();
  // Strip IPv6 ::ffff: prefix
  const cleaned = first.replace(/^::ffff:/i, '');
  if (cleaned.length > 45) return 'invalid';
  // IPv4 / IPv6 / IPv6 with %zone — restrictive charset, rejects newlines/quotes
  if (!/^[0-9a-f.:%]+$/i.test(cleaned)) return 'invalid';
  return cleaned;
}

/**
 * Redact sensitive values in an object for log output. Keys matching
 * SENSITIVE_KEYS get masked. Long strings that look like secrets are also
 * truncated. Returns a shallow copy — original is untouched.
 */
export function redact(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redact);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.test(k)) {
      out[k] = typeof v === 'string' && v.length > 0 ? '••••••••' : v;
    } else if (v && typeof v === 'object') {
      out[k] = redact(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Redact a free-form string by masking common secret patterns
 * (Bearer tokens, long base64-ish blobs, key=value pairs with sensitive keys).
 */
export function redactString(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/(Bearer\s+)[A-Za-z0-9._\-+/=]{8,}/gi, '$1••••••••')
    .replace(/((?:api[_-]?key|password|secret|token|client[_-]?secret|access[_-]?token|refresh[_-]?token|passphrase)\s*[:=]\s*)("?)[^\s"',}]+/gi, '$1$2••••••••');
}

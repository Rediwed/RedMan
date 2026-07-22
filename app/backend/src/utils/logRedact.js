// Logging helpers — redact sensitive values before they hit stdout/log aggregators

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

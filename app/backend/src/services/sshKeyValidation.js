const ED25519_KEY_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

export function normalizeSshPublicKey(publicKey) {
  if (typeof publicKey !== 'string' || !publicKey.trim()) {
    throw new Error('Empty public key');
  }

  if (publicKey.includes('\n') || publicKey.includes('\r') || publicKey.includes('\0')) {
    throw new Error('SSH public key must contain exactly one line');
  }

  const normalized = publicKey.trim();
  const [type, encodedKey, ...commentParts] = normalized.split(/\s+/);
  if (type !== 'ssh-ed25519' || !encodedKey || !ED25519_KEY_PATTERN.test(encodedKey)) {
    throw new Error('SSH public key must be a valid Ed25519 key');
  }

  const decoded = Buffer.from(encodedKey, 'base64');
  if (decoded.length === 0 || decoded.toString('base64') !== encodedKey) {
    throw new Error('SSH public key contains invalid base64 data');
  }

  return [type, encodedKey, ...commentParts].join(' ');
}

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function getSshKeyIdentity(normalizedKey) {
  const [type, encodedKey] = normalizeSshPublicKey(normalizedKey).split(/\s+/);
  return `${type} ${encodedKey}`;
}

export function buildRestrictedAuthorizedKey(publicKey, allowedPathPrefix, sourceIp, rrsyncPath = '/usr/bin/rrsync') {
  const normalizedKey = normalizeSshPublicKey(publicKey);
  if (!allowedPathPrefix || allowedPathPrefix === '/'
      || !/^\/[-A-Za-z0-9._/ ]+$/u.test(allowedPathPrefix)
      || allowedPathPrefix.split('/').includes('..')) {
    throw new Error('Restricted SSH key requires a non-root allowed path prefix');
  }
  if (!rrsyncPath.startsWith('/') || /[\n\r\0"\s]/u.test(rrsyncPath)) {
    throw new Error('rrsync path must be an absolute path without whitespace');
  }

  const options = ['restrict'];
  if (sourceIp) {
    if (!/^[0-9a-f.:%]+$/iu.test(sourceIp)) throw new Error('SSH key source IP is invalid');
    options.push(`from="${sourceIp}"`);
  }
  options.push(`command="${rrsyncPath} ${shellQuote(allowedPathPrefix)}"`);
  return `${options.join(',')} ${normalizedKey}`;
}

export function upsertAuthorizedKeyContent(existingContent, authorizedEntry, publicKey) {
  const identity = getSshKeyIdentity(publicKey);
  const lines = String(existingContent || '').split(/\r?\n/);
  const retained = lines.filter(line => {
    const match = line.match(/(?:^|\s)(ssh-ed25519\s+[A-Za-z0-9+/]+={0,2})(?:\s|$)/);
    return !match || match[1] !== identity;
  });
  retained.push(authorizedEntry);
  return `${retained.filter(Boolean).join('\n')}\n`;
}

export function removeAuthorizedKeyContent(existingContent, publicKey) {
  const identity = getSshKeyIdentity(publicKey);
  const retained = String(existingContent || '').split(/\r?\n/).filter(line => {
    const match = line.match(/(?:^|\s)(ssh-ed25519\s+[A-Za-z0-9+/]+={0,2})(?:\s|$)/);
    return !match || match[1] !== identity;
  });
  const content = retained.filter(Boolean).join('\n');
  return content ? `${content}\n` : '';
}
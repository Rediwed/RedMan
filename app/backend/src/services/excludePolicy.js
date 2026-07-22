export function normalizeExcludePatterns(value) {
  if (value === undefined || value === null || value === '') return null;
  const patterns = String(value)
    .split(/[\r\n,]+/)
    .map(pattern => pattern.trim())
    .filter(Boolean);
  if (patterns.length > 100) throw new Error('exclude_patterns supports at most 100 patterns');
  for (const pattern of patterns) {
    if (pattern.length > 256) throw new Error('Each exclude pattern must be 256 characters or fewer');
    if (pattern.includes('\0')) throw new Error('Exclude patterns cannot contain null bytes');
  }
  return patterns.length > 0 ? [...new Set(patterns)].join('\n') : null;
}

export function listExcludePatterns(value) {
  return normalizeExcludePatterns(value)?.split('\n') || [];
}
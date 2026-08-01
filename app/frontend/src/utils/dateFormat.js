// Shared date formatting utility for RedMan
// All database timestamps are stored as UTC — this utility ensures consistent display.

/**
 * Parse a database timestamp. SQLite writes datetime('now') in UTC without a
 * zone suffix, which JavaScript would otherwise read as local time.
 * @param {string} isoString - timestamp from the database
 * @returns {Date|null} parsed date, or null when unusable
 */
export function parseDbDate(isoString) {
  if (typeof isoString !== 'string' || !isoString) return null;
  const zoned = /(Z|[+-]\d{2}:?\d{2})$/.test(isoString) ? isoString : `${isoString}Z`;
  const date = new Date(zoned);
  return isNaN(date.getTime()) ? null : date;
}

/**
 * Format a database timestamp for display.
 * @param {string} isoString - UTC timestamp from the database
 * @param {object} settings - Settings object with timezone, date_format, time_format
 * @returns {string} Formatted date/time string
 */
export function formatDateTime(isoString, settings = {}) {
  if (!isoString) return '—';

  const date = parseDbDate(isoString);
  if (!date) return isoString;

  const tz = settings.timezone && settings.timezone !== 'system'
    ? settings.timezone : undefined;
  const df = settings.date_format || 'system';
  const tf = settings.time_format || 'system';

  // Pick locale based on date format
  let locale;
  if (df === 'DD/MM/YYYY') locale = 'en-GB';
  else if (df === 'MM/DD/YYYY') locale = 'en-US';
  else if (df === 'MMM D, YYYY') locale = 'en-US';
  else if (df === 'YYYY-MM-DD') locale = 'sv-SE';
  else locale = undefined;

  const options = {};
  if (tz) options.timeZone = tz;

  // Date parts
  if (df === 'system' || df === 'MMM D, YYYY') {
    options.year = 'numeric';
    options.month = 'short';
    options.day = 'numeric';
  } else {
    options.year = 'numeric';
    options.month = '2-digit';
    options.day = '2-digit';
  }

  // Time parts
  options.hour = '2-digit';
  options.minute = '2-digit';
  options.second = '2-digit';

  if (tf === '24h') options.hour12 = false;
  else if (tf === '12h') options.hour12 = true;

  try {
    return new Intl.DateTimeFormat(locale, options).format(date);
  } catch {
    return date.toLocaleString();
  }
}

/**
 * Generate a live preview string for the current format settings.
 */
export function formatPreview(settings = {}) {
  return formatDateTime(new Date().toISOString(), settings);
}

/**
 * Format a date for short display (date only, no time).
 */
export function formatDateShort(isoString, settings = {}) {
  if (!isoString) return '—';

  const date = parseDbDate(isoString);
  if (!date) return isoString;

  const tz = settings.timezone && settings.timezone !== 'system'
    ? settings.timezone : undefined;
  const df = settings.date_format || 'system';

  let locale;
  if (df === 'DD/MM/YYYY') locale = 'en-GB';
  else if (df === 'MM/DD/YYYY') locale = 'en-US';
  else if (df === 'MMM D, YYYY') locale = 'en-US';
  else if (df === 'YYYY-MM-DD') locale = 'sv-SE';
  else locale = undefined;

  const options = {};
  if (tz) options.timeZone = tz;
  options.day = '2-digit';
  options.month = 'short';
  options.year = 'numeric';

  try {
    return new Intl.DateTimeFormat(locale, options).format(date);
  } catch {
    return date.toLocaleDateString();
  }
}

/**
 * Format a time only (for chart axis labels etc.)
 */
export function formatTimeOnly(isoString, settings = {}) {
  if (!isoString) return '';

  const date = parseDbDate(isoString);
  if (!date) return '';

  const tz = settings.timezone && settings.timezone !== 'system'
    ? settings.timezone : undefined;
  const tf = settings.time_format || 'system';

  const options = { hour: '2-digit', minute: '2-digit' };
  if (tz) options.timeZone = tz;
  if (tf === '24h') options.hour12 = false;
  else if (tf === '12h') options.hour12 = true;

  try {
    return new Intl.DateTimeFormat(undefined, options).format(date);
  } catch {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
}

export function ordinal(number) {
  const suffixes = ['th', 'st', 'nd', 'rd'];
  const value = number % 100;
  return number + (suffixes[(value - 20) % 10] || suffixes[value] || suffixes[0]);
}

export function parseCron(cron) {
  const parts = (cron || '0 * * * *').trim().split(/\s+/);
  if (parts.length !== 5) return { frequency: 'custom', minute: 0, hour: 0, dow: 0, dom: 1 };
  const [minuteField, hourField, dayOfMonth, , dayOfWeek] = parts;

  if (minuteField === '*/15') return { frequency: '15min', minute: 0, hour: 0, dow: 0, dom: 1 };
  if (minuteField === '*/30') return { frequency: '30min', minute: 0, hour: 0, dow: 0, dom: 1 };

  const minute = minuteField === '*' ? 0 : Number.parseInt(minuteField, 10) || 0;
  if (hourField.startsWith('*/')) {
    const interval = Number.parseInt(hourField.slice(2), 10);
    const frequencies = { 2: '2h', 4: '4h', 6: '6h', 8: '8h', 12: '12h' };
    return { frequency: frequencies[interval] || 'custom', minute, hour: 0, dow: 0, dom: 1 };
  }
  if (hourField === '*' && dayOfMonth === '*' && dayOfWeek === '*') {
    return { frequency: 'hourly', minute, hour: 0, dow: 0, dom: 1 };
  }

  const hour = Number.parseInt(hourField, 10) || 0;
  if (dayOfWeek !== '*' && dayOfMonth === '*') {
    return { frequency: 'weekly', minute, hour, dow: Number.parseInt(dayOfWeek, 10) || 0, dom: 1 };
  }
  if (dayOfMonth !== '*' && dayOfWeek === '*') {
    return { frequency: 'monthly', minute, hour, dow: 0, dom: Number.parseInt(dayOfMonth, 10) || 1 };
  }
  if (hourField !== '*' && dayOfMonth === '*' && dayOfWeek === '*') {
    return { frequency: 'daily', minute, hour, dow: 0, dom: 1 };
  }
  return { frequency: 'custom', minute, hour, dow: Number.parseInt(dayOfWeek, 10) || 0, dom: Number.parseInt(dayOfMonth, 10) || 1 };
}

export function describeCron(cron) {
  const parsed = parseCron(cron);
  const pad = number => String(number).padStart(2, '0');
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  switch (parsed.frequency) {
    case '15min': return 'Runs every 15 minutes';
    case '30min': return 'Runs every 30 minutes';
    case 'hourly': return `Runs every hour at :${pad(parsed.minute)}`;
    case '2h': return `Runs every 2 hours at :${pad(parsed.minute)}`;
    case '4h': return `Runs every 4 hours at :${pad(parsed.minute)}`;
    case '6h': return `Runs every 6 hours at :${pad(parsed.minute)}`;
    case '8h': return `Runs every 8 hours at :${pad(parsed.minute)}`;
    case '12h': return `Runs every 12 hours at :${pad(parsed.minute)}`;
    case 'daily': return `Runs daily at ${pad(parsed.hour)}:${pad(parsed.minute)}`;
    case 'weekly': return `Runs every ${days[parsed.dow]} at ${pad(parsed.hour)}:${pad(parsed.minute)}`;
    case 'monthly': return `Runs on the ${ordinal(parsed.dom)} of each month at ${pad(parsed.hour)}:${pad(parsed.minute)}`;
    default: return `Custom schedule: ${cron}`;
  }
}
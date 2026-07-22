import { CronExpressionParser } from 'cron-parser';

export function parseCronExpression(expression, options = {}) {
  if (typeof expression !== 'string' || expression.trim().split(/\s+/).length !== 5) {
    throw new Error('Cron expression must contain exactly 5 fields');
  }
  return CronExpressionParser.parse(expression.trim(), {
    currentDate: options.currentDate || new Date(),
    tz: options.timezone || process.env.TZ || 'UTC',
  });
}

export function validateCronExpression(expression) {
  try {
    parseCronExpression(expression);
    return true;
  } catch {
    return false;
  }
}

export function nextCronOccurrence(expression, options = {}) {
  return parseCronExpression(expression, options).next().toDate().toISOString();
}
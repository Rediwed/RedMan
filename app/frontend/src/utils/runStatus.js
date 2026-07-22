const TERMINAL_RUN_STATUSES = new Set(['completed', 'partial', 'failed', 'cancelled']);

export function isTerminalRunStatus(status) {
  return TERMINAL_RUN_STATUSES.has(status);
}
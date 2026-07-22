import { validateSshHost, validateSshPort, validateSshUser } from '../middleware/validation.js';

export function validateSshConnectionTarget(host, user = 'redman-backup', port = 22) {
  if (!validateSshHost(host)) throw new Error('host must be a valid hostname or IP address');
  if (!validateSshUser(user)) throw new Error('user must be a non-root account containing only letters, digits, dot, dash, or underscore');
  if (!validateSshPort(port)) throw new Error('port must be between 1 and 65535');
  return { host, user, port: Number(port) };
}
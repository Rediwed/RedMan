import db from '../src/db.js';
import { provisionProxyAccount } from '../src/services/authService.js';

const [subject, role = 'viewer', displayName = null] = process.argv.slice(2);
if (!subject) {
  console.error('Usage: npm run auth:provision-proxy -- <provider-subject> [admin|viewer] [display-name]');
  process.exitCode = 2;
} else {
  try {
    const user = provisionProxyAccount(db, subject, role, displayName);
    console.log(`Provisioned proxy account: ${user.username} (${user.role})`);
  } catch (err) {
    console.error(`Could not provision proxy account: ${err.message}`);
    process.exitCode = 1;
  }
}

db.close();
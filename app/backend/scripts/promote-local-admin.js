import db from '../src/db.js';
import { promoteLocalAdminForRecovery } from '../src/services/authService.js';

const username = process.argv[2];
if (!username) {
  console.error('Usage: npm run auth:promote-admin -- <username>');
  process.exitCode = 2;
} else {
  try {
    const user = promoteLocalAdminForRecovery(db, username);
    console.log(`Recovered local administrator: ${user.username}`);
    console.log('All existing sessions for this account were revoked.');
  } catch (err) {
    console.error(`Could not recover administrator: ${err.message}`);
    process.exitCode = 1;
  }
}

db.close();
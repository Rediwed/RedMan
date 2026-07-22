import db from '../src/db.js';
import { authConfig } from '../src/services/authConfig.js';
import { issueRecoveryToken } from '../src/services/authService.js';

const username = process.argv[2];
if (!username) {
  console.error('Usage: npm run auth:recovery -- <username>');
  process.exitCode = 2;
} else {
  try {
    const recovery = issueRecoveryToken(db, username, authConfig);
    console.log('One-time RedMan recovery token (expires in 15 minutes):');
    console.log(recovery.token);
    console.log(`Expires: ${recovery.expiresAt}`);
  } catch (err) {
    console.error(`Could not create recovery token: ${err.message}`);
    process.exitCode = 1;
  }
}

db.close();
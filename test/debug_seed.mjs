// Test if seed script truncation is reproducible
import { createRequire } from 'module';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { userInfo } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(__dirname, '../app/package.json'));
const Database = require('better-sqlite3');

const sourceDir = resolve(__dirname, 'data', 'source');
const destHyper = resolve(__dirname, 'data', 'dest_hyper');
const currentUser = userInfo().username;
const host = 'localhost';

console.log('sourceDir:', JSON.stringify(sourceDir), 'length:', sourceDir.length);
console.log('destHyper:', JSON.stringify(destHyper), 'length:', destHyper.length);

// Test in-memory
const db = new Database(':memory:');
db.exec(`
  CREATE TABLE hyper_backup_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    direction TEXT NOT NULL,
    remote_url TEXT NOT NULL,
    remote_api_key TEXT NOT NULL,
    local_path TEXT NOT NULL,
    remote_path TEXT NOT NULL,
    ssh_user TEXT DEFAULT 'root',
    ssh_host TEXT,
    ssh_port INTEGER DEFAULT 22,
    cron_expression TEXT NOT NULL DEFAULT '0 2 * * *',
    enabled INTEGER NOT NULL DEFAULT 1
  )
`);

db.prepare(`
  INSERT OR REPLACE INTO hyper_backup_jobs
    (id, name, direction, remote_url, remote_api_key, local_path, remote_path,
     ssh_user, ssh_host, ssh_port, cron_expression, enabled)
  VALUES (1, 'Test Hyper Push A→B', 'push',
    'http://localhost:8095', 'test-peer-key-beta',
    ?, ?,
    ?, ?, 22, '0 */2 * * *', 0)
`).run(sourceDir, destHyper, currentUser, host);

const row = db.prepare('SELECT local_path, length(local_path) as len, remote_path FROM hyper_backup_jobs WHERE id = 1').get();
console.log('Inserted local_path:', JSON.stringify(row.local_path), 'length:', row.len);
console.log('Inserted remote_path:', JSON.stringify(row.remote_path));
console.log('Match:', row.local_path === sourceDir ? 'YES' : 'NO - TRUNCATED!');

db.close();

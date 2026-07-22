import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ssd = readFileSync(resolve(import.meta.dirname, '../app/frontend/src/pages/SsdBackupPage.jsx'), 'utf8');
const settings = readFileSync(resolve(import.meta.dirname, '../app/frontend/src/pages/SettingsPage.jsx'), 'utf8');
assert.match(ssd, /Active exclude patterns/);
assert.match(ssd, /parseExcludePreview/);
for (const key of ['run_files_retention_days', 'run_history_retention_days', 'peer_audit_retention_days', 'peer_security_audit_retention_days', 'auth_audit_retention_days', 'ssd_allow_empty_source']) {
  assert.match(settings, new RegExp(key));
}
assert.match(settings, /accidentally unmounted source/);
console.log('Safety settings UI: exclude preview, retention, and empty-source warning passed');
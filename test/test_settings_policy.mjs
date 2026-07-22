import assert from 'node:assert/strict';
import { validateSettingsUpdates } from '../app/backend/src/services/settingsPolicy.js';

assert.deepEqual(validateSettingsUpdates({
  ntfy_enabled: true,
  metrics_poll_interval: '30',
  timezone: 'Europe/Amsterdam',
  hidden_drives: ['/mnt/disks/camera'],
}), {
  ntfy_enabled: 'true',
  metrics_poll_interval: '30',
  timezone: 'Europe/Amsterdam',
  hidden_drives: '["/mnt/disks/camera"]',
});
assert.throws(() => validateSettingsUpdates({ arbitrary_key: 'value' }), /Unknown setting/);
assert.throws(() => validateSettingsUpdates({ peer_api_port: 70000 }), /1 to 65535/);
assert.throws(() => validateSettingsUpdates({ timezone: 'Mars/Olympus' }), /valid IANA/);
assert.throws(() => validateSettingsUpdates({ hidden_drives: '["relative"]' }), /absolute path/);
assert.throws(() => validateSettingsUpdates({ peer_api_url: 'https://example.com' }), /numeric private IP/);

console.log('Typed settings allowlist: 10 normalized fields and rejection cases passed');
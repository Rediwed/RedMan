import assert from 'node:assert/strict';
import { validateSshConnectionTarget } from '../app/backend/src/services/sshConnectionPolicy.js';

assert.deepEqual(validateSshConnectionTarget('nas.internal', 'redman-backup', '2222'), {
  host: 'nas.internal', user: 'redman-backup', port: 2222,
});
assert.throws(() => validateSshConnectionTarget('-oProxyCommand=bad', 'root', 22), /host/);
assert.throws(() => validateSshConnectionTarget('nas.internal', '-oProxyCommand=bad', 22), /user/);
assert.throws(() => validateSshConnectionTarget('nas.internal', 'root', 22), /non-root/);
assert.throws(() => validateSshConnectionTarget('nas.internal', 'backup', '22;touch /tmp/pwned'), /port/);

console.log('SSH connection policy: host, user, port, and option injection validation passed');
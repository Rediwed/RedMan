import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PERMISSIONS,
  authorizeApiRoute,
  getRoutePermission,
} from '../app/backend/src/services/routePermissions.js';

const contract = JSON.parse(readFileSync(resolve(import.meta.dirname, '../app/backend/src/contracts/v1.json'), 'utf8'));
const endpoints = [];
for (const group of Object.values(contract.api)) {
  for (const [endpoint, definition] of Object.entries(group)) {
    if (definition.auth === false) continue;
    const [method, template] = endpoint.split(' ');
    const pathname = template
      .replaceAll(':id', '1')
      .replaceAll(':name', 'fixture')
      .replaceAll(':action', 'restart');
    endpoints.push({ endpoint, method, pathname });
  }
}

const missing = endpoints.filter(({ method, pathname }) => !getRoutePermission(method, pathname));
assert.deepEqual(missing, [], `Missing route policies: ${missing.map(item => item.endpoint).join(', ')}`);
assert.equal(getRoutePermission('GET', '/api/not-declared'), null);
assert.equal(getRoutePermission('POST', '/api/overview/summary'), null);
assert.equal(getRoutePermission('GET', '/api/rclone/remotes/secret/config'), PERMISSIONS.SECRETS);
assert.equal(getRoutePermission('POST', '/api/ssd-backup/configs/1/restore'), PERMISSIONS.RESTORE);
assert.equal(getRoutePermission('POST', '/api/docker/containers/abc/restart'), PERMISSIONS.DOCKER_MUTATE);

function invoke(role, method, originalUrl) {
  const req = { method, originalUrl, user: { role } };
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  let nextCalled = false;
  authorizeApiRoute(req, res, () => { nextCalled = true; });
  return { req, res, nextCalled };
}

assert.equal(invoke('viewer', 'GET', '/api/ssd-backup/configs').nextCalled, true);
assert.equal(invoke('viewer', 'POST', '/api/ssd-backup/configs/1/run').res.statusCode, 403);
assert.equal(invoke('viewer', 'GET', '/api/settings').res.statusCode, 403);
assert.equal(invoke('admin', 'POST', '/api/ssd-backup/configs/1/restore').nextCalled, true);
assert.equal(invoke('admin', 'GET', '/api/future-route').res.statusCode, 403);

console.log(`Route authorization: ${endpoints.length} contracted routes declared; viewer/admin/unknown behavior passed`);

import assert from 'node:assert/strict';
import { getAllowedDockerRequest, isAllowedDockerRequest } from '../app/backend/scripts/dockerApiProxy.js';

const allowed = [
	['read', 'GET', '/_ping'],
	['read', 'HEAD', '/_ping'],
	['read', 'GET', '/version'],
	['read', 'GET', '/containers/json?all=true'],
	['read', 'GET', '/containers/abc-123/stats?stream=false'],
	['read', 'GET', '/networks'],
	['control', 'POST', '/containers/abc-123/start'],
	['control', 'POST', '/v1.51/containers/abc-123/stop?t=10'],
];

const denied = [
	['read', 'POST', '/containers/abc-123/start'],
	['read', 'GET', '/containers/abc-123/archive?path=/etc/shadow'],
	['read', 'GET', '/containers/abc-123/json'],
	['read', 'GET', '/containers/abc-123/logs'],
	['read', 'GET', '/containers/abc-123/top'],
	['read', 'GET', '/containers/abc-123/%61rchive'],
	['read', 'GET', '/images/json'],
	['read', 'GET', '/info'],
	['read', 'GET', '/containers/json?size=true'],
	['read', 'GET', '/containers/json?all=yes'],
	['read', 'GET', '/containers/json?all=true&all=false'],
	['read', 'GET', '/containers/json?filters=not-json'],
	['read', 'GET', '/containers/abc-123/stats?stream=true'],
	['read', 'GET', '/containers/abc-123/stats?stream=false&stream=false'],
	['read', 'GET', '/networks?filters=%7B%7D'],
	['control', 'POST', '/containers/create'],
	['control', 'POST', '/containers/abc-123/restart'],
	['control', 'POST', '/containers/abc-123/kill'],
	['control', 'POST', '/containers/abc-123/exec'],
	['control', 'GET', '/containers/abc-123/json'],
	['control', 'POST', '/v1.51/containers/abc-123/start/extra'],
	['control', 'POST', '/containers/abc-123/start?t=1'],
	['control', 'POST', '/containers/abc-123/stop?t=forever'],
	['control', 'POST', '/containers/abc-123/stop?t=9999'],
	['control', 'POST', '/containers/abc-123/stop?t=1&t=2'],
	['unknown', 'GET', '/_ping'],
];

for (const testCase of allowed) assert.equal(isAllowedDockerRequest(...testCase), true, testCase.join(' '));
for (const testCase of denied) assert.equal(isAllowedDockerRequest(...testCase), false, testCase.join(' '));

assert.deepEqual(
	getAllowedDockerRequest('read', 'GET', '/v1.51/containers/json?filters=%7B%22status%22%3A%5B%22running%22%5D%7D&all=1'),
	{ method: 'GET', path: '/containers/json?filters=%7B%22status%22%3A%5B%22running%22%5D%7D&all=1' },
);
assert.deepEqual(
	getAllowedDockerRequest('read', 'GET', '/containers/abc/../json?all=true'),
	{ method: 'GET', path: '/containers/json?all=true' },
);

console.log(`Docker exact-path proxy policy: ${allowed.length} allowed, ${denied.length} denied, and canonical forwarding passed`);
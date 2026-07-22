import assert from 'node:assert/strict';
import { createDockerClient, executeDockerControlAction } from '../app/backend/src/services/dockerClient.js';

assert.doesNotThrow(() => createDockerClient('http://docker-socket-proxy:2375'));
assert.throws(() => createDockerClient('/var/run/docker.sock'), /HTTP proxy origin/);
assert.throws(() => createDockerClient('docker-socket-proxy:2375'), /must be an HTTP proxy/);
assert.throws(() => createDockerClient('http://user:pass@docker-socket-proxy:2375'), /credential-free/);
assert.throws(() => createDockerClient('http://docker-socket-proxy:2375/path'), /credential-free/);

const calls = [];
const readClient = {
	listContainers: async options => {
		calls.push(`list:${options.filters.id[0]}`);
		return [{ State: 'running' }];
	},
};
const controlClient = {
	getContainer: containerId => ({
		start: async () => calls.push(`start:${containerId}`),
		stop: async () => calls.push(`stop:${containerId}`),
	}),
};

assert.deepEqual(
	await executeDockerControlAction(readClient, controlClient, 'container-1', 'restart'),
	{ success: true, action: 'restart', containerId: 'container-1' },
);
assert.deepEqual(calls, ['list:container-1', 'stop:container-1', 'start:container-1']);
await executeDockerControlAction(readClient, controlClient, 'container-2', 'start');
await executeDockerControlAction(readClient, controlClient, 'container-3', 'stop');
assert.deepEqual(calls.slice(3), ['start:container-2', 'stop:container-3']);
await assert.rejects(
	executeDockerControlAction(readClient, controlClient, 'container-4', 'kill'),
	/Action 'kill' not allowed/,
);

console.log('Docker client endpoint and split-control policy: 9 cases passed');
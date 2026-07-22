import assert from 'node:assert/strict';
import { fetchWithoutRedirect } from '../app/backend/src/services/httpPolicy.js';

const originalFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = async (url, options) => {
	calls.push({ url, options });
	return { ok: true };
};

try {
	await fetchWithoutRedirect('http://192.168.1.20:8091/peer/health');
	await fetchWithoutRedirect('http://192.168.1.20:8091/peer/storage', {
		method: 'POST',
		redirect: 'follow',
	});
	assert.equal(calls.length, 2);
	assert.equal(calls[0].options.redirect, 'error');
	assert.equal(calls[1].options.method, 'POST');
	assert.equal(calls[1].options.redirect, 'error');
} finally {
	globalThis.fetch = originalFetch;
}

console.log('HTTP policy: private-target requests reject redirects and caller overrides');
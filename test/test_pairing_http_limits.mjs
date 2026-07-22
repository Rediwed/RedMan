import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const fixture = resolve(import.meta.dirname, 'data', `pairing-http-limits-${process.pid}`);
mkdirSync(fixture, { recursive: true });
process.env.DB_PATH = resolve(fixture, 'redman.db');
process.env.NODE_ENV = 'test';
const { createPeerApi } = await import('../app/backend/src/peerApi.js');
const { default: db } = await import('../app/backend/src/db.js');

async function listen() {
  const app = createPeerApi();
  const server = await new Promise(resolvePromise => {
    const candidate = app.listen(0, '127.0.0.1', () => resolvePromise(candidate));
  });
  return { server, url: `http://127.0.0.1:${server.address().port}/peer/pair/request` };
}

async function close(server) {
  await new Promise(resolvePromise => server.close(resolvePromise));
}

try {
  const malformed = await listen();
  try {
    for (let attempt = 1; attempt <= 30; attempt += 1) {
      const response = await fetch(malformed.url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{',
      });
      assert.equal(response.status, 400);
    }
    const limited = await fetch(malformed.url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{',
    });
    assert.equal(limited.status, 429);
  } finally {
    await close(malformed.server);
  }

  const oversized = await listen();
  try {
    const body = JSON.stringify({ padding: 'x'.repeat(33 * 1024) });
    for (let attempt = 1; attempt <= 30; attempt += 1) {
      const response = await fetch(oversized.url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
      });
      assert.equal(response.status, 413);
    }
    const limited = await fetch(oversized.url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
    assert.equal(limited.status, 429);
  } finally {
    await close(oversized.server);
  }
  console.log('Pairing HTTP limits: malformed and oversized JSON consume pre-parser rate limits');
} finally {
  db.close();
  rmSync(fixture, { recursive: true, force: true });
}
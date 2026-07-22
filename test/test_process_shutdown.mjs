import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const fixture = resolve(import.meta.dirname, 'data', `process-shutdown-${process.pid}`);
mkdirSync(fixture, { recursive: true });
const backendDir = resolve(import.meta.dirname, '../app/backend');
let nextPort = 19000 + (process.pid % 1000) * 2;

async function runCase(name, trigger, expectedExitCode) {
  const port = nextPort;
  nextPort += 2;
  const dbPath = resolve(fixture, `${name}.db`);
  const child = spawn(process.execPath, [
    '--input-type=module',
    '-e',
    trigger === 'fatal'
      ? "import('./src/index.js').then(() => setTimeout(() => { throw new Error('shutdown-test-fatal'); }, 300))"
      : "import('./src/index.js')",
  ], {
    cwd: backendDir,
    env: {
      ...process.env,
      DB_PATH: dbPath,
      PORT: String(port),
      PEER_API_PORT: String(port + 1),
      AUTH_DISABLED: 'true',
      REDMAN_LOCAL_DEV: '1',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });

  if (trigger === 'signal') {
    await new Promise((resolveReady, rejectReady) => {
      const timeout = setTimeout(() => rejectReady(new Error(`Startup timeout:\n${output}`)), 10000);
      const check = chunk => {
        output += chunk.toString();
        if (output.includes('Peer API running')) {
          clearTimeout(timeout);
          child.stdout.off('data', check);
          resolveReady();
        }
      };
      child.stdout.on('data', check);
    });
    child.kill('SIGTERM');
  }

  const result = await new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      rejectExit(new Error(`Shutdown timeout:\n${output}`));
    }, 15000);
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolveExit({ code, signal });
    });
  });

  assert.equal(result.signal, null, output);
  assert.equal(result.code, expectedExitCode, output);
  assert.match(output, /Cleanup complete/);
}

try {
  await runCase('signal', 'signal', 0);
  await runCase('fatal', 'fatal', 1);
  console.log('Process shutdown: SIGTERM exits 0, fatal exception exits 1 after cleanup');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
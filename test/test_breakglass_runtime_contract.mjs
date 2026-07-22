import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const fixture = mkdtempSync(resolve(tmpdir(), 'redman-breakglass-'));
const runtime = resolve(fixture, 'runtime');
const manifest = resolve(fixture, 'plugin.plg');
const script = resolve(import.meta.dirname, '..', 'scripts', 'verify-breakglass-runtime.sh');

function digest(content) {
  return createHash('sha256').update(content).digest('hex');
}

function run() {
  return spawnSync('bash', [script, '--manifest', manifest, '--runtime', runtime], { encoding: 'utf8' });
}

try {
  const content = '#!/bin/sh\necho safe\n';
  writeFileSync(runtime, content);
  chmodSync(runtime, 0o700);
  writeFileSync(manifest, `<FILE Name="${runtime}" Mode="0700">\n  <SHA256>${digest(content)}</SHA256>\n</FILE>\n`);
  assert.equal(run().status, 0);

  writeFileSync(runtime, '#!/bin/sh\necho changed\n');
  chmodSync(runtime, 0o700);
  const mismatch = run();
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /does not match/);

  writeFileSync(manifest, `<FILE Name="${runtime}" Mode="0700">\n  <SHA256>invalid</SHA256>\n</FILE>\n`);
  const malformed = run();
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /no valid SHA-256/);
  console.log('Breakglass runtime contract: manifest match, mismatch, and malformed hash checks passed');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
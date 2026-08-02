// Runs the shell recipe from the README verbatim and checks the result against
// the verifier. A documented recipe that does not verify fails silently in
// production: the heartbeat is dropped and the job simply reads as overdue.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const require = createRequire(resolve(import.meta.dirname, '../app/package.json'));
const Database = require('better-sqlite3');

import { runMigrations } from '../app/backend/src/migrations.js';
import { createExternalJob, recordRelayedHeartbeat } from '../app/backend/src/services/externalJobs.js';
import { parseRelayMessage } from '../app/backend/src/services/ntfyRelay.js';

const dir = mkdtempSync(join(tmpdir(), 'redman-recipe-'));
const db = new Database(join(dir, 'test.db'));
db.pragma('foreign_keys = ON');
runMigrations(db);

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

// Exactly the recipe published in README.md, with the sha256 tool resolved for
// whichever platform runs the suite.
const RECIPE = `
set -eu
if command -v sha256sum >/dev/null 2>&1; then sha256() { sha256sum | cut -d' ' -f1; }
else sha256() { shasum -a 256 | cut -d' ' -f1; }; fi

slug="$(printf '%s' "$slug" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9._-' '-')"
key="$(printf '%s' "$REDMAN_HEARTBEAT_TOKEN" | sha256)"
sig="$(printf '%s\\n%s\\n%s\\n%s\\n%s' "$slug" "$ts" "$code" "$duration" "$message" \\
  | openssl dgst -sha256 -hmac "$key" -hex | awk '{print $NF}')"

printf '%s %s %s %s %s %s %s' \\
  redman-hb1 "$slug" "$ts" "$code" "$duration" "$sig" "$message"
`;

function runRecipe(env) {
  return execFileSync('bash', ['-c', RECIPE], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

function verifyLine(line) {
  const fields = parseRelayMessage(line);
  assert.ok(fields, `line did not parse: ${JSON.stringify(line)}`);
  return recordRelayedHeartbeat(db, fields);
}

const cases = [
  { name: 'a normal report', slug: 'recipe-normal', code: '0', duration: '4', message: 'pruned 3 images, freed 1.2 GB' },
  { name: 'an empty message keeps every separator', slug: 'recipe-empty', code: '0', duration: '1', message: '' },
  { name: 'absent fields written as the sentinel', slug: 'recipe-absent', code: '-', duration: '-', message: 'no exit code' },
  { name: 'a failure', slug: 'recipe-failure', code: '3', duration: '12', message: 'tunnel down' },
];

for (const c of cases) {
  const { token } = createExternalJob(db, { name: c.name, slug: c.slug });
  check(`the README recipe verifies: ${c.name}`, () => {
    const line = runRecipe({
      REDMAN_HEARTBEAT_TOKEN: token,
      slug: c.slug,
      ts: String(nowSeconds()),
      code: c.code,
      duration: c.duration,
      message: c.message,
    });
    const result = verifyLine(line);
    assert.equal(result.ok, true, `rejected: ${result.reason}`);
  });
}

const mixed = createExternalJob(db, { name: 'Mixed case', slug: 'recipe-mixed-case' });
check('the README recipe normalises the slug the way the verifier does', () => {
  const line = runRecipe({
    REDMAN_HEARTBEAT_TOKEN: mixed.token,
    slug: 'Recipe Mixed CASE',
    ts: String(nowSeconds()),
    code: '0',
    duration: '2',
    message: 'normalised',
  });
  assert.ok(line.includes('recipe-mixed-case'), `slug not normalised: ${line}`);
  const result = verifyLine(line);
  assert.equal(result.ok, true, `rejected: ${result.reason}`);
});

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} documented recipe checks passed`);

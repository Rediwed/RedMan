import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

// Discovered rather than listed: a hand-maintained array silently skips every
// test added after someone forgets to append to it.
const RUN_SEPARATELY = new Set([
  'test_mitigation_regressions.mjs', // this runner
  'test_backward_compat.mjs',        // pre-push step 2, needs --skip-live
  'test_comprehensive.mjs',          // integration suite, takes minutes
  'test_delta_versioning.mjs',       // needs a live API on localhost:8090
  'test_upgrade_readiness.mjs',      // npm run test:bridge
  'test_upgrade_bridge_runtime.mjs', // npm run test:bridge
]);

// A stale exclusion would quietly keep a test out of the suite forever.
for (const name of RUN_SEPARATELY) {
  if (!existsSync(resolve(import.meta.dirname, name))) {
    console.error(`Excluded test no longer exists: ${name}`);
    process.exit(1);
  }
}

const entries = readdirSync(import.meta.dirname);
const tests = entries
  .filter(name => /^test_.+\.mjs$/.test(name) && !RUN_SEPARATELY.has(name))
  .sort();

// An empty or gutted list would let the gate pass without testing anything,
// which looks exactly like success. The floor is well below the current count.
if (tests.length < 80) {
  console.error(`Refusing to pass: only ${tests.length} regression tests discovered`);
  process.exit(1);
}

// A test file that matches neither the runner nor an exclusion would go
// unrun and unreported — the failure this discovery was meant to end.
const unaccounted = entries.filter(name => /^test_/.test(name)
  && !name.endsWith('.sh')
  && !tests.includes(name)
  && !RUN_SEPARATELY.has(name));
if (unaccounted.length > 0) {
  console.error(`Test files that are neither run nor excluded: ${unaccounted.join(', ')}`);
  process.exit(1);
}

for (const test of tests) {
  const result = spawnSync(process.execPath, [resolve(import.meta.dirname, test)], {
    encoding: 'utf8',
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) console.error(`${test}: ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log(`Mitigation regressions: ${tests.length} files passed`);
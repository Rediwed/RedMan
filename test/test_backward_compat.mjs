#!/usr/bin/env node

// RedMan Backward Compatibility Test
// Validates that the running instance conforms to the v1 API + DB + service contracts.
// Usage: node test/test_backward_compat.mjs [--api-url http://localhost:8090] [--peer-url http://localhost:8091] [--peer-key KEY]
//
// Requires a running RedMan instance (./test/setup_local_test.sh)

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { createRequire } from 'module';
import { getSchemaVersion, runMigrations, validateMigrations } from '../app/backend/src/migrations.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');
const require = createRequire(join(ROOT, 'app/backend/package.json'));
const Database = require('better-sqlite3');

// ── CLI args ──
const args = process.argv.slice(2);
function getArg(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const API_URL = getArg('--api-url', 'http://localhost:8090');
const PEER_URL = getArg('--peer-url', 'http://localhost:8091');
const PEER_KEY = getArg('--peer-key', 'test-peer-key-alpha');
const SKIP_LIVE = args.includes('--skip-live');

// ── Load contract ──
const contractPath = join(ROOT, 'app/backend/src/contracts/v1.json');
if (!existsSync(contractPath)) {
  console.error('❌ Contract file not found:', contractPath);
  process.exit(1);
}
const contract = JSON.parse(readFileSync(contractPath, 'utf-8'));
const appVersion = JSON.parse(readFileSync(join(ROOT, 'app/package.json'), 'utf-8')).version;

// ── Test runner ──
let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

function pass(msg) {
  passed++;
  console.log(`  ✅ ${msg}`);
}

function fail(msg, detail) {
  failed++;
  const full = detail ? `${msg}: ${detail}` : msg;
  failures.push(full);
  console.log(`  ❌ ${full}`);
}

function skip(msg) {
  skipped++;
  console.log(`  ⏭️  ${msg}`);
}

async function fetchSafe(url, opts = {}) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000), ...opts });
    return res;
  } catch (err) {
    return null;
  }
}

// ═══════════════════════════════════════════════════
// Suite 1: Contract file integrity
// ═══════════════════════════════════════════════════
function testContractIntegrity() {
  console.log('\n📋 Suite 1: Contract File Integrity\n');

  // Contract metadata follows the application release while its v1 surface stays stable.
  if (contract.version === appVersion) pass(`Contract version matches app version ${appVersion}`);
  else fail('Contract version mismatch', `expected ${appVersion}, got ${contract.version}`);

  // Must have all sections
  for (const section of ['api', 'peerApi', 'database', 'services', 'frontendApi']) {
    if (contract[section]) pass(`Contract has '${section}' section`);
    else fail(`Contract missing '${section}' section`);
  }

  // API groups
  const expectedGroups = ['health', 'ssd-backup', 'hyper-backup', 'rclone', 'docker', 'media-import', 'settings', 'peers', 'overview', 'filesystem'];
  for (const g of expectedGroups) {
    if (contract.api[g]) pass(`API group '${g}' present`);
    else fail(`API group '${g}' missing from contract`);
  }
}

// ═══════════════════════════════════════════════════
// Suite 2: Database schema validation
// ═══════════════════════════════════════════════════
function testDatabaseSchema() {
  console.log('\n🗄️  Suite 2: Database Schema Contract\n');

  const database = new Database(':memory:');
  try {
    runMigrations(database);
    for (const [table, schema] of Object.entries(contract.database)) {
      const exists = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
      if (!exists) {
        fail(`Table '${table}' missing from migrated schema`);
        continue;
      }
      pass(`Table '${table}' present in migrated schema`);

      const columns = new Map(database.prepare(`PRAGMA table_info("${table}")`).all().map(column => [column.name, column]));
      for (const [columnName, expectedDefinition] of Object.entries(schema.columns)) {
        const column = columns.get(columnName);
        if (!column) {
          fail(`  ${table}.${columnName} missing`);
          continue;
        }

        const expected = expectedDefinition.toUpperCase();
        const expectedType = expected.split(/\s+/)[0];
        const issues = [];
        if (column.type.toUpperCase() !== expectedType) issues.push(`type ${column.type || '(none)'}, expected ${expectedType}`);
        if (expected.includes('NOT NULL') && column.notnull !== 1) issues.push('expected NOT NULL');
        if (expected.includes('PRIMARY KEY') && column.pk === 0) issues.push('expected PRIMARY KEY');

        if (issues.length === 0) pass(`  ${table}.${columnName} matches ${expectedDefinition}`);
        else fail(`  ${table}.${columnName} contract mismatch`, issues.join(', '));
      }
    }
  } finally {
    database.close();
  }
}

// ═══════════════════════════════════════════════════
// Suite 3: Service export validation
// ═══════════════════════════════════════════════════
function testServiceExports() {
  console.log('\n⚙️  Suite 3: Service Export Contract\n');

  const serviceDir = join(ROOT, 'app/backend/src/services');

  for (const [serviceName, expectedExports] of Object.entries(contract.services)) {
    const servicePath = join(serviceDir, `${serviceName}.js`);
    if (!existsSync(servicePath)) {
      fail(`Service file '${serviceName}.js' not found`);
      continue;
    }

    const content = readFileSync(servicePath, 'utf-8');

    for (const exp of expectedExports) {
      // Match: export function name, export const name, export { name }
      const exportRegex = new RegExp(
        `export\\s+(?:async\\s+)?function\\s+${exp}\\b|export\\s+(?:const|let|var)\\s+${exp}\\b|export\\s*\\{[^}]*\\b${exp}\\b`,
        'i'
      );
      if (exportRegex.test(content)) {
        pass(`  ${serviceName}.${exp}() exported`);
      } else {
        fail(`  ${serviceName}.${exp}() not exported`, `missing from ${serviceName}.js`);
      }
    }
  }
}

// ═══════════════════════════════════════════════════
// Suite 4: Frontend API client validation
// ═══════════════════════════════════════════════════
function testFrontendApiExports() {
  console.log('\n🖥️  Suite 4: Frontend API Client Contract\n');

  const apiPath = join(ROOT, 'app/frontend/src/api/index.js');
  if (!existsSync(apiPath)) {
    fail('Frontend api/index.js not found');
    return;
  }

  const content = readFileSync(apiPath, 'utf-8');

  for (const exp of contract.frontendApi.exports) {
    const exportRegex = new RegExp(`export\\s+(?:const|function|async\\s+function)\\s+${exp}\\b`);
    if (exportRegex.test(content)) {
      pass(`  ${exp} exported`);
    } else {
      fail(`  ${exp} not exported from frontend api/index.js`);
    }
  }
}

// ═══════════════════════════════════════════════════
// Suite 5: Live API endpoint validation
// ═══════════════════════════════════════════════════
async function testLiveApiEndpoints() {
  console.log('\n🌐 Suite 5: Live API Endpoint Validation\n');

  if (SKIP_LIVE) {
    skip('Live API tests skipped (--skip-live)');
    return;
  }

  // Test health endpoint (unauthenticated)
  const healthRes = await fetchSafe(`${API_URL}/api/health`);
  if (!healthRes) {
    fail('Cannot reach API server', `${API_URL}/api/health — is the server running?`);
    skip('Skipping remaining live tests');
    return;
  }

  if (healthRes.ok) {
    const health = await healthRes.json();
    pass('GET /api/health reachable');

    // Check version
    if (health.version) pass(`Server version: ${health.version}`);
    else fail('Health response missing version field');

    // Check required fields from contract
    const required = contract.api.health['GET /api/health'].returns;
    for (const field of required) {
      if (field in health) pass(`  health.${field} present`);
      else fail(`  health.${field} missing from response`);
    }
  } else {
    fail('GET /api/health returned error', `status ${healthRes.status}`);
  }

  // Test all GET endpoints (with AUTH_DISABLED=true, these should be accessible)
  const getEndpoints = [];
  for (const [group, endpoints] of Object.entries(contract.api)) {
    for (const endpoint of Object.keys(endpoints)) {
      const [method] = endpoint.split(' ');
      if (method === 'GET' && !endpoint.includes(':id') && !endpoint.includes(':name') && !endpoint.includes(':runId')) {
        getEndpoints.push(endpoint);
      }
    }
  }

  // Test a sample of GET endpoints to verify routing is intact
  const sampleEndpoints = [
    'GET /api/ssd-backup/configs',
    'GET /api/hyper-backup/jobs',
    'GET /api/rclone/jobs',
    'GET /api/settings',
    'GET /api/peers',
    'GET /api/overview/summary',
    'GET /api/filesystem/roots',
  ];

  for (const ep of sampleEndpoints) {
    const path = ep.replace('GET ', '');
    const res = await fetchSafe(`${API_URL}${path}`);
    if (res?.ok) {
      pass(`${ep} → ${res.status}`);
    } else if (res) {
      fail(`${ep} returned error`, `status ${res.status}`);
    } else {
      fail(`${ep} → unreachable`);
    }
  }
}

// ═══════════════════════════════════════════════════
// Suite 6: Live Peer API validation
// ═══════════════════════════════════════════════════
async function testLivePeerApi() {
  console.log('\n🔗 Suite 6: Live Peer API Validation\n');

  if (SKIP_LIVE) {
    skip('Peer API tests skipped (--skip-live)');
    return;
  }

  const healthRes = await fetchSafe(`${PEER_URL}/peer/health`, {
    headers: { 'Authorization': `Bearer ${PEER_KEY}` },
  });

  if (!healthRes) {
    fail('Peer API not reachable', `${PEER_URL}/peer/health`);
    return;
  }

  if (healthRes.ok) {
    const health = await healthRes.json();
    pass('GET /peer/health reachable');

    // Check required fields
    const required = contract.peerApi['GET /peer/health'].returns;
    for (const field of required) {
      if (field in health) pass(`  peer health.${field} present`);
      else fail(`  peer health.${field} missing from response`);
    }
  } else {
    fail('GET /peer/health unexpected status', `${healthRes.status}`);
  }

  // Test storage endpoint
  const storageRes = await fetchSafe(`${PEER_URL}/peer/storage`, {
    headers: { 'Authorization': `Bearer ${PEER_KEY}` },
  });
  if (storageRes?.ok) {
    pass(`GET /peer/storage → ${storageRes.status}`);
  } else if (storageRes) {
    fail('GET /peer/storage returned error', `status ${storageRes.status}`);
  } else {
    fail('GET /peer/storage not reachable');
  }
}

// ═══════════════════════════════════════════════════
// Suite 7: Migration system validation
// ═══════════════════════════════════════════════════
function testMigrationSystem() {
  console.log('\n🔄 Suite 7: Migration System Integrity\n');

  const dbPath = join(ROOT, 'app/backend/src/db.js');
  if (!existsSync(dbPath)) {
    fail('db.js not found');
    return;
  }

  const content = readFileSync(dbPath, 'utf-8');

  if (content.includes('runMigrations(db)')) pass('db.js delegates schema ownership to runMigrations()');
  else fail('db.js does not invoke the formal migration system');

  if (!/\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX)\b/i.test(content)) pass('db.js contains no inline schema mutations');
  else fail('db.js still contains inline schema mutations');

  // Check WAL mode
  if (content.includes("journal_mode = WAL")) pass('WAL mode enabled');
  else fail('WAL mode not found in db.js');

  // Check foreign keys
  if (content.includes("foreign_keys = ON")) pass('Foreign keys enabled');
  else fail('Foreign keys not enabled in db.js');

  // Check busy timeout
  if (content.includes('busy_timeout')) pass('Busy timeout configured');
  else fail('Busy timeout not configured');

  const migrationsPath = join(ROOT, 'app/backend/src/migrations.js');
  if (existsSync(migrationsPath)) {
    pass('migrations.js formal migration system exists');

    const migContent = readFileSync(migrationsPath, 'utf-8');
    if (migContent.includes('schema_migrations')) pass('  schema_migrations tracking table used');
    else fail('  migrations.js missing schema_migrations tracking');

    const database = new Database(':memory:');
    try {
      const firstRun = runMigrations(database);
      const secondRun = runMigrations(database);
      const validation = validateMigrations(database);
      if (firstRun.ran > 0) pass(`  fresh database migrated to schema ${getSchemaVersion(database)}`);
      else fail('  fresh database ran no migrations');
      if (secondRun.ran === 0) pass('  second migration run is idempotent');
      else fail('  second migration run reapplied migrations', `${secondRun.ran} reran`);
      if (validation.ok) pass('  all numbered migrations recorded');
      else fail('  migration tracking incomplete', `missing: ${validation.missing.join(', ')}`);
    } finally {
      database.close();
    }
  } else {
    fail('migrations.js not found');
  }
}

// ═══════════════════════════════════════════════════
// Suite 8: Route file contract validation
// ═══════════════════════════════════════════════════
function testRouteFileContracts() {
  console.log('\n🛣️  Suite 8: Route File Endpoint Contract\n');

  const routeDir = join(ROOT, 'app/backend/src/routes');

  // Map API groups to route files
  const routeMap = {
    'ssd-backup': 'ssdBackup.js',
    'hyper-backup': 'hyperBackup.js',
    'rclone': 'rclone.js',
    'docker': 'docker.js',
    'media-import': 'mediaImport.js',
    'settings': 'settings.js',
    'peers': 'peers.js',
    'overview': 'overview.js',
    'filesystem': 'filesystem.js',
    'upgrade-readiness': 'upgradeReadiness.js',
  };

  for (const [group, fileName] of Object.entries(routeMap)) {
    const filePath = join(routeDir, fileName);
    if (!existsSync(filePath)) {
      fail(`Route file ${fileName} missing`);
      continue;
    }

    const content = readFileSync(filePath, 'utf-8');
    const endpoints = contract.api[group];
    if (!endpoints) continue;

    for (const endpoint of Object.keys(endpoints)) {
      const [method, fullPath] = endpoint.split(' ');
      // Extract route path relative to mount point (e.g., /api/ssd-backup/configs → /configs)
      const prefix = `/api/${group}`;
      const routePath = fullPath.replace(prefix, '') || '/';

      // Build regex to match router.METHOD('path',...) or router.METHOD("path",...)
      const escapedPath = routePath.replace(/:[a-zA-Z]+/g, ':[a-zA-Z]+').replace(/\//g, '\\/');
      const routeRegex = new RegExp(`router\\.${method.toLowerCase()}\\s*\\(\\s*['"\`]${escapedPath}['"\`]`, 'i');

      if (routeRegex.test(content)) {
        pass(`  ${endpoint}`);
      } else {
        fail(`  ${endpoint} not found in ${fileName}`);
      }
    }
  }
}

// ═══════════════════════════════════════════════════
// Suite 9: Version consistency
// ═══════════════════════════════════════════════════
function testVersionConsistency() {
  console.log('\n🏷️  Suite 9: Version Consistency\n');

  const locations = [
    { path: 'app/package.json', extract: (c) => JSON.parse(c).version },
    { path: 'app/backend/package.json', extract: (c) => JSON.parse(c).version },
    { path: 'app/frontend/package.json', extract: (c) => JSON.parse(c).version },
  ];

  const versions = new Set();
  for (const loc of locations) {
    const fullPath = join(ROOT, loc.path);
    if (existsSync(fullPath)) {
      const v = loc.extract(readFileSync(fullPath, 'utf-8'));
      versions.add(v);
      pass(`${loc.path} → v${v}`);
    } else {
      fail(`${loc.path} not found`);
    }
  }

  // Check hardcoded version in index.js and peerApi.js
  const indexPath = join(ROOT, 'app/backend/src/index.js');
  const peerPath = join(ROOT, 'app/backend/src/peerApi.js');
  for (const fp of [indexPath, peerPath]) {
    if (existsSync(fp)) {
      const content = readFileSync(fp, 'utf-8');
      const match = content.match(/version:\s*['"]([^'"]+)['"]/);
      if (match) {
        versions.add(match[1]);
        pass(`${fp.replace(ROOT + '/', '')} → v${match[1]}`);
      }
    }
  }

  if (versions.size === 1) pass(`All versions consistent: v${[...versions][0]}`);
  else fail('Version mismatch detected', `found: ${[...versions].join(', ')}`);
}

// ═══════════════════════════════════════════════════
// Run all suites
// ═══════════════════════════════════════════════════
console.log('═══════════════════════════════════════════════');
console.log(' RedMan Backward Compatibility Test');
console.log(` Contract: v${contract.version}`);
console.log(` API: ${API_URL}  |  Peer: ${PEER_URL}`);
console.log('═══════════════════════════════════════════════');

testContractIntegrity();
testDatabaseSchema();
testServiceExports();
testFrontendApiExports();
testRouteFileContracts();
testVersionConsistency();
testMigrationSystem();

// Live tests (async)
await testLiveApiEndpoints();
await testLivePeerApi();

// ── Summary ──
console.log('\n═══════════════════════════════════════════════');
console.log(` Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
console.log('═══════════════════════════════════════════════');

if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  • ${f}`);
  console.log('');
}

process.exit(failed > 0 ? 1 : 0);

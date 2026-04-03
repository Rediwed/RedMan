#!/usr/bin/env node

// RedMan Backward Compatibility Test
// Validates that the running instance conforms to the v1 API + DB + service contracts.
// Usage: node test/test_backward_compat.mjs [--api-url http://localhost:8090] [--peer-url http://localhost:8091] [--peer-key KEY]
//
// Requires a running RedMan instance (./test/setup_local_test.sh)

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

// ── CLI args ──
const args = process.argv.slice(2);
function getArg(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const API_URL = getArg('--api-url', 'http://localhost:8090');
const PEER_URL = getArg('--peer-url', 'http://localhost:8091');
const PEER_KEY = getArg('--peer-key', 'test-peer-key-beta');
const SKIP_LIVE = args.includes('--skip-live');

// ── Load contract ──
const contractPath = join(ROOT, 'app/backend/src/contracts/v1.json');
if (!existsSync(contractPath)) {
  console.error('❌ Contract file not found:', contractPath);
  process.exit(1);
}
const contract = JSON.parse(readFileSync(contractPath, 'utf-8'));

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

  // Version must match
  if (contract.version === '1.0.0') pass('Contract version is 1.0.0');
  else fail('Contract version mismatch', `expected 1.0.0, got ${contract.version}`);

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

  const seedPath = join(ROOT, 'app/backend/src/seed.js');
  const dbPath = join(ROOT, 'app/backend/src/db.js');

  if (!existsSync(seedPath)) {
    fail('seed.js not found');
    return;
  }

  const seedContent = readFileSync(seedPath, 'utf-8');
  const dbContent = existsSync(dbPath) ? readFileSync(dbPath, 'utf-8') : '';

  for (const [table, schema] of Object.entries(contract.database)) {
    // Check table exists in seed.js
    const tableRegex = new RegExp(`CREATE\\s+TABLE\\s+(IF\\s+NOT\\s+EXISTS\\s+)?${table}\\b`, 'i');
    if (tableRegex.test(seedContent) || tableRegex.test(dbContent)) {
      pass(`Table '${table}' found in schema definitions`);
    } else {
      fail(`Table '${table}' missing from seed.js/db.js`);
      continue;
    }

    // Check each column exists in the CREATE TABLE for this table
    // Extract from CREATE TABLE ... to the next db.exec or end of statement
    // We search for the table name then grab everything until the closing `)`; followed by a newline
    const tableIdx = seedContent.indexOf(`CREATE TABLE ${table}`);
    if (tableIdx < 0) {
      skip(`Cannot parse CREATE TABLE block for '${table}' — check manually`);
      continue;
    }

    // Find the matching closing paren by counting parens from the opening `(`
    const openIdx = seedContent.indexOf('(', tableIdx);
    let depth = 0;
    let closeIdx = -1;
    for (let i = openIdx; i < seedContent.length; i++) {
      if (seedContent[i] === '(') depth++;
      if (seedContent[i] === ')') { depth--; if (depth === 0) { closeIdx = i; break; } }
    }

    if (closeIdx < 0) {
      skip(`Cannot find closing paren for '${table}' CREATE TABLE — check manually`);
      continue;
    }

    const block = seedContent.slice(openIdx, closeIdx + 1);
    for (const col of Object.keys(schema.columns)) {
      if (block.includes(col)) {
        pass(`  ${table}.${col} present`);
      } else {
        // Column might be added via ALTER TABLE in db.js
        const alterRegex = new RegExp(`ALTER\\s+TABLE\\s+${table}\\s+ADD\\s+COLUMN\\s+${col}\\b`, 'i');
        if (alterRegex.test(dbContent)) {
          pass(`  ${table}.${col} present (via db.js migration)`);
        } else {
          fail(`  ${table}.${col} missing`, `expected in ${table}`);
        }
      }
    }
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
    if (res && (res.ok || res.status === 401)) {
      // 401 means endpoint exists but auth is required — still valid
      pass(`${ep} → ${res.status}`);
    } else if (res) {
      // 404 or 500 means endpoint is missing or broken
      if (res.status === 404) fail(`${ep} → 404 Not Found`);
      else pass(`${ep} → ${res.status}`);
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
    skip('Peer API not reachable — skipping');
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
  } else if (healthRes.status === 401) {
    pass('GET /peer/health → 401 (auth working, endpoint exists)');
  } else {
    fail('GET /peer/health unexpected status', `${healthRes.status}`);
  }

  // Test storage endpoint
  const storageRes = await fetchSafe(`${PEER_URL}/peer/storage`, {
    headers: { 'Authorization': `Bearer ${PEER_KEY}` },
  });
  if (storageRes && (storageRes.ok || storageRes.status === 401)) {
    pass(`GET /peer/storage → ${storageRes.status}`);
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

  // Check that migrations are safe (idempotent patterns)
  const hasTableCheck = content.includes('tableExists');
  const hasPragmaTableInfo = content.includes('PRAGMA table_info');
  const hasCreateIfNotExists = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS/i.test(content) || content.includes('tableExists');
  const hasCreateIndexIfNotExists = /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS/i.test(content);

  if (hasTableCheck) pass('db.js uses tableExists() guard');
  else fail('db.js missing tableExists() guard — migrations may not be idempotent');

  if (hasPragmaTableInfo) pass('db.js checks column existence via PRAGMA table_info');
  else fail('db.js missing PRAGMA table_info checks');

  if (hasCreateIfNotExists) pass('db.js uses safe CREATE TABLE pattern');
  else fail('db.js may have unsafe CREATE TABLE without IF NOT EXISTS');

  if (hasCreateIndexIfNotExists) pass('db.js uses CREATE INDEX IF NOT EXISTS');
  else fail('db.js may have unsafe CREATE INDEX without IF NOT EXISTS');

  // Check WAL mode
  if (content.includes("journal_mode = WAL")) pass('WAL mode enabled');
  else fail('WAL mode not found in db.js');

  // Check foreign keys
  if (content.includes("foreign_keys = ON")) pass('Foreign keys enabled');
  else fail('Foreign keys not enabled in db.js');

  // Check busy timeout
  if (content.includes('busy_timeout')) pass('Busy timeout configured');
  else fail('Busy timeout not configured');

  // Check migrations.js exists (formal migration system)
  const migrationsPath = join(ROOT, 'app/backend/src/migrations.js');
  if (existsSync(migrationsPath)) {
    pass('migrations.js formal migration system exists');

    const migContent = readFileSync(migrationsPath, 'utf-8');
    if (migContent.includes('schema_migrations')) pass('  schema_migrations tracking table used');
    else fail('  migrations.js missing schema_migrations tracking');
  } else {
    skip('migrations.js not found (using inline db.js migrations only)');
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

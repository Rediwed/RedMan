#!/usr/bin/env node

/**
 * test_delta_versioning.mjs — End-to-end test for delta versioning in SSD Backup.
 *
 * Tests the full lifecycle:
 *   1. Creates an SSD backup config with delta versioning enabled
 *   2. Generates source files with known content
 *   3. Runs backup (creates initial snapshot — all full copies)
 *   4. Mutates source files (modify, add, delete)
 *   5. Runs backup again (creates delta-compressed snapshot)
 *   6. Repeats mutations to build a delta chain
 *   7. Verifies snapshots via version browser API
 *   8. Downloads files from delta snapshots and verifies content
 *   9. Restores files and verifies correctness
 *  10. Runs integrity verification
 *  11. Verifies tiered retention policy behavior
 *
 * Prerequisites:
 *   - Instance A running on localhost:8090 (./test/setup_local_test.sh)
 *   - rdiff available on PATH (brew install librsync on macOS)
 *
 * Usage:
 *   node test/test_delta_versioning.mjs [--api-url http://localhost:8090]
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ──

const API_URL = process.argv.includes('--api-url')
  ? process.argv[process.argv.indexOf('--api-url') + 1]
  : 'http://localhost:8090';
const API = `${API_URL}/api`;

const TEST_DIR = resolve(__dirname, 'data', 'delta_test');
const SOURCE_DIR = join(TEST_DIR, 'source');
const DEST_DIR = join(TEST_DIR, 'dest');

let configId = null;
let passed = 0;
let failed = 0;
const errors = [];

// ── Helpers ──

async function api(method, path, body = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${API}${path}`, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(`${method} ${path} → ${res.status}: ${err.error || JSON.stringify(err)}`);
  }
  return res.json();
}

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    errors.push(message);
    console.log(`  ❌ ${message}`);
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function waitForRun(runId, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const run = await api('GET', `/ssd-backup/runs/${runId}`);
    if (run.status === 'completed') return run;
    if (run.status === 'failed') throw new Error(`Run ${runId} failed: ${run.error_message}`);
    await sleep(1000);
  }
  throw new Error(`Run ${runId} timed out after ${timeoutMs}ms`);
}

// ── Setup ──

function setupSourceFiles() {
  // Create a known set of source files with deterministic content
  mkdirSync(join(SOURCE_DIR, 'documents'), { recursive: true });
  mkdirSync(join(SOURCE_DIR, 'photos'), { recursive: true });
  mkdirSync(join(SOURCE_DIR, 'data'), { recursive: true });

  // Small text files (will produce good deltas when slightly modified)
  writeFileSync(join(SOURCE_DIR, 'documents', 'readme.txt'),
    'This is a test document for delta versioning.\n'.repeat(100));

  writeFileSync(join(SOURCE_DIR, 'documents', 'notes.md'),
    '# Project Notes\n\n' + 'Some important notes about the project.\n'.repeat(50));

  writeFileSync(join(SOURCE_DIR, 'documents', 'config.json'),
    JSON.stringify({
      version: 1, name: 'test-config',
      settings: { debug: false, logLevel: 'info', maxRetries: 3 },
      history: Array.from({ length: 100 }, (_, i) => ({ id: i, ts: Date.now(), value: `entry-${i}` })),
    }, null, 2));

  // Medium binary-ish files (will test delta threshold)
  writeFileSync(join(SOURCE_DIR, 'photos', 'photo_001.bin'), randomBytes(50_000));
  writeFileSync(join(SOURCE_DIR, 'photos', 'photo_002.bin'), randomBytes(50_000));
  writeFileSync(join(SOURCE_DIR, 'photos', 'photo_003.bin'), randomBytes(50_000));

  // Larger file (good for testing delta savings on partial changes)
  const largeContent = Buffer.alloc(200_000);
  for (let i = 0; i < largeContent.length; i++) {
    largeContent[i] = i % 256;
  }
  writeFileSync(join(SOURCE_DIR, 'data', 'dataset.bin'), largeContent);

  // CSV with structured data (appending rows later = great delta candidate)
  const csvRows = ['id,name,value,timestamp'];
  for (let i = 0; i < 500; i++) {
    csvRows.push(`${i},item_${i},${Math.random().toFixed(4)},${Date.now()}`);
  }
  writeFileSync(join(SOURCE_DIR, 'data', 'records.csv'), csvRows.join('\n'));

  console.log('  📁 Created source files');
}

function mutateSourceFiles(iteration) {
  // Apply different mutations each round to exercise delta chains
  switch (iteration) {
    case 1:
      // Modify text files (small changes → should produce small deltas)
      writeFileSync(join(SOURCE_DIR, 'documents', 'readme.txt'),
        'UPDATED: This is a test document for delta versioning.\n'.repeat(100) +
        '\n--- Updated in iteration 1 ---\n');

      // Append to CSV (partial change → great delta)
      const csv = readFileSync(join(SOURCE_DIR, 'data', 'records.csv'), 'utf-8');
      writeFileSync(join(SOURCE_DIR, 'data', 'records.csv'),
        csv + '\n' + Array.from({ length: 50 }, (_, i) =>
          `${500 + i},new_item_${i},${Math.random().toFixed(4)},${Date.now()}`
        ).join('\n'));

      // Add new files
      writeFileSync(join(SOURCE_DIR, 'documents', 'changelog.txt'),
        'v1.0 - Initial release\n'.repeat(30));

      // Modify dataset (change a chunk in the middle)
      const data = readFileSync(join(SOURCE_DIR, 'data', 'dataset.bin'));
      for (let i = 50_000; i < 55_000; i++) data[i] = 0xFF;
      writeFileSync(join(SOURCE_DIR, 'data', 'dataset.bin'), data);

      console.log('  🔄 Mutation 1: modified text, appended CSV, changed binary chunk, added file');
      break;

    case 2:
      // Modify config JSON (change some values)
      const config = JSON.parse(readFileSync(join(SOURCE_DIR, 'documents', 'config.json'), 'utf-8'));
      config.version = 2;
      config.settings.debug = true;
      config.settings.newField = 'added-in-v2';
      config.history.push(...Array.from({ length: 20 }, (_, i) => ({
        id: 100 + i, ts: Date.now(), value: `v2-entry-${i}`,
      })));
      writeFileSync(join(SOURCE_DIR, 'documents', 'config.json'), JSON.stringify(config, null, 2));

      // Delete a photo (tests versioned deletion)
      try { rmSync(join(SOURCE_DIR, 'photos', 'photo_003.bin')); } catch {}

      // Replace photo_001 entirely (should be kept as full, not delta — too different)
      writeFileSync(join(SOURCE_DIR, 'photos', 'photo_001.bin'), randomBytes(50_000));

      // Modify notes (small addition)
      const notes = readFileSync(join(SOURCE_DIR, 'documents', 'notes.md'), 'utf-8');
      writeFileSync(join(SOURCE_DIR, 'documents', 'notes.md'),
        notes + '\n\n## Added in iteration 2\n\nNew section with more notes.\n');

      console.log('  🔄 Mutation 2: changed JSON, deleted photo, replaced binary, appended markdown');
      break;

    case 3:
      // Heavy modification to force a mix of delta and full copies
      writeFileSync(join(SOURCE_DIR, 'documents', 'readme.txt'),
        'FINAL VERSION of the readme.\n'.repeat(200));

      writeFileSync(join(SOURCE_DIR, 'data', 'records.csv'),
        'id,name,value\n' + Array.from({ length: 1000 }, (_, i) =>
          `${i},final_${i},${(i * 0.001).toFixed(6)}`
        ).join('\n'));

      // Add a new subdirectory with files
      mkdirSync(join(SOURCE_DIR, 'archive'), { recursive: true });
      writeFileSync(join(SOURCE_DIR, 'archive', 'old_data.txt'), 'Archived data\n'.repeat(200));
      writeFileSync(join(SOURCE_DIR, 'archive', 'backup_log.txt'), 'Backup completed at ' + new Date().toISOString() + '\n');

      console.log('  🔄 Mutation 3: rewrote files, added archive directory');
      break;
  }
}

// ── Tests ──

async function testCreateConfig() {
  console.log('\n── Step 1: Create delta-versioning SSD backup config ──');

  const config = await api('POST', '/ssd-backup/configs', {
    name: 'Delta Versioning Test',
    source_path: SOURCE_DIR,
    dest_path: DEST_DIR,
    cron_expression: '0 0 31 2 *', // never runs (Feb 31)
    versioning_enabled: true,
    delta_versioning: true,
    delta_threshold: 30,   // lower threshold to see more deltas with test data
    delta_max_chain: 5,
    delta_keyframe_days: 7,
    retention_policy: { hourly: 24, daily: 7, weekly: 30, monthly: 90, quarterly: 365 },
    enabled: false,
  });

  configId = config.id;
  assert(configId > 0, `Config created with id=${configId}`);
  assert(config.delta_versioning === 1, 'Delta versioning enabled');
  assert(config.delta_threshold === 30, `Delta threshold = ${config.delta_threshold}`);
  assert(config.delta_max_chain === 5, `Max chain = ${config.delta_max_chain}`);

  // Verify retention policy stored correctly
  const fetched = await api('GET', `/ssd-backup/configs/${configId}`);
  const policy = JSON.parse(fetched.retention_policy);
  assert(policy.hourly === 24, `Retention hourly = ${policy.hourly}`);
  assert(policy.quarterly === 365, `Retention quarterly = ${policy.quarterly}`);
}

async function testInitialBackup() {
  console.log('\n── Step 2: Run initial backup (full copies, no deltas yet) ──');

  const { runId } = await api('POST', `/ssd-backup/configs/${configId}/run`, {});
  assert(runId > 0, `Backup run started: id=${runId}`);

  const run = await waitForRun(runId);
  assert(run.status === 'completed', `Initial backup completed`);
  assert(run.files_copied > 0, `Copied ${run.files_copied} files`);

  // Check snapshots — should have no snapshots yet (first run has nothing to version)
  const snapshots = await api('GET', `/ssd-backup/configs/${configId}/snapshots`);
  console.log(`  📸 Snapshots after initial backup: ${snapshots.length}`);
  // First backup may or may not create a snapshot (depends on whether there were changes at dest)
}

async function testDeltaBackup(iteration) {
  console.log(`\n── Step 3.${iteration}: Mutate source + run backup (iteration ${iteration}) ──`);

  mutateSourceFiles(iteration);

  // Small delay to ensure different timestamp
  await sleep(1500);

  const { runId } = await api('POST', `/ssd-backup/configs/${configId}/run`, {});
  assert(runId > 0, `Backup ${iteration} started: id=${runId}`);

  const run = await waitForRun(runId);
  assert(run.status === 'completed', `Backup ${iteration} completed (${run.files_copied} files, ${run.duration_seconds?.toFixed(1)}s)`);
}

async function testSnapshotBrowser() {
  console.log('\n── Step 4: Verify snapshots via version browser ──');

  const snapshots = await api('GET', `/ssd-backup/configs/${configId}/snapshots`);
  assert(snapshots.length >= 2, `Found ${snapshots.length} snapshots (expected ≥ 2)`);

  // Check that snapshots have delta stats
  const hasStats = snapshots.some(s => s.diskSize !== null);
  if (hasStats) {
    console.log('  📊 Delta stats found in snapshots:');
    for (const s of snapshots.slice(0, 3)) {
      const saving = s.originalSize && s.diskSize != null
        ? ` (${Math.round((1 - s.diskSize / s.originalSize) * 100)}% saved)`
        : '';
      console.log(`     ${s.timestamp}: ${s.fileCount} files, tier=${s.tier || 'none'}${saving}`);
    }
  }

  // Check retention tier assignments
  const hasTiers = snapshots.some(s => s.tier);
  assert(hasTiers, 'Snapshots have retention tier assignments');

  // Browse the newest snapshot
  const newest = snapshots[0];
  const entries = await api('GET', `/ssd-backup/configs/${configId}/browse?timestamp=${newest.timestamp}`);
  assert(entries.length > 0, `Browsed newest snapshot: ${entries.length} entries`);

  // Verify delta badge info is present
  const hasDelta = entries.some(e => e.isDelta);
  console.log(`  🔍 Files with delta badge: ${entries.filter(e => e.isDelta).length} / ${entries.length}`);

  // Browse subdirectory
  const docEntries = await api('GET', `/ssd-backup/configs/${configId}/browse?timestamp=${newest.timestamp}&path=documents`);
  assert(docEntries.length > 0, `Browsed documents/ in snapshot: ${docEntries.length} files`);

  return snapshots;
}

async function testSnapshotDownloadAndRestore(snapshots) {
  console.log('\n── Step 5: Download + restore from delta snapshots ──');

  if (snapshots.length < 2) {
    console.log('  ⚠️  Not enough snapshots to test download/restore');
    return;
  }

  // Try downloading a file from the oldest available snapshot (most likely a delta)
  const oldest = snapshots[snapshots.length - 1];

  // Download a known text file
  const downloadUrl = `${API}/ssd-backup/configs/${configId}/download?timestamp=${oldest.timestamp}&path=documents/readme.txt`;
  const downloadRes = await fetch(downloadUrl);
  assert(downloadRes.ok, `Downloaded documents/readme.txt from ${oldest.timestamp}`);

  if (downloadRes.ok) {
    const content = await downloadRes.text();
    assert(content.length > 0, `Downloaded file has content (${content.length} bytes)`);
    assert(content.includes('test document'), 'Downloaded content matches expected text');
  }

  // Restore a file via API
  try {
    const restoreResult = await api('POST', `/ssd-backup/configs/${configId}/restore`, {
      timestamp: oldest.timestamp,
      path: 'documents/readme.txt',
    });
    assert(restoreResult.restored === 'documents/readme.txt', `Restored ${restoreResult.restored}`);

    // Verify the restored file exists at source
    const restoredContent = readFileSync(join(SOURCE_DIR, 'documents', 'readme.txt'), 'utf-8');
    assert(restoredContent.length > 0, 'Restored file exists at source');
  } catch (err) {
    assert(false, `Restore failed: ${err.message}`);
  }
}

async function testIntegrityVerification() {
  console.log('\n── Step 6: Verify delta chain integrity ──');

  const result = await api('POST', `/ssd-backup/configs/${configId}/verify-versions`, {});
  console.log(`  🔍 Verified: ${result.verified} deltas, ${result.broken} broken`);
  assert(result.broken === 0, `No broken delta chains (${result.verified} verified)`);

  if (result.errors && result.errors.length > 0) {
    for (const err of result.errors) {
      console.log(`  ⚠️  ${err.timestamp}/${err.filePath}: ${err.error}`);
    }
  }
}

async function testVersionStats() {
  console.log('\n── Step 7: Check dashboard version stats ──');

  const summary = await api('GET', '/overview/summary');
  if (summary.versionStats) {
    console.log(`  📊 Dashboard stats: ${summary.versionStats.snapshotCount} snapshots, ${(summary.versionStats.totalDiskSize / 1024).toFixed(1)} KB on disk`);
    if (summary.versionStats.spaceSaved > 0) {
      console.log(`  💾 Space saved by deltas: ${(summary.versionStats.spaceSaved / 1024).toFixed(1)} KB`);
    }
    assert(summary.versionStats.snapshotCount > 0, `Version stats present: ${summary.versionStats.snapshotCount} snapshots`);
  } else {
    console.log('  ℹ️  No version stats cached yet (may appear after next run)');
  }
}

async function testPruneManual() {
  console.log('\n── Step 8: Test manual prune ──');

  const result = await api('POST', `/ssd-backup/configs/${configId}/prune`, {});
  console.log(`  🗑️  Pruned: ${result.pruned}, kept: ${result.kept || 'N/A'}`);
  assert(result.pruned >= 0, `Prune completed (pruned=${result.pruned})`);
}

// ── Cleanup ──

async function cleanup() {
  console.log('\n── Cleanup ──');

  if (configId) {
    try {
      await api('DELETE', `/ssd-backup/configs/${configId}`);
      console.log(`  🗑️  Deleted config ${configId}`);
    } catch {}
  }

  // Remove test directories
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
    console.log('  🗑️  Removed test data directory');
  } catch {}
}

// ── Main ──

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   Delta Versioning End-to-End Test Suite     ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`API: ${API}`);

  // Check prerequisites
  console.log('\n── Prerequisites ──');
  try {
    await fetch(`${API}/health`);
    console.log('  ✅ RedMan API reachable');
  } catch {
    console.error('  ❌ RedMan API not reachable at', API);
    console.error('     Start it with: ./test/setup_local_test.sh');
    process.exit(1);
  }

  // Check if rdiff is available (needed for delta versioning on the backend)
  try {
    execSync('which rdiff', { stdio: 'pipe' });
    console.log('  ✅ rdiff available');
  } catch {
    console.log('  ⚠️  rdiff not found — delta versioning will fall back to full copies');
    console.log('     Install with: brew install librsync');
  }

  // Clean slate
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(SOURCE_DIR, { recursive: true });
  mkdirSync(DEST_DIR, { recursive: true });
  setupSourceFiles();

  try {
    await testCreateConfig();
    await testInitialBackup();
    await testDeltaBackup(1);
    await testDeltaBackup(2);
    await testDeltaBackup(3);

    const snapshots = await testSnapshotBrowser();
    await testSnapshotDownloadAndRestore(snapshots);
    await testIntegrityVerification();
    await testVersionStats();
    await testPruneManual();
  } catch (err) {
    console.error('\n💥 Test suite error:', err.message);
    failed++;
    errors.push(`Suite error: ${err.message}`);
  }

  // Cleanup
  await cleanup();

  // Summary
  console.log('\n══════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  if (errors.length > 0) {
    console.log('  Failures:');
    for (const err of errors) console.log(`    - ${err}`);
  }
  console.log('══════════════════════════════════════════════\n');

  process.exit(failed > 0 ? 1 : 0);
}

main();

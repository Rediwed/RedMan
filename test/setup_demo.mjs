// Set up delta versioning demo data for browser viewing
const API = 'http://localhost:8090/api';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';

const src = join(process.cwd(), 'test/data/source');

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${API}${path}`, opts);
  return r.json();
}

async function waitRun(runId) {
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const s = await api('GET', `/ssd-backup/runs/${runId}`);
    if (s.status === 'completed') return s;
    if (s.status === 'failed') throw new Error(s.error_message);
  }
}

async function go() {
  const cfg = await api('POST', '/ssd-backup/configs', {
    name: 'Delta Versioning Demo',
    source_path: src,
    dest_path: join(process.cwd(), 'test/data/dest_ssd'),
    cron_expression: '0 0 31 2 *',
    versioning_enabled: true,
    delta_versioning: true,
    delta_threshold: 30,
    delta_max_chain: 10,
    delta_keyframe_days: 7,
    retention_policy: { hourly: 24, daily: 7, weekly: 30, monthly: 90, quarterly: 365 },
    enabled: false,
  });
  console.log('Config:', cfg.id, cfg.name);

  // Run 1: initial
  console.log('Backup 1...');
  const r1 = await api('POST', `/ssd-backup/configs/${cfg.id}/run`, {});
  const s1 = await waitRun(r1.runId);
  console.log(`  Done: ${s1.files_copied} files`);

  // Mutate
  const mf = join(src, 'manifest.json');
  if (existsSync(mf)) {
    const d = JSON.parse(readFileSync(mf, 'utf-8'));
    d.delta_test = { iteration: 1, ts: new Date().toISOString() };
    writeFileSync(mf, JSON.stringify(d, null, 2));
  }
  writeFileSync(join(src, 'delta_demo.txt'), 'Added for delta demo\n' + new Date().toISOString() + '\n');
  await new Promise(r => setTimeout(r, 1500));

  // Run 2
  console.log('Backup 2...');
  const r2 = await api('POST', `/ssd-backup/configs/${cfg.id}/run`, {});
  const s2 = await waitRun(r2.runId);
  console.log(`  Done: ${s2.files_copied} files`);

  // Mutate again
  if (existsSync(mf)) {
    const d = JSON.parse(readFileSync(mf, 'utf-8'));
    d.delta_test.iteration = 2;
    d.delta_test.ts = new Date().toISOString();
    writeFileSync(mf, JSON.stringify(d, null, 2));
  }
  writeFileSync(join(src, 'delta_demo.txt'), 'Updated round 2\n' + new Date().toISOString() + '\n');
  await new Promise(r => setTimeout(r, 1500));

  // Run 3
  console.log('Backup 3...');
  const r3 = await api('POST', `/ssd-backup/configs/${cfg.id}/run`, {});
  const s3 = await waitRun(r3.runId);
  console.log(`  Done: ${s3.files_copied} files`);

  const snaps = await api('GET', `/ssd-backup/configs/${cfg.id}/snapshots`);
  console.log(`\n${snaps.length} snapshots ready:`);
  for (const s of snaps) {
    const pct = s.originalSize && s.diskSize != null ? ` (${Math.round((1 - s.diskSize / s.originalSize) * 100)}% saved)` : '';
    console.log(`  ${s.timestamp}: ${s.fileCount} files [${s.tier}]${pct}`);
  }
  console.log('\n→ Open http://localhost:5175 → SSD Backup → Browse on "Delta Versioning Demo"');
}

go().catch(e => console.error(e));

// Test Hyper Backup error messages for different failure scenarios
const BASE = 'http://localhost:8090';

async function testError(name, setup, cleanup) {
  console.log(`\n=== ${name} ===`);
  if (setup) await setup();

  const r = await fetch(`${BASE}/api/hyper-backup/jobs/1/run`, { method: 'POST' });
  const d = await r.json();
  if (d.error) { console.log('  Start error:', d.error); return; }
  console.log('  Run started:', d.runId);

  await new Promise(r => setTimeout(r, 5000));

  const runs = await fetch(`${BASE}/api/hyper-backup/runs?limit=1`).then(r => r.json());
  const run = runs.runs[0];
  console.log('  Status:', run.status);
  console.log('  Error:', run.error_message || '(none)');

  if (cleanup) await cleanup();
}

async function main() {
  // Wait for server
  await new Promise(r => setTimeout(r, 4000));

  // Test 1: Successful run (should work)
  await testError('Normal run (should succeed)');

  // Test 2: Bad API key — change the job's key temporarily
  await testError('Bad API key', async () => {
    await fetch(`${BASE}/api/hyper-backup/jobs/1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ remote_api_key: 'wrong-key-12345' })
    });
  }, async () => {
    await fetch(`${BASE}/api/hyper-backup/jobs/1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ remote_api_key: 'test-peer-key-beta' })
    });
  });

  // Test 3: Connection refused — point to wrong port
  await testError('Connection refused (wrong port)', async () => {
    await fetch(`${BASE}/api/hyper-backup/jobs/1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ remote_url: 'http://localhost:9999' })
    });
  }, async () => {
    await fetch(`${BASE}/api/hyper-backup/jobs/1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ remote_url: 'http://localhost:8095' })
    });
  });

  // Test 4: Bad path (rsync error)
  await testError('Bad source path', async () => {
    await fetch(`${BASE}/api/hyper-backup/jobs/1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ local_path: '/nonexistent/path/that/does/not/exist' })
    });
  }, async () => {
    const { userInfo } = await import('os');
    await fetch(`${BASE}/api/hyper-backup/jobs/1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ local_path: process.env.HOME + '/dev/RedMan/test/data/source' })
    });
  });
}

main().catch(console.error);

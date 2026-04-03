/**
 * setup_ssh.mjs — Generate SSH keys and authorize localhost on both test instances.
 * Usage: node test/setup_ssh.mjs
 */
import { userInfo } from 'os';

const user = userInfo().username;

async function setup() {
  // Instance A: generate SSH key
  let r = await fetch('http://localhost:8090/api/settings/ssh/generate', { method: 'POST' });
  let d = await r.json();
  console.log('A SSH generate:', d.message || d.error);

  // Instance A: authorize localhost
  r = await fetch('http://localhost:8090/api/settings/ssh/authorize-localhost', { method: 'POST' });
  d = await r.json();
  console.log('A SSH authorize-localhost:', d.message || d.error);

  // Instance B: generate SSH key
  r = await fetch('http://localhost:8094/api/settings/ssh/generate', { method: 'POST' });
  d = await r.json();
  console.log('B SSH generate:', d.message || d.error);

  // Instance B: authorize localhost
  r = await fetch('http://localhost:8094/api/settings/ssh/authorize-localhost', { method: 'POST' });
  d = await r.json();
  console.log('B SSH authorize-localhost:', d.message || d.error);

  // Test SSH connection from Instance A
  r = await fetch('http://localhost:8090/api/settings/ssh/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ host: 'localhost', port: 22, user })
  });
  d = await r.json();
  console.log('A SSH test to localhost:', d.message || d.error);

  // Test Hyper Backup connection from Instance A to Instance B peer
  r = await fetch('http://localhost:8090/api/hyper-backup/test-connection', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      remote_url: 'http://localhost:8095',
      remote_api_key: 'test-peer-key-beta'
    })
  });
  d = await r.json();
  console.log('A→B Hyper Backup peer test:', d.message || d.error || JSON.stringify(d));

  console.log('\n✅ SSH setup complete.');
}

setup().catch(e => console.error('Error:', e.message));

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const frontend = resolve(import.meta.dirname, '../app/frontend/src');
const expectations = [
  ['pages/SsdBackupPage.jsx', ['Preview ${entry.name}', 'Download ${entry.name}', 'Restore ${entry.name} to source', 'Delete ${c.name}']],
  ['pages/HyperBackupPage.jsx', ['Delete ${j.name}', 'Close run details']],
  ['pages/RclonePage.jsx', ['Test ${r}', 'Edit ${r}', 'Delete ${r}', 'Delete ${j.name}']],
  ['pages/SettingsPage.jsx', ['View audit log for ${p.name}', 'Regenerate key for ${p.name}', 'Delete ${p.name}']],
];

for (const [file, labels] of expectations) {
  const source = readFileSync(resolve(frontend, file), 'utf8');
  for (const label of labels) assert.ok(source.includes(label), `${file} missing ${label}`);
}
console.log('Icon controls: accessible labels and retained tooltips passed');
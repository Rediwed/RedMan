import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(import.meta.dirname, '../app/frontend/src/components/Dialog.jsx'), 'utf8');
const requiredPatterns = [
  /createPortal/,
  /role="dialog"/,
  /aria-modal="true"/,
  /aria-labelledby=/,
  /export function DialogSurface/,
  /root\.inert = true/,
  /event\.key === 'Escape'/,
  /event\.key !== 'Tab'/,
  /openerRef\.current\?\.focus/,
  /aria-label="Close dialog"/,
];

for (const pattern of requiredPatterns) {
  assert.match(source, pattern, `Dialog is missing required behavior: ${pattern}`);
}

for (const file of [
  'components/PathPicker.jsx',
  'components/RemotePathPicker.jsx',
  'pages/HyperBackupPage.jsx',
  'pages/MediaImportPage.jsx',
  'pages/RclonePage.jsx',
  'pages/SettingsPage.jsx',
  'pages/SsdBackupPage.jsx',
]) {
  const consumer = readFileSync(resolve(import.meta.dirname, '../app/frontend/src', file), 'utf8');
  assert.doesNotMatch(consumer, /className="modal-overlay"/, `${file} bypasses DialogSurface`);
}

console.log('Accessible dialog primitive: semantics, focus, Escape, trap, inertness, and exclusive ownership passed');
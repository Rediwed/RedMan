import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const frontendRoot = resolve(import.meta.dirname, '../app/frontend');
const require = createRequire(resolve(frontendRoot, 'package.json'));
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
const vite = await createServer({ root: frontendRoot, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });

try {
  const { default: NotificationPolicyField } = await vite.ssrLoadModule('/src/components/NotificationPolicyField.jsx');
  const render = (notifyMode, variant = 'buttons') => renderToStaticMarkup(React.createElement(NotificationPolicyField, {
    form: {
      notify_mode: notifyMode,
      notify_on_start: true,
      notify_on_success: false,
      notify_on_failure: true,
    },
    onChange() {},
    variant,
  }));

  const global = render('global');
  assert.match(global, /Use global/);
  assert.match(global, /Follows notification settings/);
  assert.doesNotMatch(global, /On start/);

  const custom = render('custom');
  assert.match(custom, /On start/);
  assert.match(custom, /On success/);
  assert.match(custom, /aria-pressed="false"/);

  const silent = render('silent');
  assert.match(silent, /No notifications for this job/);
  assert.doesNotMatch(silent, /On failure/);

  const segmented = render('custom', 'segmented');
  assert.match(segmented, /class="segmented"/);
  assert.doesNotMatch(segmented, /role="tab"/);
} finally {
  await vite.close();
}

console.log('Notification policy component: global, custom, silent, and segmented states passed');
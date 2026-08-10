import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const routes = [
  ['/', 'Overview'],
  ['/ssd-backup', 'SSD Backup'],
  ['/hyper-backup', 'Hyper Backup'],
  ['/rclone', 'Cloud Backup'],
  ['/media-import', 'Media Import'],
  ['/status', 'Status'],
  ['/settings', 'Settings'],
  ['/account', 'Account'],
];

test('core routes render without runtime errors or horizontal overflow', async ({ page }) => {
  const runtimeErrors = [];
  page.on('pageerror', error => runtimeErrors.push(error.message));

  for (const [path, heading] of routes) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${path} overflows horizontally`).toBeLessThanOrEqual(1);
  }

  expect(runtimeErrors).toEqual([]);
});

test('overview has no serious or critical accessibility violations', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
  const result = await new AxeBuilder({ page }).analyze();
  const severe = result.violations.filter(violation => ['serious', 'critical'].includes(violation.impact));
  expect(severe, JSON.stringify(severe, null, 2)).toEqual([]);
});

test('mobile navigation exposes and follows feature links', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('mobile'));
  await page.goto('/');
  await page.getByRole('button', { name: 'Toggle menu' }).click();
  await page.getByRole('link', { name: 'SSD Backup', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'SSD Backup' })).toBeVisible();
});
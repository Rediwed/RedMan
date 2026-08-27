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

test('media import restores running cards after navigation without duplicate polling', async ({ page }) => {
  const progressRequests = new Map();
  let activeRunRequests = 0;
  await page.route('**/api/media-import/sources', route => route.fulfill({
    json: [
      {
        id: 4,
        name: 'Google Photos takeout',
        mount_path: '/app/backend/data/media-import-staging/test',
        source_kind: 'online',
        import_mode: 'google-photos',
        remote_name: 'gdrive',
        remote_path: 'Takeout',
        available: true,
      },
      {
        id: 5,
        name: 'Camera staging',
        mount_path: '/storage/camera',
        source_kind: 'folder',
        import_mode: 'folder',
        available: true,
      },
    ],
  }));
  await page.route('**/api/media-import/runs?page=1', route => route.fulfill({
    json: {
      runs: Array.from({ length: 10 }, (_, index) => ({
        id: 5000 + index,
        config_id: 4,
        status: 'completed',
        drive_name: 'Older import',
      })),
      total: 11,
      page: 1,
      pages: 2,
    },
  }));
  await page.route('**/api/media-import/runs/active', route => {
    activeRunRequests++;
    return route.fulfill({
      json: [
        { id: 4246, config_id: 4, status: 'running', drive_name: 'Google Photos takeout' },
        { id: 4247, config_id: 5, status: 'running', drive_name: 'Camera staging' },
      ],
    });
  });
  await page.route(/\/api\/media-import\/runs\/(4246|4247)\/progress$/, async route => {
    const runId = Number(route.request().url().match(/runs\/(\d+)\/progress$/)[1]);
    progressRequests.set(runId, (progressRequests.get(runId) || 0) + 1);
    await new Promise(resolve => setTimeout(resolve, 150));
    await route.fulfill({
      json: runId === 4246
        ? {
            runId, driveId: 4, status: 'running', phase: 'importing',
            archivesTotal: 57, archivesCompleted: 18, assetsFound: 1059,
            scanned: 840, uploaded: 120, duplicates: 718, errors: 2,
            startedAt: Date.now() - 120_000,
          }
        : {
            runId, driveId: 5, status: 'running', assetsFound: 400,
            uploaded: 110, duplicates: 80, errors: 0, percent: 48,
            startedAt: Date.now() - 60_000,
          },
    });
  });

  await page.goto('/media-import');
  await expect(page.getByText('Starting job', { exact: true })).toHaveCount(2);
  await expect(page.getByText('Archive 19 of 57 · Importing', { exact: true })).toBeVisible({ timeout: 4_000 });
  await expect(page.getByText('Uploading', { exact: true })).toBeVisible({ timeout: 4_000 });

  const requestsBeforeReconnect = activeRunRequests;
  await page.evaluate(() => window.dispatchEvent(new Event('redman:reconnected')));
  await expect.poll(() => activeRunRequests).toBeGreaterThan(requestsBeforeReconnect);
  await page.waitForTimeout(100);
  await expect(page.getByText('Starting job', { exact: true })).toHaveCount(0);

  await page.goto('/status');
  await page.goto('/media-import');
  await expect(page.getByText('Starting job', { exact: true })).toHaveCount(2);
  await expect(page.getByText('Archive 19 of 57 · Importing', { exact: true })).toBeVisible({ timeout: 4_000 });
  await expect(page.getByText('Uploading', { exact: true })).toBeVisible({ timeout: 4_000 });
  expect(progressRequests.get(4246)).toBe(2);
  expect(progressRequests.get(4247)).toBe(2);
});
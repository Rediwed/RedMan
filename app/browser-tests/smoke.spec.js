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

test('media import can start a labelled dry run and cancel it', async ({ page }) => {
  let importRequest = null;
  let cancelled = false;
  let cancelRequest = null;
  await page.route('**/api/media-import/drives', route => route.fulfill({ json: [] }));
  await page.route('**/api/media-import/drives/known', route => route.fulfill({ json: [] }));
  await page.route('**/api/media-import/runs?page=1', route => route.fulfill({
    json: { runs: [], total: 0, page: 1, pages: 1 },
  }));
  await page.route('**/api/media-import/status', route => route.fulfill({
    json: { immichGoAvailable: true, ejectSupported: false },
  }));
  await page.route('**/api/media-import/sources', route => route.fulfill({
    json: [{
      id: 8,
      name: 'Camera staging',
      mount_path: '/app/backend/data/media-import-staging/test',
      source_kind: 'online',
      import_mode: 'google-photos',
      remote_name: 'gdrive',
      remote_path: 'Takeout',
      available: true,
    }],
  }));
  await page.route('**/api/media-import/runs/active', route => route.fulfill({ json: [] }));
  await page.route('**/api/media-import/drives/8/import', async route => {
    importRequest = route.request().postDataJSON();
    await route.fulfill({ json: { runId: 8801, status: 'running', dryRun: true } });
  });
  await page.route('**/api/media-import/runs/8801/progress', route => route.fulfill({
    json: cancelled
      ? { runId: 8801, driveId: 8, status: 'cancelled', dryRun: true }
      : {
          runId: 8801, driveId: 8, status: 'running', dryRun: true,
          assetsFound: 20, scanned: 8, uploaded: 6, duplicates: 2, errors: 0,
          percent: 40, startedAt: Date.now() - 5_000,
        },
  }));
  await page.route('**/api/media-import/runs/8801/cancel', async route => {
    cancelRequest = route.request().postDataJSON();
    cancelled = true;
    await route.fulfill({ json: { status: 'cancelled' } });
  });

  await page.goto('/media-import');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: 'Dry Run' }).click();
  await expect(page.getByRole('dialog', { name: 'Run import simulation' })).toBeVisible();
  await page.getByRole('button', { name: 'Start dry run' }).click();
  expect(importRequest).toEqual({ dry_run: true });
  await expect(page.getByText('Would upload', { exact: true })).toBeVisible({ timeout: 4_000 });
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog', { name: 'Stop media import?' })).toBeVisible();
  expect(cancelled).toBe(false);
  await expect(page.getByText('Temporary files created by a dry run are always removed after cancellation.')).toBeVisible();
  await page.getByRole('button', { name: 'Stop import' }).click();
  await expect.poll(() => cancelled).toBe(true);
  expect(cancelRequest).toEqual({ delete_partial: false });
  await expect(page.getByText('Import cancelled.', { exact: true })).toBeVisible();
});

test('online media import confirms cancellation and partial cleanup', async ({ page }) => {
  let cancelRequest = null;
  let cancelled = false;
  await page.route('**/api/media-import/drives', route => route.fulfill({ json: [] }));
  await page.route('**/api/media-import/drives/known', route => route.fulfill({ json: [] }));
  await page.route('**/api/media-import/runs?page=1', route => route.fulfill({
    json: { runs: [], total: 0, page: 1, pages: 1 },
  }));
  await page.route('**/api/media-import/status', route => route.fulfill({
    json: { immichGoAvailable: true, ejectSupported: false },
  }));
  await page.route('**/api/media-import/sources', route => route.fulfill({
    json: [{
      id: 9,
      name: 'Google Photos takeout',
      mount_path: '/app/backend/data/media-import-staging/test',
      source_kind: 'online',
      import_mode: 'google-photos',
      remote_name: 'gdrive',
      remote_path: 'Takeout',
      available: true,
    }],
  }));
  await page.route('**/api/media-import/runs/active', route => route.fulfill({
    json: cancelled ? [] : [{ id: 9901, config_id: 9, status: 'running', dry_run: 0 }],
  }));
  await page.route('**/api/media-import/runs/9901/progress', route => route.fulfill({
    json: cancelled
      ? { runId: 9901, driveId: 9, status: 'cancelled' }
      : {
          runId: 9901, driveId: 9, status: 'running', phase: 'downloading',
          archivesTotal: 57, archivesCompleted: 37, archivePercent: 42,
          scanned: 0, uploaded: 0, duplicates: 0, errors: 0,
          startedAt: Date.now() - 60_000,
        },
  }));
  await page.route('**/api/media-import/runs/9901/cancel', async route => {
    cancelRequest = route.request().postDataJSON();
    cancelled = true;
    await route.fulfill({ json: { status: 'cancelled', partial_removed: true } });
  });

  await page.goto('/media-import');
  await expect(page.getByText('Archive 38 of 57 · Downloading', { exact: true })).toBeVisible({ timeout: 4_000 });
  await page.getByRole('button', { name: 'Cancel' }).click();
  const dialog = page.getByRole('dialog', { name: 'Stop media import?' });
  await expect(dialog).toBeVisible();
  const removePartial = dialog.getByRole('checkbox', { name: 'Remove the partial download from local staging' });
  await expect(removePartial).toBeChecked();
  expect(cancelRequest).toBeNull();
  await dialog.getByRole('button', { name: 'Keep running' }).click();
  expect(cancelRequest).toBeNull();

  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('dialog', { name: 'Stop media import?' }).getByRole('button', { name: 'Stop import' }).click();
  await expect.poll(() => cancelRequest).toEqual({ delete_partial: true });
  await expect(page.getByText('Import cancelled. The partial download was removed.', { exact: true })).toBeVisible();
});
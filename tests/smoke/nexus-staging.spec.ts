import { test, expect } from '@playwright/test';

const baseURL = process.env.STAGING_URL || 'http://127.0.0.1:8080';

test.describe('NEXUS Phase 3 staging smoke tests', () => {
  test('staging application is reachable', async ({ page }) => {
    const response = await page.goto(baseURL, {
      waitUntil: 'domcontentloaded',
    });

    expect(response).not.toBeNull();
    expect(response!.status()).toBe(200);
    await expect(page.locator('#root')).toBeVisible();
  });

  test('health endpoint is reachable', async ({ request }) => {
    const response = await request.get(`${baseURL}/health`);

    expect(response.status()).toBe(200);
    expect(await response.text()).toContain('nexus staging ok');
  });

  test('application loads its JavaScript bundle', async ({ page }) => {
    await page.goto(baseURL, {
      waitUntil: 'networkidle',
    });

    await expect(page.locator('#root')).toBeVisible();
    expect(await page.title()).toContain('NEXUS');
  });
});

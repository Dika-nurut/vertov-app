/**
 * W4.Thu — PWA manifest Playwright tests.
 * Tests:
 *  1. Root page has <link rel="manifest" href="/manifest.webmanifest" />.
 *  2. GET /manifest.webmanifest returns valid JSON with name="Vertov".
 */
import { test, expect } from '@playwright/test';

test.describe('PWA manifest', () => {
  test('root page includes link[rel=manifest]', async ({ page }) => {
    await page.goto('/');
    const manifest = page.locator('link[rel="manifest"]');
    await expect(manifest).toHaveCount(1);
    const href = await manifest.getAttribute('href');
    expect(href).toBe('/manifest.webmanifest');
  });

  test('GET /manifest.webmanifest returns valid JSON with name="Vertov"', async ({ request }) => {
    const res = await request.get('/manifest.webmanifest');
    expect(res.ok(), 'manifest should return 200').toBe(true);
    const contentType = res.headers()['content-type'] ?? '';
    // Browsers accept both application/manifest+json and application/json
    expect(contentType).toMatch(/json/);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.name).toBe('Vertov');
    expect(json.display).toBe('standalone');
    expect(Array.isArray(json.icons)).toBe(true);
    const icons = json.icons as Array<{ src: string; sizes: string }>;
    expect(icons.some((i) => i.sizes === '192x192')).toBe(true);
    expect(icons.some((i) => i.sizes === '512x512')).toBe(true);
  });
});

import { test, expect } from './fixtures';

test('user can subscribe to Start tier via stub ЮKassa flow', async ({
  signedInPage,
  cookieHeader,
  apiUrl,
}) => {
  test.setTimeout(120_000);
  const page = signedInPage;

  await page.goto('/pricing');
  await expect(page.getByTestId('tiers-grid')).toBeVisible();
  const startCard = page.locator('[data-tier="start"]');
  await expect(startCard).toBeVisible();
  await startCard.getByTestId('plate-cta').click();

  await page.waitForURL(/\/billing\/return\?/, { timeout: 30_000 });
  await expect(page.getByTestId('return-message')).toContainText(/Токены зачислены: \+1\s?175/, {
    timeout: 30_000,
  });

  // Direct API: subscription row must be active with snapshot fields populated.
  const subRes = await page.request.get(`${apiUrl}/v1/billing/subscription`, {
    headers: { cookie: cookieHeader },
  });
  expect(subRes.ok()).toBe(true);
  const sub = (await subRes.json()) as {
    tier: string;
    status: string;
    cancelAtPeriodEnd: boolean;
    autoRenew: boolean;
    creditsPerCycle: number;
    cycleNumber: number;
  };
  expect(sub.tier).toBe('start');
  expect(sub.status).toBe('active');
  expect(sub.cancelAtPeriodEnd).toBe(true); // anti-pattern wedge default
  expect(sub.autoRenew).toBe(false);
  expect(sub.creditsPerCycle).toBe(1175);
  expect(sub.cycleNumber).toBe(1);

  // Metrics scrape: subscription_grant counter must reflect at least 1 200.
  const metricsRes = await page.request.get('http://127.0.0.1:4001/metrics');
  expect(metricsRes.ok()).toBe(true);
  const metrics = await metricsRes.text();
  const grantLine = metrics
    .split('\n')
    .find((l) => l.startsWith('seed_credits_grant_total{account="subscription_grant"}'));
  expect(grantLine, 'subscription_grant counter present').toBeDefined();
  const value = Number(grantLine!.split(/\s+/).pop());
  expect(value).toBeGreaterThanOrEqual(1175);
});

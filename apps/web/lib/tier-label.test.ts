import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TIER_LABEL, tierLabel } from './tier-label';

describe('tier labels', () => {
  it('keeps the established Free label for a user with no live subscription', () => {
    expect(TIER_LABEL.free).toBe('Free');
    expect(tierLabel('free')).toBe('Free');
  });

  it('names a live Плюс plan correctly', () => {
    expect(TIER_LABEL.plus).toBe('Плюс');
    expect(tierLabel('plus')).toBe('Плюс');
    expect(tierLabel('plus', 'Плюс из каталога')).toBe('Плюс из каталога');
  });

  it('uses the endpoint title in billing and the live plan tier in settings', () => {
    const app = join(__dirname, '../app');
    const billing = readFileSync(join(app, 'settings/billing/BillingClient.tsx'), 'utf8');
    const settings = readFileSync(join(app, 'settings/SettingsClient.tsx'), 'utf8');
    const page = readFileSync(join(app, 'settings/page.tsx'), 'utf8');

    expect(billing).toContain('{tierLabel(subscription.tier, subscription.title)}');
    expect(settings).toContain('{TIER_LABEL[initial.tier]}');
    expect(page).toContain("apiGet<SubscriptionResponse | null>('/v1/billing/subscription')");
    expect(page).toContain('const liveTier =');
    expect(page).toContain('tier: liveTier');
  });
});

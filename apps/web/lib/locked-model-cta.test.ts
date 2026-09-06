import { describe, it, expect } from 'vitest';
import { lockedModelCtaHref } from './locked-model-cta';

/**
 * W0 / D6 — where the locked-model upsell sends a customer.
 *
 * With models correctly gated on the LIVE subscription, an elapsed subscriber
 * suddenly sees every paid model locked. Sending them to /pricing would expose
 * a stale upgrade CTA from the manageable row; the API now refuses an upgrade
 * against an already-expired period and asks the customer to recover billing
 * state first.
 *
 * /settings/billing is the destination where that recovery path lives:
 * cancelling an elapsed subscription closes it immediately, after which the
 * customer can subscribe again. No billing behaviour changes here — only where
 * the link points.
 */
describe('lockedModelCtaHref', () => {
  it('sends an elapsed subscriber to billing, where a way out exists', () => {
    expect(lockedModelCtaHref({ hasLivePlan: false, hasManageableSubscription: true })).toBe(
      '/settings/billing',
    );
  });

  it('sends someone who never subscribed to pricing, as today', () => {
    expect(lockedModelCtaHref({ hasLivePlan: false, hasManageableSubscription: false })).toBe(
      '/pricing',
    );
  });

  it('sends a live subscriber looking at a higher-tier model to pricing, as today', () => {
    // They have a working plan and a working upgrade path — nothing to route around.
    expect(lockedModelCtaHref({ hasLivePlan: true, hasManageableSubscription: true })).toBe(
      '/pricing',
    );
  });
});

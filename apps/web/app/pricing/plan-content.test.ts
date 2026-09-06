import { describe, expect, it } from 'vitest';
import { PRICE_POINT_SEED } from '@seed/db/seed/price-points';
import { seedSubscriptionTiers } from '@seed/db/seed/subscription-catalog';
import { COST_PHOTO, COST_VIDEO, PLAN_CONTENT, PLAN_FIT_CLAIMS } from './plan-content';

function rowsFor(claim: { modelId: string; resolution: string }) {
  return PRICE_POINT_SEED.filter(
    (row) =>
      row.isActive &&
      !row.videoInput &&
      row.modelId === claim.modelId &&
      row.resolution === claim.resolution,
  );
}

function activePrice(claim: {
  modelId: string;
  resolution: string;
  audio?: boolean;
  mode?: string;
  refsMin?: number;
}) {
  const rows = rowsFor(claim);
  // A rung with more than one price needs the claim to say WHICH configuration it
  // publishes — audio state, mode, reference band. Matching on model and rung alone
  // would bind whichever row came first, and the page would advertise one number
  // while the button charged the other.
  const narrowed = rows.filter(
    (row) =>
      (claim.audio === undefined || row.audio === claim.audio) &&
      (claim.mode === undefined || row.mode === claim.mode) &&
      (claim.refsMin === undefined || row.refsMin === claim.refsMin),
  );
  return narrowed.length === 1 ? narrowed[0] : undefined;
}

describe('/pricing published price binding', () => {
  it('binds every published table value to the active v14 row it claims to describe', () => {
    for (const row of [...COST_VIDEO, ...COST_PHOTO]) {
      for (const claim of row.claims) {
        const active = activePrice(claim);
        expect(
          rowsFor(claim).length === 1 ||
            claim.audio !== undefined ||
            claim.mode !== undefined ||
            claim.refsMin !== undefined,
          `${claim.modelId}/${claim.resolution} prices more than one configuration — the claim must name which`,
        ).toBe(true);
        expect(active, `${row.model}: ${claim.modelId}/${claim.resolution}`).toBeDefined();
        expect(claim.credits, `${row.model}: ${claim.modelId}/${claim.resolution}`).toBe(
          active!.baseCredits,
        );
        if (claim.durationSeconds !== undefined) {
          // A flat-rate row charges once for the whole clip, so its `baseUnits` is 1 and
          // says nothing about what the customer receives. The published duration is the
          // clip they get — binding it to the billing base would make the page advertise
          // "1 с" for a Veo clip that is eight seconds long. Only a scaling row's base
          // duration is a price fact worth pinning.
          if (!active!.flatRate) {
            expect(claim.durationSeconds, `${row.model}: duration`).toBe(active!.baseUnits);
          }
          expect(row.cfg).toContain(`${claim.durationSeconds} с`);
        }
      }
    }
  });

  it('derives every plate promise from its subscribed credit volume and active row', () => {
    for (const [tier, fits] of Object.entries(PLAN_FIT_CLAIMS)) {
      const subscription = seedSubscriptionTiers.find((candidate) => candidate.tier === tier);
      expect(subscription, tier).toBeDefined();
      const displayed = PLAN_CONTENT[tier]!.fits;
      expect(displayed).toHaveLength(fits.length);
      for (const [index, fit] of fits.entries()) {
        const active = activePrice(fit.claim);
        expect(active, `${tier}: ${fit.label}`).toBeDefined();
        expect(fit.claim.credits, `${tier}: ${fit.label}`).toBe(active!.baseCredits);
        expect(fit.creditsPerCycle, `${tier}: ${fit.label}`).toBe(subscription!.creditsPerCycle);
        expect(Number(displayed[index]!.count.replace(/\D/g, ''))).toBe(
          Math.floor(subscription!.creditsPerCycle / active!.baseCredits),
        );
      }
    }
  });
});

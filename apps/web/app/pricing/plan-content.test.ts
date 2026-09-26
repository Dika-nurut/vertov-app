import { describe, expect, it } from 'vitest';
import { PRICE_POINT_SEED } from '@seed/db/seed/price-points';
import { seedSubscriptionTiers } from '@seed/db/seed/subscription-catalog';
import { seedCreditPacks } from '@seed/db/seed/credit-packs';
import { seedModels } from '@seed/db/seed/models';
import {
  SOLD_SUBSCRIPTION_TIERS,
  cheapestSoldTierFor,
  subscriptionTierAllows,
} from '@seed/shared/subscription-tiers';
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

  it('only promises a plan models that plan can actually run', () => {
    // 2026-09-25: the Старт plate sold «фото Seedream 5.0 Lite», a Плюс-only model.
    for (const [tier, fits] of Object.entries(PLAN_FIT_CLAIMS)) {
      for (const fit of fits) {
        const model = seedModels.find((m) => m.id === fit.claim.modelId);
        expect(model, fit.claim.modelId).toBeDefined();
        expect(
          subscriptionTierAllows(tier, model!.tierMin),
          `${tier} plate promises ${fit.label}, which needs ${model!.tierMin}`,
        ).toBe(true);
      }
    }
  });

  it('sells packs with counts of models the cheapest plan runs, at the active price', () => {
    // Packs need a live plan (K-3), so the cheapest plan must run what they name.
    const veoLite = activePrice({ modelId: 'veo-3-1-lite', resolution: '720p' })!;
    const nanoBanana2 = activePrice({ modelId: 'gemini-3-1-flash-image', resolution: '1K' })!;
    for (const id of ['veo-3-1-lite', 'gemini-3-1-flash-image']) {
      const model = seedModels.find((m) => m.id === id)!;
      expect(subscriptionTierAllows(SOLD_SUBSCRIPTION_TIERS[0], model.tierMin), id).toBe(true);
    }
    for (const pack of seedCreditPacks.filter((p) => p.isActive)) {
      const videos = Math.floor(pack.credits / veoLite.baseCredits);
      const photos = Math.floor(pack.credits / nanoBanana2.baseCredits).toLocaleString('ru-RU');
      expect(pack.description, pack.id).toBe(
        `≈${videos} видео Veo Lite или ${photos.replace(/\s/g, ' ')} фото Nano Banana 2.`,
      );
    }
  });

  it('keeps the sold-plan list in step with the active catalogue', () => {
    const active = seedSubscriptionTiers.filter((t) => t.isActive).map((t) => t.tier);
    expect([...SOLD_SUBSCRIPTION_TIERS].sort()).toEqual([...active].sort());
    // A model still carrying the retired «Креатор» must upsell a plan on sale.
    expect(cheapestSoldTierFor('creator')).toBe('plus');
    expect(cheapestSoldTierFor('free')).toBe('start');
    expect(cheapestSoldTierFor('bogus')).toBeUndefined();
  });

  it('gates Seedance exactly as the approved plates say', () => {
    // Approved /pricing (owner 2026-09-25): «Seedance — Fast» on Старт/Плюс, «Seedance —
    // все модели» from Про. The gate used to open full Seedance 2.0 at Плюс.
    const seedance = seedModels.filter((m) => m.isActive && m.family === 'seedance');
    for (const [tier, content] of Object.entries(PLAN_CONTENT)) {
      const all = content.checks.includes('Seedance — все модели');
      for (const model of seedance) {
        // Fast and the free-tier Mini are open to every plan; «все модели» adds the rest.
        const fast = /fast|mini/.test(String(model.id));
        const runnable = subscriptionTierAllows(tier, model.tierMin);
        if (all || fast) expect(runnable, `${tier} should run ${model.id}`).toBe(true);
        else expect(runnable, `${tier} must not run ${model.id}`).toBe(false);
      }
    }
  });
});

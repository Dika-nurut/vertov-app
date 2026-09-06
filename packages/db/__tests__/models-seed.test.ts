import { describe, expect, it } from 'vitest';
import { seedModels } from '../seed/models';
import { PRICE_POINT_SEED } from '../seed/price-points';

/**
 * Pure catalog checks (no DB): the previz reference-to-video rows exist and
 * carry the provider id suffix BOTH gateway adapters key their mode off
 * (`/-reference-to-video$/`). See research/archive/previz-loop-goal.md S0/S1.
 */
describe('models seed — reference-to-video catalog rows', () => {
  const std = seedModels.find((m) => m.id === 'seedance-2-0-reference-to-video');
  const fast = seedModels.find((m) => m.id === 'seedance-2-0-fast-reference-to-video');

  it('std + fast rows exist, active, video kind', () => {
    for (const row of [std, fast]) {
      expect(row).toBeDefined();
      expect(row!.kind).toBe('video');
      expect(row!.isActive).toBe(true);
      expect(row!.maxDurationSeconds).toBe(15);
    }
  });

  it('provider model ids end with -reference-to-video (adapter mode key)', () => {
    expect(std!.providerModelId).toBe('seedance-2.0-reference-to-video');
    expect(fast!.providerModelId).toBe('seedance-2.0-fast-reference-to-video');
  });

  it('prices the r2v twins from active workbook rows, not any legacy field', () => {
    // Brief D removes forceFlat. Image-only reference jobs use their active
    // mirrors; with-video requests refuse until trusted input duration exists.
    // The legacy ceiling column is GONE (P-11b): the only sell price for these
    // twins is their active rung set in seed/price-points.ts (rev. 16 took the
    // signed 4K r2v price 2910 -> 2108), asserted via the pricing seed itself.
    const stdRungs = PRICE_POINT_SEED.filter((p) => p.modelId === std!.id && p.isActive);
    const fastRungs = PRICE_POINT_SEED.filter((p) => p.modelId === fast!.id && p.isActive);
    expect(stdRungs.length).toBeGreaterThan(0);
    expect(fastRungs.length).toBeGreaterThan(0);
  });

  it('declares the conservative 6000px reference ceiling for both serving legs', () => {
    expect((std!.capabilities as Record<string, unknown>).referenceMaxDimension).toBe(6000);
    expect((fast!.capabilities as Record<string, unknown>).referenceMaxDimension).toBe(6000);
  });
});

describe('models seed — platform config audit', () => {
  const byId = (id: string) => seedModels.find((model) => model.id === id);

  it('keeps dropped Sora inactive', () => {
    expect(byId('sora-2-pro')?.isActive).toBe(false);
  });

  it('declares only the kie-verified Gemini Omni aspect ratios', () => {
    expect(byId('gemini-omni-flash')?.capabilities?.aspect_ratios).toEqual(['16:9', '9:16']);
  });

  it('declares Gemini Omni images as generic references, not positional frames', () => {
    const capabilities = byId('gemini-omni-flash')?.capabilities;
    expect(capabilities?.reference).toBe(true);
    expect(capabilities?.frames).toBeUndefined();
    expect(capabilities?.maxRefs).toBeUndefined();
    expect(capabilities?.maxVideoRefs).toBe(0);
    expect(capabilities?.maxAudioRefs).toBe(0);
  });

  it('keeps Seedream 5 rows active at workbook prices', () => {
    // The sell price is the parametric rung: Pro 1K=16 / 2K=31 («Сетка
    // FX!AA40/AA41»), Lite 12 / 14 / 17 across 2K/3K/4K («Сетка FX!AA42/AA51/AA52»).
    // The legacy ceiling column is gone (P-11b) — the rungs below ARE the price.
    expect(byId('seedream-5-0-pro')).toMatchObject({ isActive: true });
    expect(byId('seedream-5-0-lite')).toMatchObject({ isActive: true });
    const proRates = PRICE_POINT_SEED.filter(
      (p) => p.modelId === 'seedream-5-0-pro' && p.isActive,
    ).map((p) => Math.ceil(p.baseCredits / p.baseUnits));
    const liteRates = PRICE_POINT_SEED.filter(
      (p) => p.modelId === 'seedream-5-0-lite' && p.isActive,
    ).map((p) => Math.ceil(p.baseCredits / p.baseUnits));
    expect(proRates).toContain(16);
    expect(proRates).toContain(31);
    expect(liteRates).toContain(12);
    expect(liteRates).toContain(17);
  });
});

/**
 * Veo must never fall over to OpenRouter.
 *
 * Finance flagged it as the single most loss-making leg in the catalogue and asked
 * for it to be blocked in code: at the OpenRouter rate ($0.40/s) an 8-second Veo
 * Quality clip costs 339.8 ₽ against 597 credits of revenue — **−72%**. Clearing
 * 25% there would need 1 369 credits.
 *
 * It is already blocked, by two independent facts: `gatewayOverride: 'kie'` beats
 * the slash-id⇒OpenRouter inference, and the ABSENCE of `fallbackGateway` means a
 * kie outage fails the job rather than buying it from the dear vendor (owner
 * directive, 2026-07-19). Both are one edit away from being untrue, and neither
 * would fail any other test, so this pins them.
 *
 * The same shape is what makes wan i2v and flux ≥2 refs lose money: there the
 * adapter's refusal IS the failover, and the request lands on OpenRouter at a
 * price quoted for kie. Veo differs only in having no fallback to land on.
 */
describe('veo never routes to OpenRouter', () => {
  const veo = seedModels.filter((m) => m.id.startsWith('veo-'));

  it('covers every seeded veo row', () => {
    expect(veo.map((m) => m.id).sort()).toEqual(['veo-3-1', 'veo-3-1-fast', 'veo-3-1-lite']);
  });

  it.each(['veo-3-1', 'veo-3-1-fast', 'veo-3-1-lite'])(
    '%s is kie-pinned with no fallback',
    (id) => {
      const model = veo.find((m) => m.id === id)!;
      expect(model.gatewayOverride).toBe('kie');
      // Not `toBeFalsy()`: an explicit 'openrouter' would be the defect, and so would
      // any other gateway whose rate the price was not computed against.
      expect(model.fallbackGateway ?? null).toBeNull();
    },
  );
});

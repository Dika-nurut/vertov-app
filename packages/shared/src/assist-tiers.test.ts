import { describe, expect, it } from 'vitest';
import { seedSubscriptionTiers } from '@seed/db/seed/subscription-catalog';
import {
  ASSIST_PRICING,
  ASSIST_TIERS,
  ASSIST_TOKEN_BUDGET,
  MODEL_PRICES_USD_PER_MTOK,
  STRUCTURIZE_CREDITS,
  STRUCTURIZE_MAX_ATTEMPTS,
  STRUCTURIZE_MODEL,
  assistCreditsFor,
  assistMarginAtFloor,
  assistPrice,
  assistTier,
  modelPrice,
  structurizeCostUsd,
} from './assist-tiers';
import { LLM_PRICING_WORKBOOK, llmPricingRecord } from './llm-pricing-workbook';

/**
 * Margin guardrail for assist calls — same doctrine as
 * packages/db/__tests__/model-margin-guardrail.test.ts: recompute the margin
 * from the model $-price at the worst-case credit revenue rate; a money-losing
 * tier can never ship.
 *
 * Prices are workbook-derived from model rates, token ceilings, route attempts,
 * conspect COGS and signed landed FX. This suite independently recomputes the
 * full route margin for every tier/scope and pins it to the live credit floor.
 */
const { creditFloorRub, marginFloor, landedRubPerUsd } = ASSIST_PRICING;

const catalogFloorRub = Math.min(
  ...seedSubscriptionTiers.map((t) => t.priceRub / t.creditsPerCycle),
);

describe('assist tier margin guardrail (all steps at the credit floor)', () => {
  it('takes financial knobs and scope budgets from the workbook export', () => {
    expect(ASSIST_PRICING).toEqual({
      creditFloorRub: LLM_PRICING_WORKBOOK.financial.creditFloorRub,
      marginFloor: LLM_PRICING_WORKBOOK.financial.scenarioMarginFloor,
      landedRubPerUsd: LLM_PRICING_WORKBOOK.financial.landedRubPerUsdOpenRouter,
    });
    for (const scope of ['project', 'span', 'scene', 'script'] as const) {
      expect(ASSIST_TOKEN_BUDGET[scope]).toEqual(
        llmPricingRecord('scenario_assist_price', `economy/${scope}`).maxTokenBudget,
      );
    }
  });

  it('the calculator floor still matches the live subscription catalog', () => {
    expect(creditFloorRub).toBeCloseTo(catalogFloorRub, 3);
  });

  for (const tier of ASSIST_TIERS) {
    for (const scope of ['project', 'span', 'scene', 'script'] as const) {
      // The workbook formula is authoritative, including attempts and conspect.
      it(`${tier.id} · ${scope} price is the workbook-derived value`, () => {
        expect(tier.creditsPerCall[scope]).toBe(
          llmPricingRecord('scenario_assist_price', `${tier.id}/${scope}`).credits,
        );
      });
      for (const hasMaterials of [false, true]) {
        const label = `${tier.id} (${tier.model}) · ${scope}${hasMaterials ? ' +materials' : ''}`;
        it(`${label} ≥ ${marginFloor * 100}%`, () => {
          const margin = assistMarginAtFloor(
            tier,
            scope,
            creditFloorRub,
            landedRubPerUsd,
            hasMaterials,
          );
          expect(
            margin,
            `${label}: ${assistPrice(tier, scope, hasMaterials)} cr does not cover ` +
              `${tier.model} at worst-case budget ${JSON.stringify(ASSIST_TOKEN_BUDGET[scope])}`,
          ).toBeGreaterThanOrEqual(marginFloor);
        });
      }
    }
  }
});

describe('structurization price (goal S1: cheap by construction, fail-closed)', () => {
  it('is DERIVED from the economy model cost × the retry budget, never hand-typed', () => {
    expect(STRUCTURIZE_CREDITS).toBe(
      llmPricingRecord('scenario_structurize_active', 'economy/active').credits,
    );
    expect(STRUCTURIZE_CREDITS).toBe(
      Math.ceil(
        (STRUCTURIZE_MAX_ATTEMPTS *
          structurizeCostUsd() *
          LLM_PRICING_WORKBOOK.financial.landedRubPerUsdOpenRouter) /
          (LLM_PRICING_WORKBOOK.financial.creditFloorRub *
            (1 - LLM_PRICING_WORKBOOK.financial.scenarioBandMarginFloor)),
      ),
    );
  });

  it('always prices against the economy model (deepseek), whatever the user tier', () => {
    expect(STRUCTURIZE_MODEL).toBe('deepseek/deepseek-v4-flash');
    // Fail-closed: the model must be registered in the catalog or the module throws.
    expect(modelPrice(STRUCTURIZE_MODEL)).toBeTruthy();
  });

  it('clears the active 25% margin floor at the WORST case: a committed result after every retry', () => {
    // A schema-fail retry then a success bills the flat price but costs
    // STRUCTURIZE_MAX_ATTEMPTS full gateway calls — the price must cover them.
    const costRub = STRUCTURIZE_MAX_ATTEMPTS * structurizeCostUsd() * landedRubPerUsd;
    const revenueRub = STRUCTURIZE_CREDITS * creditFloorRub;
    const margin = 1 - costRub / revenueRub;
    expect(
      margin,
      `structurize: ${STRUCTURIZE_CREDITS} cr does not cover ${STRUCTURIZE_MAX_ATTEMPTS}× ${STRUCTURIZE_MODEL}`,
    ).toBeGreaterThanOrEqual(LLM_PRICING_WORKBOOK.financial.scenarioBandMarginFloor);
  });

  it('stays cheap: a few credits from the welcome balance (decision #4)', () => {
    expect(STRUCTURIZE_CREDITS).toBeLessThanOrEqual(5);
    expect(STRUCTURIZE_CREDITS).toBeGreaterThan(0);
  });
});

describe('assist tier catalog invariants', () => {
  it('exposes exactly the three RU tiers the UI promises', () => {
    expect(ASSIST_TIERS.map((t) => [t.id, t.labelRu])).toEqual([
      ['economy', 'Экономный'],
      ['standard', 'Стандарт'],
      ['max', 'Максимум'],
    ]);
  });

  it('whole-script calls always cost more than span calls', () => {
    for (const t of ASSIST_TIERS) {
      expect(t.creditsPerCall.script).toBeGreaterThan(t.creditsPerCall.span);
      expect(t.creditsPerCall.script).toBeGreaterThan(t.creditsPerCall.project);
      expect(t.creditsPerCall.scene).toBeGreaterThanOrEqual(t.creditsPerCall.project);
    }
  });

  it('credit prices are ascending across tiers', () => {
    const [e, s, m] = ASSIST_TIERS;
    expect(e!.creditsPerCall.span).toBeLessThan(s!.creditsPerCall.span);
    expect(s!.creditsPerCall.span).toBeLessThan(m!.creditsPerCall.span);
  });

  it('assistTier() resolves ids and rejects junk', () => {
    expect(assistTier('standard')?.model).toBeTruthy();
    expect(assistTier('free-lunch')).toBeUndefined();
  });
});

describe('model-price catalog is fail-closed (swapping a model can never silently lose money)', () => {
  it('every tier is priced against a REGISTERED model cost', () => {
    for (const t of ASSIST_TIERS) {
      expect(
        MODEL_PRICES_USD_PER_MTOK[t.model],
        `${t.id} model "${t.model}" is not registered`,
      ).toBe(t.priceUsdPerMTok);
    }
  });

  it('an unregistered model is a HARD error, not a guessed price', () => {
    expect(() => modelPrice('claude-fable-5')).toThrow(/no registered token price/);
    // → putting Fable 5 on «Максимум» without registering its price refuses to
    //   start, instead of pricing it against Sonnet's (possibly cheaper) cost.
  });

  it('a dearer model registered on a tier RAISES its credit price automatically', () => {
    const sonnet = modelPrice('anthropic/claude-sonnet-5');
    const dearer = { input: sonnet.input * 2, output: sonnet.output * 2 };
    // Same formula, dearer cost in → more credits out, margin preserved.
    expect(assistCreditsFor(dearer, 'span')).toBeGreaterThan(assistCreditsFor(sonnet, 'span'));
    expect(assistCreditsFor(dearer, 'script')).toBeGreaterThan(assistCreditsFor(sonnet, 'script'));
  });
});

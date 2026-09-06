import { describe, expect, it } from 'vitest';
import { costLegFile, realGateway } from '@seed/db';
import { seedModels } from '../../db/seed/models';
import {
  SINGLE_LEG_CONFIGURATIONS,
  isSingleLegConfiguration,
  singleLegGateway,
} from './relay-gateway';

/** Finance keys Seedance reference-to-video legs on the base model id; the picker and
 * runtime use the suffixed id. Keep the sourceRef tied to that export id instead of
 * silently renaming finance's row. The fast reference-to-video export is a two-leg
 * ladder, so it has no single-leg table entry to map. */
const FINANCE_MODEL_ID_FOR_RUNTIME_MODEL: Readonly<Record<string, string>> = {
  'seedance-2-0-reference-to-video': 'seedance-2-0',
};

const financeModelIdForRuntime = (modelId: string): string =>
  FINANCE_MODEL_ID_FOR_RUNTIME_MODEL[modelId] ?? modelId;

const runtimePrimaryLeaf = (model: (typeof seedModels)[number]): string => {
  const gateway = realGateway(model as never);
  if (gateway === 'nanobanana') return 'laozhang';
  if (gateway === 'geminiomni') return 'kie';
  return gateway;
};

/**
 * `SINGLE_LEG_CONFIGURATIONS` is runtime policy copied from finance's signed export.
 * Checking only the table would let a second leg appear in finance while the runtime
 * kept suppressing it, or let finance remove the reserve-less ruling while the guard
 * still failed jobs closed. Every exported quality or video row is checked.
 */
describe('single-leg configurations quote the signed export', () => {
  it('contains exactly the signed depth and source reference for each configuration', () => {
    // Rev. 22 signs Gemini 2.5 Flash Image and GPT Image 2 fallback rows. Along with
    // the earlier Wan reserves, those models are no longer reserve-less; eight genuine
    // depth-1 configurations remain in the runtime registry.
    expect(SINGLE_LEG_CONFIGURATIONS).toHaveLength(8);

    for (const configuration of SINGLE_LEG_CONFIGURATIONS) {
      const exportedModelId = financeModelIdForRuntime(configuration.modelId);
      const exported = costLegFile.legs.filter(
        (leg) =>
          leg.modelId === exportedModelId &&
          leg.rung === configuration.rung &&
          leg.mode === configuration.mode,
      );
      const label = `${configuration.modelId}|${configuration.rung}|${configuration.mode}`;
      expect(exported, `${label}: no exported rows to quote`).not.toHaveLength(0);
      expect(
        new Set(exported.map((leg) => leg.ladderDepth)),
        `${label}: every quality row must remain depth 1`,
      ).toEqual(new Set([1]));
      expect(
        [...new Set(exported.map((leg) => leg.source))].join('/'),
        `${label}: sourceRef must quote the export rows`,
      ).toBe(configuration.sourceRef);
    }
  });

  it('binds each signed first relay to the export primary leg', () => {
    for (const configuration of SINGLE_LEG_CONFIGURATIONS) {
      const exportedModelId = financeModelIdForRuntime(configuration.modelId);
      const exported = costLegFile.legs.filter(
        (leg) =>
          leg.modelId === exportedModelId &&
          leg.rung === configuration.rung &&
          leg.mode === configuration.mode &&
          leg.leg === 1 &&
          leg.role === 'primary',
      );
      const label = `${configuration.modelId}|${configuration.rung}|${configuration.mode}`;
      expect(exported, `${label}: no exported primary leg to quote`).not.toHaveLength(0);
      expect(
        new Set(exported.map((leg) => leg.relay.toLowerCase())),
        `${label}: gateway must remain the signed primary relay`,
      ).toEqual(new Set([configuration.gateway]));
    }
  });

  /**
   * A model row carries ONE gateway; finance signs a relay PER RUNG. The two therefore
   * cannot always agree, and where they disagree the export is not automatically right —
   * on Seedance 4K it names Kie while the model row still routes to OpenRouter. So this
   * does not assert agreement and the runtime does not resolve the disagreement by
   * following the export; it pins the disagreements that exist, with what closes each.
   * A third appearing is a routing decision nobody made, and one silently vanishing means
   * someone rerouted a live model.
   */
  it('pins every divergence between the signed relay and the model row', () => {
    const divergences: string[] = [];
    for (const configuration of SINGLE_LEG_CONFIGURATIONS) {
      const model = seedModels.find((candidate) => candidate.id === configuration.modelId);
      const label = `${configuration.modelId}|${configuration.rung}|${configuration.mode}`;
      expect(model, `${label}: runtime model row is missing`).toBeTruthy();
      const runtimeGateway = runtimePrimaryLeaf(model!);
      if (runtimeGateway !== configuration.gateway) {
        divergences.push(`${label}: signed=${configuration.gateway}, runtime=${runtimeGateway}`);
      }
    }
    expect(divergences.sort()).toEqual(
      [
        // Finance signs kie as the sole 4K leg; the row routes 1080p — its only sold video
        // rung — to OpenRouter, which is correct THERE (0.3402 against kie's 0.51). Running
        // 4K on OpenRouter would lose 3.5% where kie earns 25.0%, so 4K stays unsellable:
        // both price rows are inactive, 4K is off the advertised menu, and
        // UNDELIVERABLE_ON_ROUTE refuses to activate it. Closes when 4K gets a rung-aware
        // route, not before.
        'seedance-2-0-reference-to-video|4K|r2v: signed=kie, runtime=openrouter',
        'seedance-2-0|4K|t2v: signed=kie, runtime=openrouter',
      ].sort(),
    );
  });

  it('fires the signed r2v policy for the runtime reference-to-video model id', () => {
    expect(isSingleLegConfiguration('seedance-2-0-reference-to-video', '4K', 'r2v')).toBe(true);
    expect(singleLegGateway('seedance-2-0-reference-to-video', '4K', 'r2v')).toBe('kie');
  });

  /**
   * The check above only reads table → export, so a configuration finance NEWLY marks
   * reserve-less would be absent from the table and nothing would say so — the runtime
   * would go on offering a second leg the export does not cost.
   *
   * The table is deliberately narrower than "every depth-1 row": seedream-5-0-lite,
   * seedream-5-0-pro and both recraft rows are reserve-less too, and need no entry because
   * nothing in our code would run a second leg for them — they are `forceGateway: 'kie'`
   * with no `fallbackGateway`. So the completeness rule is scoped to the models that CAN
   * fail over: a per-model `fallbackGateway`, or a chain alias as `forceGateway`. The
   * Seedance 4K t2v/r2v rows are included now that rev. 16 signs them at depth 1.
   */
  it('names every reserve-less image configuration on a model that could fail over', () => {
    const canFailOver = new Set(
      seedModels
        .filter((model) => {
          if (!model.isActive) return false;
          const forceGateway = (model.capabilities as Record<string, unknown> | null)?.[
            'forceGateway'
          ];
          return (
            Boolean(model.fallbackGateway) ||
            forceGateway === 'nanobanana' ||
            forceGateway === 'geminiomni'
          );
        })
        .map((model) => model.id),
    );

    const expected = costLegFile.legs
      .filter((leg) => leg.ladderDepth === 1 && canFailOver.has(leg.modelId))
      .map((leg) => `${leg.modelId}|${leg.rung}|${leg.mode}`);

    const accounted = SINGLE_LEG_CONFIGURATIONS.map(
      (c) => `${financeModelIdForRuntime(c.modelId)}|${c.rung}|${c.mode}`,
    );
    expect([...new Set(expected)].sort()).toEqual([...new Set(accounted)].sort());
  });

  /**
   * Each listed mode must be internally consistent across duplicate export rows. Wan is
   * deliberately mode-specific: after rev. 21 both Wan modes carry a two-leg ladder at
   * each rung, so neither mode may be treated as a reserve-less wildcard.
   */
  it('has one ladder depth for every listed mode', () => {
    for (const configuration of SINGLE_LEG_CONFIGURATIONS) {
      const exportedModelId = financeModelIdForRuntime(configuration.modelId);
      const everyMode = costLegFile.legs.filter(
        (leg) =>
          leg.modelId === exportedModelId &&
          leg.rung === configuration.rung &&
          leg.mode === configuration.mode,
      );
      expect(
        new Set(everyMode.map((leg) => leg.ladderDepth)),
        `${configuration.modelId}|${configuration.rung}|${configuration.mode}: rows disagree about ladder depth`,
      ).toEqual(new Set([1]));
    }

    for (const rung of ['720p', '1080p']) {
      const wanDepths = costLegFile.legs
        .filter((leg) => leg.modelId === 'wan-2-7' && leg.rung === rung)
        .map((leg) => leg.ladderDepth);
      // Rows 25–28 (t2v) and 93–96 (i2v) are all ladder depth 2 after rev. 21.
      expect(
        new Set(wanDepths),
        `wan-2-7|${rung}: t2v and i2v twins share the signed depth`,
      ).toEqual(new Set([2]));
    }
  });
});

/**
 * 'any' reaches the matcher from two directions that want opposite answers, and the Wan
 * rows are the shape that makes it matter: rev. 21 gives both 720p modes a signed reserve,
 * so getting the wildcard wrong could still strip a priced leg.
 */
describe('mode wildcards', () => {
  it('treats an undefined mode as "any mode of this rung"', () => {
    // GPT Image 2 now has signed depth-2 t2i/i2i rows for all quality tiers, so its
    // undefined-mode wildcard must not suppress the reserve.
    expect(isSingleLegConfiguration('gpt-image-2', 'default', undefined)).toBe(false);
    // Export rows 93–94 are depth 2, so an unknown Wan mode cannot suppress its reserve.
    expect(isSingleLegConfiguration('wan-2-7', '720p', undefined)).toBe(false);
  });

  it('does NOT accept the literal "any" as a wildcard', () => {
    // `priceModeForRequest` returns 'any' when a model's contract cannot be read. That is
    // the absence of knowledge, not permission to suppress: both Wan modes have signed
    // reserves at 720p after rev. 21.
    expect(isSingleLegConfiguration('wan-2-7', '720p', 'any')).toBe(false);
    expect(singleLegGateway('wan-2-7', '720p', 'any')).toBeNull();
  });

  it('does not suppress either wan mode at the same rung', () => {
    // Export rows 93–96 place both i2v rungs at depth 2, matching the t2v twins; neither
    // mode has a single-leg entry or a signed reserve-less gateway to return.
    expect(isSingleLegConfiguration('wan-2-7', '720p', 'i2v')).toBe(false);
    expect(isSingleLegConfiguration('wan-2-7', '720p', 't2v')).toBe(false);
    expect(singleLegGateway('wan-2-7', '720p', 'i2v')).toBeNull();
  });

  it('refuses to name a relay when the matched modes disagree', () => {
    // Guard the conflict rule itself on a fabricated pair.
    expect(singleLegGateway('gpt-image-2', 'default', undefined)).toBeNull();
  });
});

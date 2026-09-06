import { describe, expect, it } from 'vitest';
import { seedModels } from '@seed/db/seed/models';
import { resolveBoardModelContract, type BoardModelLike } from './board-contract';
import { byteplusRouteContracts } from './model-contract-byteplus';

/**
 * DoD 4 — no dead / false controls: advertised == accepted == sent. The product
 * contract the UI derives (resolveBoardModelContract) must not offer a control that
 * NO serving route actually accepts. The registry is the truth for what each route
 * accepts; here we pin `negativePrompt`, the classic dead advert (a `passthrough`
 * entry the adapters never serialize).
 */
describe('advertised == accepted (negativePrompt) for covered models', () => {
  const seedById = new Map(seedModels.map((row) => [row.id, row]));

  for (const [modelId, routes] of Object.entries(byteplusRouteContracts)) {
    it(`${modelId}: the UI advertises negativePrompt iff a route accepts it`, () => {
      const row = seedById.get(modelId)!;
      const advertised = resolveBoardModelContract(row as BoardModelLike)?.negativePrompt ?? false;
      // The registry product truth: negativePrompt is real iff SOME route accepts it.
      const accepted = routes.some((r) => r.negativePrompt);
      expect(advertised).toBe(accepted);
    });
  }
});

/**
 * The same DoD-4 idea on the reference COUNT, generalised from a defect that cost real
 * money to find (2026-08-09).
 *
 * A leg contract may sit BELOW the vendor's published ceiling — that is deliberate
 * headroom and it is safe, because we simply never ask for what we do not sell
 * (`nano-banana-2` serves 8 where kie's spec allows 14; `seedream-5-lite` 10 of 14).
 * What is NEVER safe is a leg advertising FEWER references than the catalogue SELLS:
 * a customer can then buy a configuration that leg cannot serve.
 *
 * That is not hypothetical. `flux-2-pro` sold a 2–8 reference band while its kie leg
 * declared `maxImages: 1`, because the adapter refused multi-reference requests on an
 * assumption never checked against the vendor spec. The consequences compounded in the
 * direction that costs money: the band looked unservable on the CHEAPER leg, finance's
 * reserve row was withdrawn, and a phantom 41.55% margin was nearly signed against a
 * leg the code would have refused. One number, three wrong conclusions downstream.
 *
 * Zero violations today. This pins that, so the next cap set below what we sell fails
 * here rather than in a margin report.
 */
describe('no leg advertises fewer references than the catalogue sells', () => {
  const contracted = seedModels
    .filter((row) => row.isActive && byteplusRouteContracts[row.id])
    .filter((row) => {
      const sold = (row.capabilities as { maxRefs?: unknown } | null | undefined)?.maxRefs;
      return typeof sold === 'number' && sold > 0;
    });

  it('covers a real population, so an empty sweep cannot pass as compliance', () => {
    expect(contracted.length).toBeGreaterThan(3);
  });

  it('every serving leg can carry the full reference count we sell', () => {
    const undersized: string[] = [];
    for (const row of contracted) {
      const sold = (row.capabilities as { maxRefs: number }).maxRefs;
      for (const route of byteplusRouteContracts[row.id]!) {
        const cap = route.reference?.maxImages ?? 0;
        if (cap < sold) {
          undersized.push(`${row.id} @${route.gateway} (${route.role}): sells ${sold}, leg ${cap}`);
        }
      }
    }
    expect(undersized).toEqual([]);
  });
});

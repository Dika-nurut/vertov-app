import { describe, expect, it } from 'vitest';
import { seedModels } from '@seed/db/seed/models';
import {
  deriveCatalogCapabilities,
  pickManagedCapabilities,
  type ModelGatewayContract,
} from './model-contract';
import { byteplusRouteContracts, catalogCapabilitiesForModel } from './model-contract-byteplus';
import { executableCostedGateways } from './route-engine-guards';

/**
 * Catalog ↔ registry PARITY GUARD (execution plan DoD 2). The registry is the
 * authority on what a vendor route accepts; the catalog is the product surface we
 * sell. They must match except for named routing/pricing restrictions. A hand-edit
 * that claims more than a vendor route accepts (or an undocumented narrowing)
 * fails CI here.
 */

const ROUTING_WITHHELD_REFERENCE_CAPABILITIES = {
  reason:
    'the OpenRouter primary serves frames; generic references stay on the separate reference row until capability-aware routing exists',
  modelIds: ['seedance-2-0', 'seedance-2-0-fast'],
  keys: ['reference', 'multi_image', 'maxRefs', 'maxVideoRefs', 'maxAudioRefs'],
} as const;

const UNVERIFIED_VIDEO_REFERENCE_CATALOG_NARROWING = {
  reason:
    'video references stay unavailable because the OpenRouter primary is unverified for that channel',
  modelIds: ['seedance-2-0-reference-to-video', 'seedance-2-0-fast-reference-to-video'],
  capability: 'maxVideoRefs',
  catalogMaximum: 0,
} as const;

/**
 * A reference cap that ONLY an availability fallback can fill stays out of the
 * catalogue. gemini-3-1-flash-image is the case: the laozhang primary of the
 * `nanobanana` chain is verified at 3 reference images, kie's `nano-banana-2`
 * reserve leg takes 8 — and finance prices NO multi-reference band for this model,
 * so advertising 8 would sell a count only the reserve leg can serve, at a price
 * that does not exist. Same rule as every other narrowing: less is allowed and must
 * be named, more is a lie and still fails.
 */
const FALLBACK_ONLY_REFERENCE_CATALOG_NARROWING = {
  reason:
    'only the kie reserve leg accepts more than the laozhang primary’s verified 3 references, and no multi-reference price band exists',
  modelIds: ['gemini-3-1-flash-image'],
  capability: 'maxRefs',
  catalogMaximum: 3,
} as const;

/** AtlasCloud's Omni image-to-video schema allows seven references, but rev. 12
 * prices only the zero-reference t2v band. Keep that fallback-only capability
 * out of the product catalogue until finance signs a reference band. */
const OMNI_FALLBACK_ONLY_REFERENCE_CATALOG_NARROWING = {
  reason:
    'AtlasCloud is the only leg that publishes a seven-image reference ceiling, and no multi-reference price band exists',
  modelIds: ['gemini-omni-flash'],
  keys: ['multi_image', 'maxRefs'],
} as const;

const NAMED_REFERENCE_NARROWINGS = [
  UNVERIFIED_VIDEO_REFERENCE_CATALOG_NARROWING,
  FALLBACK_ONLY_REFERENCE_CATALOG_NARROWING,
] as const;

/**
 * The catalogue may also offer FEWER resolutions than the vendor route accepts,
 * when the routed leg cannot actually serve one. Same rule as the reference caps:
 * less is allowed and must be named, more is a lie and fails.
 */
const UNSERVABLE_RESOLUTION_CATALOG_NARROWING = {
  reason:
    "kie's Seedream 4.5 exposes only quality basic(2K)/high(4K) — it has no 1K tier, so a 1K ask was served as 2K while billed as 1K",
  modelIds: ['seedream-4-5'],
  capability: 'resolutions',
  withdrawn: ['1K'],
} as const;

/**
 * Declaring NO resolution lever is a different claim from withdrawing an unservable
 * tier, so it gets its own name rather than being folded into the constant above.
 * `resolutions: []` in the catalog means «the customer has no choice; the provider
 * renders one fixed output», and that is the reading `priceSelectorFromParams` depends
 * on — an empty list pins the price key to the `default` band, which is the band
 * finance's export signs for this model. The ROUTE contract still carries a rung enum,
 * because the adapter has to put a value on the wire. The two are addressing different
 * audiences, not disagreeing: one says what we sell, the other says what we send.
 */
const NO_RESOLUTION_LEVER_CATALOG_NARROWING = {
  reason:
    'Gemini Omni sells exactly one output (owner ruling 2026-08-09: «у нас только 720»). Catalog declares no lever so the price key stays on the signed default band; the route enum pins 720p so the adapter cannot ask kie for a rung we do not sell.',
  modelIds: ['gemini-omni-flash'],
  capability: 'resolutions',
} as const;

function catalogDeclaresNoResolutionLever(modelId: string): boolean {
  return NO_RESOLUTION_LEVER_CATALOG_NARROWING.modelIds.includes(
    modelId as (typeof NO_RESOLUTION_LEVER_CATALOG_NARROWING.modelIds)[number],
  );
}

const REFERENCE_MAXIMUM_KEYS = ['maxRefs', 'maxVideoRefs', 'maxAudioRefs'] as const;

function catalogMayNarrowResolutions(modelId: string): boolean {
  return UNSERVABLE_RESOLUTION_CATALOG_NARROWING.modelIds.includes(
    modelId as (typeof UNSERVABLE_RESOLUTION_CATALOG_NARROWING.modelIds)[number],
  );
}

function catalogWithholdsReferenceCapability(modelId: string, key: string): boolean {
  return (
    (ROUTING_WITHHELD_REFERENCE_CAPABILITIES.modelIds.includes(
      modelId as (typeof ROUTING_WITHHELD_REFERENCE_CAPABILITIES.modelIds)[number],
    ) &&
      ROUTING_WITHHELD_REFERENCE_CAPABILITIES.keys.includes(
        key as (typeof ROUTING_WITHHELD_REFERENCE_CAPABILITIES.keys)[number],
      )) ||
    (OMNI_FALLBACK_ONLY_REFERENCE_CATALOG_NARROWING.modelIds.includes(
      modelId as (typeof OMNI_FALLBACK_ONLY_REFERENCE_CATALOG_NARROWING.modelIds)[number],
    ) &&
      OMNI_FALLBACK_ONLY_REFERENCE_CATALOG_NARROWING.keys.includes(
        key as (typeof OMNI_FALLBACK_ONLY_REFERENCE_CATALOG_NARROWING.keys)[number],
      ))
  );
}

function namedReferenceNarrowing(
  modelId: string,
  key: string,
): (typeof NAMED_REFERENCE_NARROWINGS)[number] | undefined {
  return NAMED_REFERENCE_NARROWINGS.find(
    (narrowing) =>
      narrowing.capability === key && (narrowing.modelIds as readonly string[]).includes(modelId),
  );
}

describe('registry ↔ catalog parity', () => {
  const seedById = new Map(seedModels.map((row) => [row.id, row]));

  for (const [modelId, routes] of Object.entries(byteplusRouteContracts)) {
    describe(modelId, () => {
      const row = seedById.get(modelId);

      it('has a matching seed row (byteplus)', () => {
        expect(row, `seed row for ${modelId}`).toBeDefined();
        expect(row!.provider).toBe('byteplus');
      });

      it('catalog capabilities equal the registry-derived bag, except named reference-cap narrowings', () => {
        const derived = deriveCatalogCapabilities(routes);
        const committed = pickManagedCapabilities(
          row!.capabilities as Record<string, unknown> | null,
        );
        const allKeys = new Set([...Object.keys(derived), ...Object.keys(committed)]);
        for (const key of allKeys) {
          const catalogValue = committed[key as keyof typeof committed];
          const registryValue = derived[key as keyof typeof derived];
          if (catalogWithholdsReferenceCapability(modelId, key)) {
            expect(catalogValue, `${modelId}.${key} is withheld by routing policy`).toBeUndefined();
            expect(
              registryValue,
              `${modelId}.${key} remains a factual route capability`,
            ).toBeDefined();
            continue;
          }
          if (REFERENCE_MAXIMUM_KEYS.includes(key as (typeof REFERENCE_MAXIMUM_KEYS)[number])) {
            if (catalogValue === registryValue) continue;
            const narrowing = namedReferenceNarrowing(modelId, key);
            expect(
              narrowing,
              `${modelId}.${key} may only differ via a named catalog narrowing`,
            ).toBeDefined();
            const rawCatalogValue = (row!.capabilities as Record<string, unknown> | null)?.[key];
            expect(rawCatalogValue, `${modelId}.${key} catalog maximum`).toBe(
              narrowing!.catalogMaximum,
            );
            expect(typeof registryValue, `${modelId}.${key} registry maximum`).toBe('number');
            expect(
              rawCatalogValue as number,
              `${modelId}.${key} must not exceed the vendor route`,
            ).toBeLessThan(registryValue as number);
            continue;
          }
          if (key === UNSERVABLE_RESOLUTION_CATALOG_NARROWING.capability) {
            if (JSON.stringify(catalogValue) === JSON.stringify(registryValue)) continue;
            if (catalogDeclaresNoResolutionLever(modelId)) {
              // Exactly empty, not merely shorter — a partial list here would be a real
              // ladder and would have to justify itself through the narrowing above.
              expect(catalogValue, `${modelId}.resolutions declares no customer lever`).toEqual([]);
              expect(
                (registryValue ?? []) as string[],
                `${modelId} route must still pin what the adapter sends`,
              ).not.toHaveLength(0);
              continue;
            }
            expect(
              catalogMayNarrowResolutions(modelId),
              `${modelId}.resolutions may only differ via a named catalog narrowing`,
            ).toBe(true);
            const offered = (catalogValue ?? []) as string[];
            const accepted = (registryValue ?? []) as string[];
            // Subset only: selling a resolution the route cannot serve is the
            // direction that lies to the user, and it still fails here.
            for (const value of offered) {
              expect(accepted, `${modelId}.resolutions must not exceed the vendor route`).toContain(
                value,
              );
            }
            expect(
              accepted.filter(
                (value) =>
                  !(
                    UNSERVABLE_RESOLUTION_CATALOG_NARROWING.withdrawn as readonly string[]
                  ).includes(value),
              ),
              `${modelId}.resolutions must withdraw exactly the named tiers`,
            ).toEqual(offered);
            continue;
          }
          expect(catalogValue, `${modelId}.${key}`).toEqual(registryValue);
        }
      });

      it('every route carries provenance', () => {
        for (const route of routes) {
          expect(route.provenance.source).toMatch(/^(verified|snapshot|inferred)$/);
          expect(route.provenance.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          expect(route.provenance.note.length).toBeGreaterThan(0);
        }
      });

      it('has exactly one primary route', () => {
        expect(routes.filter((r) => r.role === 'primary')).toHaveLength(1);
      });
    });
  }

  it('catalogCapabilitiesForModel returns undefined for an unowned model', () => {
    // sora-2-pro is inactive/dropped and not in the registry.
    expect(catalogCapabilitiesForModel('sora-2-pro')).toBeUndefined();
  });

  it('keeps the named routing and verification restrictions active', () => {
    for (const modelId of ROUTING_WITHHELD_REFERENCE_CAPABILITIES.modelIds) {
      const committed = pickManagedCapabilities(
        seedById.get(modelId)!.capabilities as Record<string, unknown>,
      );
      for (const key of ROUTING_WITHHELD_REFERENCE_CAPABILITIES.keys) {
        expect(committed[key as keyof typeof committed], `${modelId}.${key}`).toBeUndefined();
      }
    }
    for (const narrowing of NAMED_REFERENCE_NARROWINGS) {
      for (const modelId of narrowing.modelIds) {
        const raw = seedById.get(modelId)!.capabilities as Record<string, unknown>;
        expect(raw[narrowing.capability], `${modelId}: ${narrowing.reason}`).toBe(
          narrowing.catalogMaximum,
        );
      }
    }
  });
});

/**
 * Models whose contract registry entry has no leg that is both reachable and priced.
 * Each line is a model we advertise and cannot route to at a signed price; the list
 * is pinned so a new one fails CI rather than quietly widening.
 */
const MODELS_WITH_NO_COSTED_REACHABLE_LEG: readonly string[] = [];

describe('G5: advertised capabilities are executable-leg unions', () => {
  it('keeps every advertised capability inside the union of the real leg contracts', () => {
    const seedById = new Map(seedModels.map((row) => [row.id, row]));
    for (const [modelId, allRoutes] of Object.entries(byteplusRouteContracts)) {
      const row = seedById.get(modelId);
      expect(row, `G5 seed row for ${modelId}`).toBeDefined();
      // The union runs over the legs that are BOTH reachable (the model's configured
      // chain, expanded) and priced (a usable signed cost row on that relay). The
      // previous version unioned the whole contract registry, so a capability that
      // only exists on a gateway this model is not configured to use — or one we
      // cannot charge for — still counted as executable. That is R-2 read backwards.
      // Inactive rows are not on sale, so there is nothing to mis-sell and no cost row
      // to require; they keep the whole-registry union. happyhorse-1-0 is the live
      // example — withdrawn from sale, contracts retained.
      const reachable = row!.isActive === false ? null : executableCostedGateways(row!);
      const routes = reachable
        ? allRoutes.filter((route) => reachable.has(route.gateway))
        : allRoutes;
      if (routes.length === 0) {
        expect(
          MODELS_WITH_NO_COSTED_REACHABLE_LEG,
          `${modelId} advertises capabilities but has no reachable, costed leg`,
        ).toContain(modelId);
        continue;
      }
      const union = deriveCatalogCapabilities(routes);
      const advertised = (row!.capabilities ?? {}) as Record<string, unknown>;

      for (const key of ['frames', 'resolutions', 'aspect_ratios', 'durations'] as const) {
        const claimed = advertised[key];
        const supported = union[key];
        if (!Array.isArray(claimed)) continue;
        expect(
          claimed.every((value) => Array.isArray(supported) && supported.includes(value)),
          `${modelId}.${key} advertises a value absent from every executable leg`,
        ).toBe(true);
      }
      if (advertised['reference'] === true) {
        expect(union['reference'], `${modelId}.reference has no executable leg`).toBe(true);
      }
      for (const key of ['maxRefs', 'maxVideoRefs', 'maxAudioRefs'] as const) {
        // Zero is the catalog's explicit "no references of this kind" value;
        // the route-contract union quite correctly omits a zero maximum.
        if (typeof advertised[key] !== 'number' || advertised[key] <= 0) continue;
        expect(typeof union[key], `${modelId}.${key} has no executable-leg maximum`).toBe('number');
        expect(advertised[key]).toBeLessThanOrEqual(union[key] as number);
      }
    }

    // This is the load-bearing corrected case: Wan's Kie primary is text-only,
    // but its OpenRouter fallback supports first/last frames. The product union
    // must therefore retain frames and G5 must not call it a gap.
    expect((seedById.get('wan-2-7')!.capabilities as Record<string, unknown>).frames).toEqual([
      'first',
      'last',
    ]);
  });

  /**
   * The restriction above is only load-bearing if losing a leg actually removes a
   * capability. Wan is the case that proves it: kie is the configured primary and its
   * contract is text-only, so first/last frames exist ONLY on the OpenRouter fallback.
   * Drop that fallback from the model's configured chain and the advertised capability
   * must stop being covered — under the old whole-registry union it stayed covered,
   * because the contract was still in the registry whether or not we could route to it.
   */
  it('G5 bites: a capability whose only leg stops being reachable is no longer covered', () => {
    // Moved off wan-2-7 on 2026-08-11: its kie leg now serves frames too
    // (`wan/2-7-image-to-video`), so dropping the OpenRouter reserve no longer costs Wan
    // its keyframes — it is the wrong fixture for a one-leg capability. seedance-2-0 is
    // the live one: frames exist on OpenRouter and nowhere else.
    const seedance = seedModels.find((model) => model.id === 'seedance-2-0');
    if (!seedance) throw new Error('seedance-2-0 is gone from the seed');
    const routes = byteplusRouteContracts['seedance-2-0']!.filter((r) => r.inputMode === 'video');

    const asShipped = executableCostedGateways(seedance);
    expect(asShipped.has('openrouter')).toBe(true);
    expect(
      deriveCatalogCapabilities(routes.filter((route) => asShipped.has(route.gateway)))['frames'],
    ).toEqual(['first', 'last']);

    const withoutFallback = executableCostedGateways({ ...seedance, fallbackGateway: null });
    const narrowed = deriveCatalogCapabilities(
      routes.filter(
        (route) => withoutFallback.has(route.gateway) && route.gateway !== 'openrouter',
      ),
    );
    expect(narrowed['frames']).not.toEqual(['first', 'last']);
    // And the whole-registry union — what G5 used to compute — would have hidden it.
    expect(deriveCatalogCapabilities(routes)['frames']).toEqual(['first', 'last']);
  });
});

/**
 * The guard must BITE — feed it a contract set drifted from the catalog and prove
 * the derived bag no longer equals the committed one. Without this, a green parity
 * suite could just be a no-op.
 */
describe('parity guard detects drift', () => {
  const seedById = new Map(seedModels.map((row) => [row.id, row]));

  it('a dropped resolution tier fails parity', () => {
    const routes = byteplusRouteContracts['seedance-2-0']!;
    const drifted: ModelGatewayContract[] = routes.map((r) =>
      r.role === 'primary'
        ? {
            ...r,
            resolution: {
              kind: 'enum',
              values: ['720p', '1080p'],
              default: '720p',
              onInvalid: 'default',
            },
          }
        : r,
    );
    const committed = pickManagedCapabilities(
      seedById.get('seedance-2-0')!.capabilities as Record<string, unknown>,
    );
    expect(deriveCatalogCapabilities(drifted)).not.toEqual(committed);
  });

  it('a lost frame slot fails parity', () => {
    const routes = byteplusRouteContracts['wan-2-7']!;
    // Stripping the OpenRouter leg USED to be enough: it was the only one contributing
    // Wan's frames. Since 2026-08-11 the kie leg serves them too, so the drift this
    // guard is about has to be injected on EVERY leg — which is the honest statement of
    // it anyway: parity must fail when the product loses a slot, not when one leg does.
    const drifted = routes.map((r) => ({
      ...r,
      reference: { ...r.reference, imageRole: 'none' as const, frameRoles: [] },
    }));
    const committed = pickManagedCapabilities(
      seedById.get('wan-2-7')!.capabilities as Record<string, unknown>,
    );
    expect(deriveCatalogCapabilities(drifted)).not.toEqual(committed);
  });
});

/**
 * The output-audio vs generate_audio CONTROL split is the registry's, not the
 * catalog's (Phase 1 task). Assert it is genuinely populated — a kie-primary leg
 * that emits audio without a toggle must read output:true / control:false.
 */
describe('audio output/control split', () => {
  const routeOf = (modelId: string, gateway: string): ModelGatewayContract =>
    byteplusRouteContracts[modelId]!.find((r) => r.gateway === gateway)!;

  it('Seedance on OpenRouter exposes a generate_audio control', () => {
    const c = routeOf('seedance-2-0', 'openrouter');
    expect(c.audio).toEqual({ output: true, control: true });
  });

  it('Wan on kie outputs audio but has no control', () => {
    const c = routeOf('wan-2-7', 'kie');
    expect(c.audio).toEqual({ output: true, control: false });
  });
});

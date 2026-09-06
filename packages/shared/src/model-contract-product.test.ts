import { describe, expect, it } from 'vitest';
import { seedModels } from '@seed/db/seed/models';
import { byteplusRouteContracts } from './model-contract-byteplus';
import { resolveProductContract } from './model-contract-product';

/**
 * DoD 5 — route-aware product contract: the published surface is the intersection of
 * every eligible route (no silent failover downgrade), conditioning is the union
 * (deliverable via whichever route supports it), and any primary-only property is an
 * EXPLICIT declared downgrade.
 */
const seedById = new Map(seedModels.map((row) => [row.id, row]));
const product = (modelId: string) =>
  resolveProductContract(
    byteplusRouteContracts[modelId]!,
    seedById.get(modelId)?.capabilities as Record<string, unknown> | undefined,
  )!;

describe('resolveProductContract — Seedance 2.0 (OR primary, kie fallback)', () => {
  const c = product('seedance-2-0');

  it('names the primary + fallback gateways', () => {
    expect(c.primaryGateway).toBe('openrouter');
    expect(c.fallbackGateways).toEqual(['kie']);
  });

  it('intersects the scalar menus (both routes agree here)', () => {
    expect(c.resolution).toEqual(['480p', '720p', '1080p']);
    expect(c.duration).toEqual({ min: 4, max: 15 });
  });

  it('offers frames (union) and a generate_audio toggle from the primary', () => {
    expect(c.frameRoles).toEqual(['first', 'last']);
    expect(c.reference).toEqual({ maxImages: 0, maxVideos: 0, maxAudios: 0 });
    expect(c.audioControl).toBe(true);
    expect(c.audioOutput).toBe(true);
  });

  it('DECLARES that the generate_audio toggle is ignored on the kie fallback', () => {
    expect(c.downgrades).toContain(
      'the generate_audio toggle is ignored on the kie fallback (audio is emitted regardless)',
    );
  });
});

describe.each(['seedance-2-0-reference-to-video', 'seedance-2-0-fast-reference-to-video'])(
  'resolveProductContract — %s',
  (modelId) => {
    const c = product(modelId);

    it('withholds unverified video references while keeping image and audio references', () => {
      expect(c.reference, modelId).toEqual({ maxImages: 9, maxVideos: 0, maxAudios: 3 });
    });

    it('does not declare a reference-channel failover downgrade', () => {
      expect(c.downgrades, modelId).not.toContain(
        'video references accepted by the primary (openrouter) are dropped on a failover that caps at 0',
      );
      expect(c.downgrades).not.toContain(
        'audio references accepted by the primary (openrouter) are dropped on a failover that caps at 0',
      );
    });
  },
);

describe('resolveProductContract — Wan 2.7 (kie primary, OR fallback)', () => {
  const c = product('wan-2-7');

  it('names kie primary + OpenRouter fallback', () => {
    expect(c.primaryGateway).toBe('kie');
    expect(c.fallbackGateways).toEqual(['openrouter']);
  });

  it('offers frames via the OR fallback (union) though the kie primary is t2v-only', () => {
    expect(c.frameRoles).toEqual(['first', 'last']);
  });

  it('offers NO generate_audio toggle (the kie primary has no control) and declares no downgrade', () => {
    expect(c.audioControl).toBe(false);
    expect(c.audioOutput).toBe(true);
    expect(c.downgrades).toEqual([]);
  });
});

describe('resolveProductContract — single-vendor kie models (veo / grok)', () => {
  it('veo has no fallback and no downgrades', () => {
    const c = product('veo-3-1');
    expect(c.fallbackGateways).toEqual([]);
    expect(c.downgrades).toEqual([]);
    expect(c.resolution).toEqual(['720p', '1080p']);
    expect(c.frameRoles).toEqual(['first', 'last']);
    expect(c.audioControl).toBe(false);
  });

  it('grok is text-to-video (no frames) with no fallback', () => {
    const c = product('grok-imagine-video');
    expect(c.frameRoles).toEqual([]);
    expect(c.fallbackGateways).toEqual([]);
    expect(c.downgrades).toEqual([]);
  });
});

describe('resolveProductContract — a fallback lacking a control is a DECLARED downgrade', () => {
  // Synthetic pair (the covered 9 all share every control, so this exercises the
  // general soundness): a fallback that renders its own resolution/duration default.
  const base = {
    modelId: 'synthetic',
    inputMode: 'video' as const,
    reference: {
      imageRole: 'none' as const,
      frameRoles: [] as const,
      maxImages: 0,
      maxVideos: 0,
      maxAudios: 0,
    },
    audio: { output: true, control: false },
    negativePrompt: false,
    provenance: { source: 'inferred' as const, date: '2026-07-20', note: 'synthetic' },
  };
  const contracts = [
    {
      ...base,
      gateway: 'openrouter' as const,
      role: 'primary' as const,
      slug: 'p',
      resolution: {
        kind: 'enum' as const,
        values: ['720p', '1080p'],
        default: '720p',
        onInvalid: 'default' as const,
      },
      duration: {
        kind: 'duration' as const,
        steps: [4, 6],
        acceptsIntermediate: true,
        min: 4,
        max: 8,
        default: 4,
        onBelowMin: 'floor' as const,
        onAboveMax: 'clamp' as const,
      },
    },
    {
      // fallback with NO resolution and NO duration control
      ...base,
      gateway: 'kie' as const,
      role: 'fallback' as const,
      slug: 'f',
    },
  ];

  it('does not silently advertise the primary control — it declares the absent-route downgrade', () => {
    const c = resolveProductContract(contracts)!;
    // The published resolution is the intersection of routes THAT HAVE it (the primary),
    // but the absent fallback is explicitly flagged so the downgrade is never silent.
    expect(c.downgrades).toContain(
      'resolution is not honored on the kie route (renders its default)',
    );
    expect(c.downgrades).toContain('duration is not honored on the kie route');
  });
});

describe('resolveProductContract — invariants across all covered models', () => {
  for (const [modelId, routes] of Object.entries(byteplusRouteContracts)) {
    const c = resolveProductContract(routes)!;

    it(`${modelId}: the published resolution is a subset of the primary's (intersection ≤ primary)`, () => {
      const primary = routes.find((r) => r.role === 'primary')!;
      if (primary.resolution && c.resolution) {
        for (const v of c.resolution) expect(primary.resolution.values).toContain(v);
      }
    });

    it(`${modelId}: the published duration window is within the primary's`, () => {
      const primary = routes.find((r) => r.role === 'primary')!;
      if (primary.duration && c.duration) {
        expect(c.duration.min).toBeGreaterThanOrEqual(primary.duration.min);
        expect(c.duration.max).toBeLessThanOrEqual(primary.duration.max);
      }
    });
  }
});

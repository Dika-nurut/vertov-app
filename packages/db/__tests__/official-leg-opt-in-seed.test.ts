import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedModels } from '../seed/models';

/**
 * Which rows may reach the third leg of the image chain, and at which rungs.
 *
 * Before 2026-08-02 this was not seed data at all: a hardcoded map in
 * `official-fallback-adapter.ts` armed four gemini rows, so a model could be
 * routed to a leg it had never opted into, at a rate nobody had costed. The
 * opt-in now lives on the row — `capabilities.openrouterFallbackSlug` — which
 * means it is reviewable here, and the per-rung rate next to it
 * (`capabilities.officialUsdPerUnit`) says which rungs the leg may serve at all.
 *
 * The capability names are asserted literally rather than through the
 * `@seed/shared` reader: `@seed/shared` depends on this package, so the seed
 * cannot import it back, and a data spec should read the data anyway.
 */

const GEMINI_IMAGE_ROWS = [
  'gemini-2-5-flash-image',
  'gemini-3-pro-image',
  'gemini-3-1-flash-image',
  'gemini-3-1-flash-lite-image',
];

const MIGRATION = readFileSync(
  resolve(
    fileURLToPath(new URL('.', import.meta.url)),
    '../migrations/0073_official_leg_budget.sql',
  ),
  'utf8',
);

const byId = new Map(seedModels.map((m) => [m.id, m]));
const caps = (id: string) => (byId.get(id)!.capabilities ?? {}) as Record<string, unknown>;

describe('who has opted into the official OpenRouter leg', () => {
  it('is exactly the four Gemini image rows', () => {
    const optedIn = seedModels
      .filter((m) => (m.capabilities as Record<string, unknown> | null)?.['openrouterFallbackSlug'])
      .map((m) => m.id);
    expect(optedIn.sort()).toEqual([...GEMINI_IMAGE_ROWS].sort());
  });

  it('does not include gpt-image-2, which shares the same nanobanana chain', () => {
    // It routes through the same laozhang/kie pair but cannot preserve its
    // low/medium/high quality axis on the official route.
    expect(caps('gpt-image-2')['openrouterFallbackSlug']).toBeUndefined();
  });
});

describe('which rungs the leg may actually serve', () => {
  it('costs Nano Banana Pro at 4K, the one rung we hold an invoice for', () => {
    expect(caps('gemini-3-pro-image')['officialUsdPerUnit']).toEqual({ '4K': 0.241344 });
  });

  it('leaves the other three opted-in rows entirely uncosted, i.e. unroutable there', () => {
    for (const id of GEMINI_IMAGE_ROWS.filter((r) => r !== 'gemini-3-pro-image')) {
      expect(caps(id)['officialUsdPerUnit']).toBeUndefined();
    }
  });

  it('never carries the third-leg rate as a scalar, the way legs 0 and 1 do', () => {
    for (const model of seedModels) {
      const rate = (model.capabilities as Record<string, unknown> | null)?.['officialUsdPerUnit'];
      if (rate !== undefined) expect(typeof rate).toBe('object');
    }
  });
});

describe('the migration and the seed agree', () => {
  it('opts in the same four rows in migration 0067 as the seed does', () => {
    for (const id of GEMINI_IMAGE_ROWS) {
      expect(MIGRATION).toContain(
        `"openrouterFallbackSlug":"${caps(id)['openrouterFallbackSlug']}"`,
      );
      expect(MIGRATION).toContain(`WHERE "id" = '${id}'`);
    }
    expect(MIGRATION).toContain('"officialUsdPerUnit":{"4K":0.241344}');
  });

  it('seeds both caps so a migrated database is not silently uncapped', () => {
    expect(MIGRATION).toContain("('official_leg_budget_daily_rub', '3000'::jsonb");
    expect(MIGRATION).toContain("('official_leg_budget_monthly_rub', '20000'::jsonb");
  });
});

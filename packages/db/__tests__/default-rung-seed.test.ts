import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { seedModels } from '../seed/models';
import { parseCostLegs } from '../src/cost-legs';

const csv = parseCostLegs(readFileSync(new URL('../seed/cost-legs.csv', import.meta.url), 'utf8'));

const expectedDefaults = {
  'flux-2-pro': '1K',
  'gemini-3-1-flash-image': '1K',
  'gemini-3-pro-image': '1K',
  'gpt-image-2': 'low',
  'grok-imagine-video': '480p',
  'seedream-5-0-lite': '2K',
  'seedream-5-0-pro': '1K',
  'veo-3-1': '1080p',
  'veo-3-1-fast': '720p',
  'veo-3-1-lite': '720p',
  'wan-2-7': '720p',
  'kling-v3-0-std': '720p',
  'happyhorse-1-0': '720p',
  'happyhorse-1-1': '720p',
  'seedance-2-0': '480p',
  'seedance-2-0-fast': '480p',
} as const;

const modelById = new Map(seedModels.map((model) => [model.id, model]));

describe('rev. 15 default rung binding', () => {
  it('keeps finance’s default rung consistent across every model’s export rows', () => {
    const defaultsByModel = new Map<string, Set<string | null>>();
    for (const leg of csv.legs) {
      const defaults = defaultsByModel.get(leg.modelId) ?? new Set<string | null>();
      defaults.add(leg.defaultRung);
      defaultsByModel.set(leg.modelId, defaults);
    }

    for (const [modelId, defaults] of defaultsByModel) {
      expect([...defaults], modelId).toHaveLength(1);
      expect([...defaults][0], modelId).toEqual(expect.any(String));
    }
  });

  it('matches every declared menu to finance, except the named Seedream 4.5 mismatch', () => {
    const exportDefaultByModel = new Map<string, string>();
    for (const leg of csv.legs) {
      if (!exportDefaultByModel.has(leg.modelId)) {
        exportDefaultByModel.set(leg.modelId, leg.defaultRung!);
      }
    }

    for (const [modelId, exportDefault] of exportDefaultByModel) {
      const model = modelById.get(modelId);
      expect(model, modelId).toBeDefined();
      const capabilities = (model!.capabilities ?? {}) as Record<string, unknown>;
      const resolutions = capabilities['resolutions'];
      const seededDefault = capabilities['default_resolution'];

      if (Array.isArray(resolutions) && resolutions.length > 0) {
        if (modelId === 'seedream-4-5') {
          // This inactive row survives for history, but its exported default no longer
          // constrains the product: owner ruling says only Seedream 5.0 ships.
          expect(model!.isActive).toBe(false);
          expect(seededDefault).toBeUndefined();
        } else {
          expect(seededDefault, modelId).toBe(exportDefault);
        }
      }

      if (seededDefault !== undefined) {
        expect(resolutions, modelId).toContain(seededDefault);
      }
    }
  });

  it('seeds exactly the signed models and no other capability bags', () => {
    const actual = Object.fromEntries(
      seedModels
        .filter((model) => {
          const capabilities = (model.capabilities ?? {}) as Record<string, unknown>;
          return capabilities['default_resolution'] !== undefined;
        })
        .map((model) => [
          model.id,
          (model.capabilities as Record<string, unknown>)['default_resolution'],
        ])
        .sort(([a], [b]) => String(a).localeCompare(String(b))),
    );

    expect(actual).toEqual(expectedDefaults);
  });

  it('registers one additive migration update for each signed default', () => {
    const sql = readFileSync(
      new URL('../migrations/0086_rev15_default_rung.sql', import.meta.url),
      'utf8',
    );
    const updates = [
      ...sql.matchAll(
        /UPDATE "models"\s+SET "capabilities" = "capabilities" \|\| '(\{"default_resolution":"[^"]+"\})'::jsonb\s+WHERE "id" = '([^']+)';/g,
      ),
    ];
    const actual = Object.fromEntries(
      updates.map((match) => [
        match[2],
        (JSON.parse(match[1]!) as { default_resolution: string }).default_resolution,
      ]),
    );

    expect(actual).toEqual(expectedDefaults);
    expect(updates).toHaveLength(Object.keys(expectedDefaults).length);
  });
});

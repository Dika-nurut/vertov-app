import { describe, expect, it } from 'vitest';
import { seedModels } from '../seed/models';
import { PRICE_POINT_SEED } from '../seed/price-points';
import { buildPresetPackRows } from '../seed/preset-packs';

describe('preset resolution rungs', () => {
  it('uses a declared and actively priced rung for every variable-output preset', () => {
    const modelById = new Map(seedModels.map((model) => [model.id, model]));
    const presetsBySlug = new Map(buildPresetPackRows().map((preset) => [preset.slug, preset]));

    for (const preset of presetsBySlug.values()) {
      const resolution = preset.paramsJson?.['resolution'];
      if (typeof resolution !== 'string') continue;

      const model = modelById.get(preset.modelId);
      expect(model, `${preset.slug} references unknown model ${preset.modelId}`).toBeDefined();
      const resolutions = (model?.capabilities as Record<string, unknown> | undefined)?.[
        'resolutions'
      ];
      if (!Array.isArray(resolutions) || resolutions.length === 0) {
        // An empty resolutions list is a fixed-output contract: the request's
        // value is ignored and the price key is pinned to 'default'.
        // `demo-gemini-omni-flash-jumbotron` and
        // `demo-gemini-omni-golden-hour-car` intentionally ask for 1080p but
        // are exempt here.
        continue;
      }

      expect(resolutions, `${preset.slug} asks for an unsupported ${resolution}`).toContain(
        resolution,
      );
      expect(
        PRICE_POINT_SEED.some(
          (point) =>
            point.isActive && point.modelId === preset.modelId && point.resolution === resolution,
        ),
        `${preset.slug} has no active price row for ${preset.modelId} ${resolution}`,
      ).toBe(true);
    }
  });
});

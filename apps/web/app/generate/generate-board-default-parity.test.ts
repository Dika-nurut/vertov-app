import { describe, expect, it } from 'vitest';
import { seedModels } from '@seed/db/seed/models';
import {
  boardImageQualitiesFor,
  boardVideoResolutionsFor,
  resolveBoardImageSettings,
  resolveBoardVideoSettings,
  type BoardModelLike,
} from '@seed/shared/board-contract';
import {
  NO_VIDEO_RESOLUTION_PICK,
  generateVideoResolutionOptions,
  resolveImageQuality,
  resolveVideoResolution,
} from './GenerateClient';

describe('Boards and Generate signed default parity', () => {
  // This is no longer a comparison of two precedence implementations: both callers now
  // use shared `pickSignedRung`. The guard remains valuable because each surface supplies
  // its own offered list and legacy default, and a caller can still pass either one wrong.
  it('gives active catalogue models the same untouched defaults on both surfaces', () => {
    for (const model of seedModels) {
      if (!model.isActive) {
        // Retired catalogue rows remain for history and pricing, but are not product surfaces.
        continue;
      }

      const boardModel = model as BoardModelLike;
      if (model.kind === 'image' || model.kind === 'image-edit') {
        const offeredQualities = boardImageQualitiesFor(boardModel);
        if (offeredQualities.length === 0) continue;

        expect(resolveImageQuality(model.capabilities), `${model.id} image`).toBe(
          resolveBoardImageSettings({}, boardModel).imageQuality,
        );
      }

      if (model.kind === 'video') {
        // Spelled out rather than spread: the seed row types its optional fields as
        // `| undefined` and the UI helper as `| null`, which `exactOptionalPropertyTypes`
        // treats as different types. Naming the three fields the helper actually reads is
        // also a check in itself — widen the helper and this stops compiling.
        const resolutionOptions = generateVideoResolutionOptions(
          {
            id: model.id,
            kind: model.kind,
            capabilities: model.capabilities ?? null,
            maxResolution: model.maxResolution ?? null,
          },
          true,
        );
        expect(
          resolveVideoResolution(NO_VIDEO_RESOLUTION_PICK, resolutionOptions, model.capabilities),
          `${model.id} video`,
        ).toBe(resolveBoardVideoSettings({}, boardModel).videoResolution);
      }
    }
  });

  it('keeps Gemini Omni’s fixed-output menu difference while preserving its default', () => {
    const model = seedModels.find((candidate) => candidate.id === 'gemini-omni-flash');
    if (!model) throw new Error('gemini-omni-flash left the seed roster');
    const shapedModel = {
      id: model.id,
      kind: model.kind,
      capabilities: model.capabilities ?? null,
      maxResolution: model.maxResolution ?? null,
    } satisfies BoardModelLike;

    expect(generateVideoResolutionOptions(shapedModel, true)).toEqual(['720p']);
    expect(boardVideoResolutionsFor(shapedModel)).toEqual([]);
    expect(
      resolveVideoResolution(
        NO_VIDEO_RESOLUTION_PICK,
        generateVideoResolutionOptions(shapedModel, true),
        shapedModel.capabilities,
      ),
    ).toBe(resolveBoardVideoSettings({}, shapedModel).videoResolution);
    expect(resolveBoardVideoSettings({}, shapedModel).videoResolution).toBe('720p');
  });
});

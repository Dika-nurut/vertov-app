import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { seedModels } from '@seed/db/seed/models';
import {
  boardImageQualitiesFor,
  boardImageQualityLabel,
  resolveBoardImageSettings,
  resolveBoardVideoSettings,
} from '@seed/shared/board-contract';
import {
  generateVideoResolutionOptions,
  imageGenerationParams,
  imageQualityForModel,
  isDraftVideoCandidate,
  modelSelectionState,
  presetResolutionState,
  repeatCostForJob,
  resolveImageQuality,
  resolveVideoResolution,
  NO_VIDEO_RESOLUTION_PICK,
  totalGenerateCost,
  withLegacyRung,
} from './GenerateClient';

const GENERATE_SOURCE = readFileSync(join(__dirname, 'GenerateClient.tsx'), 'utf8');

describe('Generate model switches', () => {
  it('clears draft for every model-switch path, including the quick switch', () => {
    expect(modelSelectionState('gemini-omni-flash')).toEqual({
      modelId: 'gemini-omni-flash',
      draft: false,
    });
    for (const path of [
      'selectModel(target.id)',
      'selectModel(source.id)',
      'selectModel(frameVideoModel.id)',
      'selectModel(imageEditModel.id)',
      'selectModel(referenceVideoModel.id)',
      'selectModel(e.target.value)',
      'selectModel(m.id)',
    ]) {
      expect(GENERATE_SOURCE, path).toContain(path);
    }
    expect(GENERATE_SOURCE).not.toContain('onClick={() => setModelId(m.id)}');
  });
});

// Goal invariant 4 (estimate == submit): resolveImageQuality is the ONE place
// both call sites compute the `quality` param from the model's capability bag. Phase 1.1 (docs/programs/goals/pricing-correct-
// catalogue-build.md) — gpt-image-2 no longer declares '2K' once it declares
// ['low','medium','high'], so the old hardcoded `includes('2K')` check would
// silently omit `quality` and the request would price at `'default'` (no row).
describe('resolveImageQuality', () => {
  it('uses finance’s seeded default when it is a declared rung', () => {
    expect(resolveImageQuality({ resolutions: ['1K', '2K', '4K'], default_resolution: '1K' })).toBe(
      '1K',
    );
  });

  it("picks '2K' when the model declares it", () => {
    expect(resolveImageQuality({ resolutions: ['1K', '2K', '4K'] })).toBe('2K');
  });

  it('picks the middle entry of a non-2K declared list', () => {
    expect(resolveImageQuality({ resolutions: ['low', 'medium', 'high'] })).toBe('medium');
  });

  it('uses the legacy rule when the seeded default is not declared', () => {
    expect(resolveImageQuality({ resolutions: ['1K', '2K', '4K'], default_resolution: '8K' })).toBe(
      '2K',
    );
  });

  it('keeps the empty-menu behavior unchanged', () => {
    expect(resolveImageQuality({ resolutions: [], default_resolution: '1K' })).toBeUndefined();
  });

  it('keeps the absent-bag behavior unchanged', () => {
    expect(resolveImageQuality(undefined)).toBeUndefined();
  });
});

describe('resolveVideoResolution', () => {
  // The defect these describe was never in the helper — it was in the value the screen
  // starts on, which is why the helper's own tests stayed green while every video model
  // still opened on 720p. They feed it `NO_VIDEO_RESOLUTION_PICK`, the same symbol the
  // component's state initialises with, so they read as first paint rather than as a
  // state the screen may never produce. That is a coupling, not a guarantee: there is no
  // DOM environment here to render the component, so re-pinning the initialiser to a
  // literal would still pass. See the constant's comment.
  it('uses the signed Veo default on first paint when there is no user pick', () => {
    expect(
      resolveVideoResolution(NO_VIDEO_RESOLUTION_PICK, ['720p', '1080p'], {
        default_resolution: '1080p',
      }),
    ).toBe('1080p');
  });

  it('uses the signed Grok default on first paint when there is no user pick', () => {
    expect(
      resolveVideoResolution(NO_VIDEO_RESOLUTION_PICK, ['480p', '720p'], {
        default_resolution: '480p',
      }),
    ).toBe('480p');
  });

  it('uses a seeded default when the current resolution is no longer an option', () => {
    expect(
      resolveVideoResolution('4K', ['480p', '720p', '1080p'], {
        default_resolution: '480p',
      }),
    ).toBe('480p');
  });

  it('keeps the 720p fallback for an un-seeded model on first paint', () => {
    expect(resolveVideoResolution(NO_VIDEO_RESOLUTION_PICK, ['480p', '720p', '1080p'], {})).toBe(
      '720p',
    );
  });

  it('honors a valid explicit pick over the signed default', () => {
    expect(
      resolveVideoResolution('720p', ['720p', '1080p'], {
        default_resolution: '1080p',
      }),
    ).toBe('720p');
  });

  it('honors the hardcoded fallbacks when the seeded default is unusable', () => {
    expect(
      resolveVideoResolution('4K', ['480p', '720p', '1080p'], {
        default_resolution: '4K',
      }),
    ).toBe('720p');
    expect(resolveVideoResolution('4K', ['480p'], {})).toBe('480p');
  });
});

describe('draft video model eligibility', () => {
  it('qualifies a fast model that explicitly offers 480p', () => {
    expect(
      isDraftVideoCandidate({
        id: 'seedance-2-0-fast',
        kind: 'video',
        capabilities: { resolutions: ['480p', '720p'] },
      }),
    ).toBe(true);
  });

  it('rejects a fast model whose declared menu starts at 720p', () => {
    expect(
      isDraftVideoCandidate({
        id: 'veo-3-1-fast',
        kind: 'video',
        capabilities: { resolutions: ['720p', '1080p'] },
      }),
    ).toBe(false);
  });

  it('rejects a fast model with no declared resolution menu', () => {
    expect(isDraftVideoCandidate({ id: 'legacy-fast', kind: 'video', capabilities: {} })).toBe(
      false,
    );
  });
});

describe('Generate image-quality control', () => {
  const gptImage2 = {
    id: 'gpt-image-2',
    kind: 'image' as const,
    capabilities: { resolutions: ['low', 'medium', 'high'] },
  };

  it('renders the three declared vendor qualities with Russian labels and defaults to medium', () => {
    const qualities = boardImageQualitiesFor(gptImage2);

    expect(qualities.map(boardImageQualityLabel)).toEqual(['Низкое', 'Среднее', 'Высокое']);
    expect(resolveImageQuality(gptImage2.capabilities)).toBe('medium');
  });

  it('renders no quality control when the model explicitly declares no resolutions', () => {
    expect(
      boardImageQualitiesFor({ id: 'recraft', kind: 'image', capabilities: { resolutions: [] } }),
    ).toEqual([]);
  });

  it('sends the selected quality identically to the estimate and submit params', () => {
    const selected = 'high';
    const estimateParams = imageGenerationParams('1:1', selected, 1);
    const submitParams = imageGenerationParams('1:1', selected, 1);

    expect(estimateParams).toEqual({ size: '1:1', resolution: 'high', n: 1 });
    expect(submitParams).toEqual(estimateParams);
  });

  it('sends image references identically to the estimate and submit params', () => {
    const references = ['first.png', 'second.png'];
    const estimateParams = imageGenerationParams('1:1', '2K', 1, references);
    const submitParams = imageGenerationParams('1:1', '2K', 1, references);

    expect(estimateParams).toEqual({
      size: '1:1',
      resolution: '2K',
      n: 1,
      imageUrls: references,
    });
    expect(submitParams).toEqual(estimateParams);
  });

  it('uses the new model default immediately after a model switch', () => {
    const previousPick = { modelId: 'gemini-3-pro-image', quality: '4K' };

    expect(
      imageQualityForModel('gpt-image-2', previousPick, ['low', 'medium', 'high'], 'medium'),
    ).toBe('medium');
  });
});

describe('preset rung routing', () => {
  it('routes an image preset 2K rung into the image quality used by the quote', () => {
    const routed = presetResolutionState(
      { kind: 'image' },
      'seedream-5-0-pro',
      'seedream-5-0-pro',
      '2K',
      'image',
    );
    expect(routed).toEqual({
      imageQuality: { modelId: 'seedream-5-0-pro', quality: '2K' },
      videoResolution: null,
    });
    const quality = imageQualityForModel(
      'seedream-5-0-pro',
      routed.imageQuality,
      ['1K', '2K'],
      '1K',
    );
    expect(imageGenerationParams('1:1', quality, 1)).toMatchObject({ resolution: '2K' });
  });

  it('keeps a video preset rung in the video state stamp', () => {
    expect(
      presetResolutionState({ kind: 'video' }, 'seedance-2-0', 'seedance-2-0', '1080p', 'video'),
    ).toEqual({
      imageQuality: null,
      videoResolution: { modelId: 'seedance-2-0', resolution: '1080p' },
    });
  });

  it('falls back to the mode on screen when the preset names a model we cannot see', () => {
    // A retired or deactivated model drops out of the catalogue, so `target` is undefined
    // exactly when a stale preset row is applied — the case migration 0089 exists for.
    // Guessing "image" there would file a video preset's rung under the image selector.
    expect(presetResolutionState(undefined, null, 'seedance-2-0', '1080p', 'video')).toEqual({
      imageQuality: null,
      videoResolution: { modelId: 'seedance-2-0', resolution: '1080p' },
    });
    expect(presetResolutionState(undefined, null, 'seedream-5-0-pro', '2K', 'image')).toEqual({
      imageQuality: { modelId: 'seedream-5-0-pro', quality: '2K' },
      videoResolution: null,
    });
  });
});

describe('repeat price display', () => {
  it('uses the historical job reservation rather than the current recipe quote', () => {
    expect(repeatCostForJob('job-veo', 597, { jobId: 'job-veo', cost: 37 })).toBe(597);
  });

  it('uses a just-acknowledged stale quote only when the receipt has no amount', () => {
    expect(repeatCostForJob('job-veo', null, { jobId: 'job-veo', cost: 597 })).toBe(597);
    expect(repeatCostForJob('other-job', null, { jobId: 'job-veo', cost: 597 })).toBeNull();
  });

  it('binds the repeated amount to the action button', () => {
    expect(GENERATE_SOURCE).toContain('repeatCostForJob(');
    expect(GENERATE_SOURCE).toContain('data-testid="action-repeat"');
  });
});

describe('Generate signed defaults after the shared precedence extraction', () => {
  it('opens the named seeded models on their finance defaults', () => {
    const flux = seedModels.find((model) => model.id === 'flux-2-pro');
    const veo = seedModels.find((model) => model.id === 'veo-3-1');
    const seedance = seedModels.find((model) => model.id === 'seedance-2-0');
    const gptImage = seedModels.find((model) => model.id === 'gpt-image-2');
    if (!flux || !veo || !seedance || !gptImage) throw new Error('default fixture left the roster');
    const veoModel = {
      id: veo.id,
      kind: veo.kind,
      capabilities: veo.capabilities ?? null,
      maxResolution: veo.maxResolution ?? null,
    };
    const seedanceModel = {
      id: seedance.id,
      kind: seedance.kind,
      capabilities: seedance.capabilities ?? null,
      maxResolution: seedance.maxResolution ?? null,
    };

    expect(resolveImageQuality(flux.capabilities)).toBe('1K');
    expect(
      resolveVideoResolution(
        NO_VIDEO_RESOLUTION_PICK,
        generateVideoResolutionOptions(veoModel, true),
        veoModel.capabilities,
      ),
    ).toBe('1080p');
    expect(
      resolveVideoResolution(
        NO_VIDEO_RESOLUTION_PICK,
        generateVideoResolutionOptions(seedanceModel, true),
        seedanceModel.capabilities,
      ),
    ).toBe('480p');
    expect(resolveImageQuality(gptImage.capabilities)).toBe('low');
  });

  it('keeps each surface’s legacy rule for an unseeded model', () => {
    const image = {
      id: 'unseeded-image',
      kind: 'image' as const,
      capabilities: { resolutions: ['low', 'medium', 'high'] },
    };
    const video = {
      id: 'unseeded-video',
      kind: 'video' as const,
      capabilities: { resolutions: ['480p', '720p', '1080p'] },
    };

    // /generate's legacy image fallback is the middle entry; Boards' contract fallback
    // is its global 2K, which is not offered here, so it takes the first offered rung.
    expect(resolveImageQuality(image.capabilities)).toBe('medium');
    expect(resolveBoardImageSettings({}, image).imageQuality).toBe('low');
    expect(
      resolveVideoResolution(
        NO_VIDEO_RESOLUTION_PICK,
        generateVideoResolutionOptions(video, true),
        video.capabilities,
      ),
    ).toBe('720p');
    expect(resolveBoardVideoSettings({}, video).videoResolution).toBe('720p');
  });
});

describe('totalGenerateCost', () => {
  it('renders the sum of every video fan-out reservation', () => {
    const quotedCost = 913;
    const takes = 4;
    const reservations = Array.from({ length: takes }, () => quotedCost);

    expect(totalGenerateCost(quotedCost, takes, true)).toBe(
      reservations.reduce((total, reservation) => total + reservation, 0),
    );
  });

  it('leaves a single video take and an image batch quote unchanged', () => {
    expect(totalGenerateCost(913, 1, true)).toBe(913);
    // Images submit one request with n=count, which the server quote already includes.
    expect(totalGenerateCost(913, 4, false)).toBe(913);
  });
});

/**
 * «Повторить» on a job that predates its model's rung ladder.
 *
 * The button replays the original params verbatim, so a job stored before rev. 14
 * carries no `resolution` at all. Once flux-2-pro declares ['1K','2K'] the price
 * resolver keys that request on the literal 'default', which has no active row — the
 * repeat dead-ends on `config_not_available` rather than the price refusal the button
 * is built around.
 */
describe('withLegacyRung — repeating a job older than its model’s ladder', () => {
  const flux = { capabilities: { resolutions: ['1K', '2K'] } };

  it('fills the cheapest declared rung, which is the tier the job actually rendered at', () => {
    // `buildKieImageBody` pinned '1K' while flux sold one sizeless rung, so this
    // reproduces the original job instead of approximating it — and 1K is still the
    // 11 credits that job was charged.
    expect(withLegacyRung({ size: '1:1', n: 1 }, flux)).toEqual({
      size: '1:1',
      n: 1,
      resolution: '1K',
    });
  });

  it('never overrides a rung the stored params already carry', () => {
    expect(withLegacyRung({ n: 1, resolution: '2K' }, flux)['resolution']).toBe('2K');
  });

  it('leaves a model with no declared ladder exactly as it was', () => {
    // Gemini Omni declares an explicitly EMPTY list: its price key IS 'default', and
    // inventing a rung here would refuse a request that prices correctly today.
    expect(withLegacyRung({ n: 1 }, { capabilities: { resolutions: [] } })).toEqual({ n: 1 });
    expect(withLegacyRung({ n: 1 }, { capabilities: {} })).toEqual({ n: 1 });
    expect(withLegacyRung({ n: 1 }, null)).toEqual({ n: 1 });
  });

  it('copies rather than mutates the stored recipe', () => {
    const stored = { n: 1 };
    expect(withLegacyRung(stored, flux)).not.toBe(stored);
    expect(stored).toEqual({ n: 1 });
  });
});

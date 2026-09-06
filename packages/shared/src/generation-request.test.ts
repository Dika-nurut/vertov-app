import { describe, expect, it } from 'vitest';
import {
  generationJobEstimateSchema,
  generationJobRequestSchema,
  generationJobSubmitSchema,
  unitsForGenerationModel,
  unknownGenerationParamKeys,
  KNOWN_GENERATION_PARAM_KEYS,
} from './generation-request';

describe('unknownGenerationParamKeys — DoD 6 log-first vocabulary', () => {
  it('returns nothing for a well-formed request', () => {
    expect(
      unknownGenerationParamKeys({
        resolution: '1080p',
        duration_seconds: 6,
        aspect_ratio: '16:9',
      }),
    ).toEqual([]);
  });

  it('flags only the keys outside the known vocabulary', () => {
    expect(
      unknownGenerationParamKeys({ resolution: '720p', bogus_knob: 1, another_typo: 'x' }),
    ).toEqual(['bogus_knob', 'another_typo']);
  });

  it('accepts every legacy + conditioning + sentinel key without flagging', () => {
    const legacy = {
      size: '1:1',
      quality: '2K',
      imageUrls: [],
      frameImages: [],
      negative_prompt: 'blurry',
      watermark: true,
      webSearch: false,
      __gateway: 'kie',
      seed: 7,
      n: 2,
    };
    expect(unknownGenerationParamKeys(legacy)).toEqual([]);
  });

  it('never flags an empty param bag', () => {
    expect(unknownGenerationParamKeys({})).toEqual([]);
    expect(KNOWN_GENERATION_PARAM_KEYS.has('resolution')).toBe(true);
  });
});

describe('generation request boundary', () => {
  it('makes quote and submit consume the same normalized core', () => {
    const core = {
      modelId: 'seedream-4-5',
      prompt: 'shot',
      params: { size: '1:1', quality: '2K', n: 2 },
      source: 'boards' as const,
    };
    const estimate = generationJobRequestSchema.parse(core);
    const { idempotencyKey: _idempotencyKey, ...submitCore } = generationJobSubmitSchema.parse({
      ...core,
      idempotencyKey: 'idem-12345678',
    });

    expect(submitCore).toEqual(estimate);
    expect(estimate).toMatchObject({ referenceAssets: [] });
  });

  it('rejects fields that exist only on quote or only on submit', () => {
    expect(
      generationJobRequestSchema.safeParse({
        modelId: 'x',
        prompt: 'shot',
        params: {},
        quoteOnly: true,
      }).success,
    ).toBe(false);
    expect(
      generationJobSubmitSchema.safeParse({
        modelId: 'x',
        prompt: 'shot',
        params: {},
        idempotencyKey: 'idem-12345678',
        submitOnly: true,
      }).success,
    ).toBe(false);
  });

  it('accepts a quote to bind only on submit, and only as a whole positive count', () => {
    const body = { modelId: 'x', prompt: 'shot', params: {}, expectedCost: 448 };
    // Quoting a quote is meaningless — the estimate endpoint is what issues it.
    expect(generationJobRequestSchema.safeParse(body).success).toBe(false);
    expect(
      generationJobSubmitSchema.parse({ ...body, idempotencyKey: 'idem-12345678' }).expectedCost,
    ).toBe(448);
    // Credits are whole and a real charge is never zero, so a fractional or empty
    // expectation is a client bug, not a price to argue with at the comparison.
    for (const expectedCost of [0, -1, 4.5]) {
      expect(
        generationJobSubmitSchema.safeParse({
          ...body,
          expectedCost,
          idempotencyKey: 'idem-12345678',
        }).success,
      ).toBe(false);
    }
  });

  it('accepts projectId only on the persisted submit boundary', () => {
    const body = {
      modelId: 'x',
      prompt: 'shot',
      params: {},
      projectId: 'desk-project',
    };
    expect(generationJobRequestSchema.safeParse(body).success).toBe(false);
    expect(
      generationJobSubmitSchema.parse({ ...body, idempotencyKey: 'idem-12345678' }).projectId,
    ).toBe('desk-project');
  });

  it('accepts preset provenance only on the persisted submit boundary', () => {
    const body = {
      modelId: 'x',
      prompt: 'shot',
      params: {},
      presetSlug: 'vitrina-noir',
    };
    expect(generationJobEstimateSchema.safeParse(body).success).toBe(false);
    expect(
      generationJobSubmitSchema.parse({ ...body, idempotencyKey: 'idem-12345678' }).presetSlug,
    ).toBe('vitrina-noir');
  });

  it('shares billing units across image and video requests', () => {
    expect(
      unitsForGenerationModel({ kind: 'image', params: { n: 3 }, maxDurationSeconds: null }),
    ).toEqual({ ok: true, units: 3 });
    expect(
      unitsForGenerationModel({
        kind: 'video',
        params: { duration_seconds: 8 },
        maxDurationSeconds: 12,
      }),
    ).toEqual({ ok: true, units: 8 });
  });

  it('collapses a finite image count overflow before it reaches price arithmetic', () => {
    expect(
      unitsForGenerationModel({ kind: 'image', params: { n: 1e308 }, maxDurationSeconds: null }),
    ).toEqual({ ok: true, units: 1 });
  });

  it('rejects Generate durationAuto sentinel before it can become billing units', () => {
    const result = unitsForGenerationModel({
      kind: 'video',
      params: { duration_seconds: -1 },
      maxDurationSeconds: 10,
    });

    expect(result).toEqual({ ok: false, error: 'duration_seconds_required' });
    expect('units' in result).toBe(false);
  });
});

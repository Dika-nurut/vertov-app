import { describe, expect, it } from 'vitest';
import {
  boardRunModelLocked,
  prepareBoardNodeRun,
  type BoardRunNodeLike,
} from './board-run-request';
import { nodeEstimateRequest, type ModelLike, type NodeSettings } from './node-settings';

const model: ModelLike = {
  id: 'seedream-4-5',
  family: 'Seedream',
  variant: '4.0',
  kind: 'image',
  minUnitCredits: 15,
  maxDurationSeconds: null,
  capabilities: {
    reference: true,
    maxRefs: 14,
    resolutions: ['1K', '2K', '4K'],
    aspect_ratios: ['1:1', '16:9', '9:16'],
  },
};
const generate = (id: string, patch: Record<string, unknown> = {}): BoardRunNodeLike => ({
  id,
  type: 'generate',
  data: {
    mode: 'image',
    modelId: model.id,
    prompt: 'ready shot',
    imageAspect: '1:1',
    imageQuality: '1K',
    count: 1,
    status: 'idle',
    ...patch,
  },
});
const frameModel: ModelLike = {
  id: 'frame-video',
  family: 'Frame',
  variant: 'test',
  kind: 'video',
  minUnitCredits: 20,
  maxDurationSeconds: 15,
  capabilities: {
    audio: false,
    aspect_ratios: ['16:9'],
    frames: ['first', 'last'],
    durations: [4, 8, 12],
    resolutions: ['720p', '1080p'],
  },
};
const frameGenerate = (id: string): BoardRunNodeLike => ({
  id,
  type: 'generate',
  data: {
    mode: 'video',
    modelId: frameModel.id,
    prompt: 'frame shot',
    durationSeconds: 8,
    videoResolution: '1080p',
    videoAspect: '16:9',
    count: 1,
    status: 'idle',
  },
});

describe('prepareBoardNodeRun', () => {
  it('compiles a ready shot for a server-priced confirmation', () => {
    expect(
      prepareBoardNodeRun({
        nodes: [generate('g')],
        edges: [],
        nodeId: 'g',
        models: [model],
        planTier: 'free',
      }),
    ).toMatchObject({
      ok: true,
      nodeId: 'g',
      modelLabel: 'Seedream 4.0',
      request: {
        source: 'boards',
        modelId: model.id,
        prompt: 'ready shot',
        params: { aspect_ratio: '1:1', resolution: '1K', n: 1 },
        provider: 'openrouter',
      },
    });
  });

  it('quotes a wired frame with the exact params the board runner submits', () => {
    const nodes = [
      frameGenerate('target'),
      { id: 'still', type: 'media', data: { mediaKind: 'image', url: 'first.png' } },
    ];
    const edges = [
      { source: 'still', sourceHandle: 'out', target: 'target', targetHandle: 'images[0]' },
    ];
    const submitted = prepareBoardNodeRun({
      nodes,
      edges,
      nodeId: 'target',
      models: [frameModel],
      planTier: 'free',
    });
    const estimate = nodeEstimateRequest({
      mode: 'video',
      model: frameModel,
      settings: frameGenerate('target').data as NodeSettings,
      imageUrls: ['first.png'],
    });

    expect(submitted.ok, submitted.ok ? undefined : submitted.reason).toBe(true);
    if (submitted.ok) expect(estimate?.params).toEqual(submitted.request.params);
  });

  it('requires an upstream generated result instead of recursively spending', () => {
    const result = prepareBoardNodeRun({
      nodes: [generate('upstream'), generate('target')],
      edges: [
        {
          source: 'upstream',
          sourceHandle: 'out',
          target: 'target',
          targetHandle: 'images[0]',
        },
      ],
      nodeId: 'target',
      models: [model],
      planTier: 'free',
    });
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining('предыдущие кадры'),
    });
  });

  it('fails closed on a generation cycle', () => {
    const result = prepareBoardNodeRun({
      nodes: [generate('a'), generate('b', { status: 'done', resultUrl: 'b.png' })],
      edges: [
        { source: 'a', target: 'b', targetHandle: 'images[0]' },
        { source: 'b', target: 'a', targetHandle: 'images[0]' },
      ],
      nodeId: 'a',
      models: [model],
      planTier: 'free',
    });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('цикл') });
  });

  it('falls back to the cheapest image model unlocked by the plan', () => {
    const creatorModel: ModelLike = {
      ...model,
      id: 'seedream-5-0-pro',
      tierMin: 'creator',
      minUnitCredits: 38,
    };
    const freeModel: ModelLike = {
      ...model,
      id: 'gemini-3-1-flash-lite-image',
      family: 'Nano Banana',
      variant: '3.1 Flash Lite',
      tierMin: 'free',
      minUnitCredits: 9,
      capabilities: { ...model.capabilities, resolutions: [] },
    };
    const result = prepareBoardNodeRun({
      nodes: [generate('g', { modelId: undefined, imageQuality: undefined })],
      edges: [],
      nodeId: 'g',
      models: [creatorModel, freeModel],
      planTier: 'free',
    });

    expect(result).toMatchObject({
      ok: true,
      request: { modelId: 'gemini-3-1-flash-lite-image' },
    });
  });

  it('refuses a locked default before compiling or quoting a mobile run', () => {
    const lockedVideo: ModelLike = {
      ...frameModel,
      id: 'veo-3-1',
      tierMin: 'creator',
      minUnitCredits: 37,
    };
    expect(boardRunModelLocked(lockedVideo, 'free')).toBe(true);
    const result = prepareBoardNodeRun({
      nodes: [
        {
          id: 'g',
          type: 'generate',
          data: {
            mode: 'video',
            modelId: undefined,
            prompt: 'locked shot',
            durationSeconds: 5,
            videoResolution: '720p',
            videoAspect: '16:9',
            count: 1,
            status: 'idle',
          },
        },
      ],
      edges: [],
      nodeId: 'g',
      models: [lockedVideo],
      planTier: 'free',
    });
    expect(result).toMatchObject({
      ok: false,
      reasonCode: 'tier_required',
      reason: expect.stringContaining('Креатор'),
    });
  });
});

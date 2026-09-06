import { describe, expect, it } from 'vitest';
import { serializeSeedance, serializeSeedream, type WorkflowSpec } from '../src/index';

const baseImage: WorkflowSpec = {
  modelId: 'seedream-4-5',
  providerModelId: 'seedream-4-5',
  providerEndpoint: '/api/v3/images/generations',
  kind: 'image',
  prompt: 'космонавт на коне',
  params: { size: '1024x1024', n: 1 },
  referenceAssets: [],
  maxDurationSeconds: null,
};

const baseVideo: WorkflowSpec = {
  modelId: 'seedance-2-0',
  providerModelId: 'seedance-2-0',
  providerEndpoint: '/api/v3/videos/generations',
  kind: 'video',
  prompt: 'pan over mountains',
  params: { duration_seconds: 5, resolution: '720p', aspect_ratio: '16:9' },
  referenceAssets: [],
  maxDurationSeconds: 10,
};

describe('serializeSeedream', () => {
  it('produces a minimal body for a basic T2I call', () => {
    const body = serializeSeedream(baseImage);
    expect(body).toEqual({
      model: 'seedream-4-5',
      prompt: 'космонавт на коне',
      size: '1024x1024',
      n: 1,
    });
  });

  it('includes seed + guidance_scale when supplied', () => {
    const body = serializeSeedream({
      ...baseImage,
      params: { size: '2048x2048', n: 2, seed: 42, guidance_scale: 7.5 },
    });
    expect(body.seed).toBe(42);
    expect(body.guidance_scale).toBe(7.5);
    expect(body.n).toBe(2);
  });

  it('passes referenceAssets through on image-edit kind', () => {
    const body = serializeSeedream({
      ...baseImage,
      kind: 'image-edit',
      referenceAssets: ['https://example.test/ref.png'],
    });
    expect(body.image).toEqual(['https://example.test/ref.png']);
  });

  it('throws on bad size format', () => {
    expect(() => serializeSeedream({ ...baseImage, params: { size: 'huge' } })).toThrow();
  });
});

describe('serializeSeedance', () => {
  it('caps duration_seconds at the model max', () => {
    const body = serializeSeedance({
      ...baseVideo,
      maxDurationSeconds: 5,
      params: { ...baseVideo.params, duration_seconds: 9 },
    });
    expect(body.duration_seconds).toBe(5);
  });

  it('passes referenceAssets[0] as image_url', () => {
    const body = serializeSeedance({
      ...baseVideo,
      referenceAssets: ['https://example.test/start.png'],
    });
    expect(body.image_url).toBe('https://example.test/start.png');
  });
});

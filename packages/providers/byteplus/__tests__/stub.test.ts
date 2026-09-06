import { describe, expect, it } from 'vitest';
import { StubBytePlusAdapter, type WorkflowSpec } from '../src/index';

const spec: WorkflowSpec = {
  modelId: 'seedream-4-5',
  providerModelId: 'seedream-4-5',
  providerEndpoint: '/api/v3/images/generations',
  kind: 'image',
  prompt: 'test',
  params: { size: '1024x1024' },
  referenceAssets: [],
  maxDurationSeconds: null,
};

describe('StubBytePlusAdapter', () => {
  it('returns a prompt-derived SVG preview for image kind via inline handle', async () => {
    const stub = new StubBytePlusAdapter();
    const handle = await stub.generate(spec);
    expect(handle.providerJobId).toMatch(/^stub-img-/);
    expect(handle.inlineResult?.assets).toHaveLength(1);
    const asset = handle.inlineResult!.assets[0]!;
    expect(asset.contentType).toBe('image/svg+xml');
    expect(asset.extension).toBe('svg');
    expect(asset.bytes.byteLength).toBeGreaterThan(0);
    const svg = asset.bytes.toString('utf8');
    expect(svg).toContain('<svg');
    // Honestly labelled as a stub preview, not passed off as real output.
    expect(svg).toContain('превью');
  });

  it('produces a DIFFERENT image for a different prompt (feels alive, not frozen)', async () => {
    const stub = new StubBytePlusAdapter();
    const a = await stub.generate({ ...spec, prompt: 'кот в шапке' });
    const b = await stub.generate({ ...spec, prompt: 'питерская крыша на закате' });
    const svgA = a.inlineResult!.assets[0]!.bytes.toString('utf8');
    const svgB = b.inlineResult!.assets[0]!.bytes.toString('utf8');
    expect(svgA).not.toBe(svgB);
  });

  it('is deterministic — the same prompt yields the same image', async () => {
    const stub = new StubBytePlusAdapter();
    const a = await stub.generate({ ...spec, prompt: 'одинаковый промпт' });
    const b = await stub.generate({ ...spec, prompt: 'одинаковый промпт' });
    const svgA = a.inlineResult!.assets[0]!.bytes.toString('utf8');
    const svgB = b.inlineResult!.assets[0]!.bytes.toString('utf8');
    expect(svgA).toBe(svgB);
  });

  it('returns an MP4 asset for video kind via awaitResult', async () => {
    const stub = new StubBytePlusAdapter();
    const vspec: WorkflowSpec = { ...spec, kind: 'video', maxDurationSeconds: 5 };
    const handle = await stub.generate(vspec);
    expect(handle.inlineResult).toBeUndefined();
    const result = await stub.awaitResult(handle, vspec);
    expect(result.assets[0]!.contentType).toBe('video/mp4');
    expect(result.assets[0]!.extension).toBe('mp4');
  });
});

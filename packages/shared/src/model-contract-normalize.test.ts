import { describe, expect, it } from 'vitest';
import { contractForGateway, normalizeVideoParams } from './model-contract';
import { byteplusRouteContracts } from './model-contract-byteplus';

/**
 * Spec for the registry-driven video-param normalizer (execution plan Phase 2).
 * This defines the CORRECTED snap/floor/reject semantics that adapters + the
 * billing selector will both adopt — notably duration uses ceil (billing parity),
 * so these expectations are the target contract, not a mirror of today's adapters.
 */
const route = (modelId: string, gateway: string) =>
  contractForGateway(byteplusRouteContracts[modelId]!, gateway as never)!;

describe('normalizeVideoParams — Seedance on OpenRouter (primary)', () => {
  const c = route('seedance-2-0', 'openrouter');

  it('passes a valid resolution/aspect through and ceils duration', () => {
    const r = normalizeVideoParams(c, {
      resolution: '1080p',
      aspect_ratio: '9:16',
      duration_seconds: 6.2,
    });
    expect(r).toEqual({
      ok: true,
      value: { resolution: '1080p', aspectRatio: '9:16', duration: 7, generateAudio: true },
    });
  });

  it('defaults an off-menu resolution and omits an off-menu aspect', () => {
    const r = normalizeVideoParams(c, {
      resolution: '2160p',
      aspect_ratio: '5:4',
      duration_seconds: 5,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.resolution).toBe('720p'); // onInvalid 'default'
    expect(r.value.aspectRatio).toBeUndefined(); // onInvalid 'omit'
  });

  it('floors a sub-minimum duration to the vendor floor', () => {
    const r = normalizeVideoParams(c, { duration_seconds: 1 });
    expect(r.ok && r.value.duration).toBe(4);
  });

  it('exposes a generate_audio control (togglable off)', () => {
    const r = normalizeVideoParams(c, { duration_seconds: 5, generate_audio: false });
    expect(r.ok && r.value.generateAudio).toBe(false);
  });
});

describe('normalizeVideoParams — Wan on kie (primary)', () => {
  const c = route('wan-2-7', 'kie');

  it('honors an intermediate duration and defaults 720p→1080p order', () => {
    const r = normalizeVideoParams(c, {
      resolution: '720p',
      aspect_ratio: '1:1',
      duration_seconds: 7,
    });
    expect(r).toEqual({ ok: true, value: { resolution: '720p', aspectRatio: '1:1', duration: 7 } });
  });

  it('rejects an over-maximum duration rather than clamp (charge==deliver)', () => {
    const r = normalizeVideoParams(c, { duration_seconds: 12 });
    expect(r.ok).toBe(false);
  });

  it('defaults an off-enum aspect to 16:9 and never exposes an audio control', () => {
    const r = normalizeVideoParams(c, { aspect_ratio: '4:3', duration_seconds: 4 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.aspectRatio).toBe('16:9'); // wanAspectRatio validates → default
    expect(r.value.generateAudio).toBeUndefined(); // output audio, no control
  });
});

describe('normalizeVideoParams — Veo on kie (aspect snap + 4K reject)', () => {
  const c = route('veo-3-1', 'kie');

  it('rejects a 4K resolution (per-value guard, never a silent downgrade)', () => {
    expect(normalizeVideoParams(c, { resolution: '4K', duration_seconds: 8 }).ok).toBe(false);
    expect(normalizeVideoParams(c, { resolution: '4k', duration_seconds: 8 }).ok).toBe(false);
  });

  it('snaps an off-menu aspect to the nearer orientation', () => {
    const landscape = normalizeVideoParams(c, { aspect_ratio: '4:3', duration_seconds: 8 });
    expect(landscape.ok && landscape.value.aspectRatio).toBe('16:9');
    const portrait = normalizeVideoParams(c, { aspect_ratio: '3:4', duration_seconds: 8 });
    expect(portrait.ok && portrait.value.aspectRatio).toBe('9:16');
    const square = normalizeVideoParams(c, { aspect_ratio: '1:1', duration_seconds: 8 });
    expect(square.ok && square.value.aspectRatio).toBe('16:9'); // omniAspectRatio: square → landscape
  });

  it('defaults an off-menu (non-4K) resolution to 720p', () => {
    const r = normalizeVideoParams(c, { resolution: '480p', duration_seconds: 8 });
    expect(r.ok && r.value.resolution).toBe('720p');
  });
});

describe('normalizeVideoParams — Seedance on kie (fallback)', () => {
  const c = route('seedance-2-0', 'kie');

  it('passes an off-enum aspect through unchanged (kie passthrough)', () => {
    const r = normalizeVideoParams(c, { aspect_ratio: '5:4', duration_seconds: 5 });
    expect(r.ok && r.value.aspectRatio).toBe('5:4');
  });

  it('accepts an intermediate duration (no OpenRouter-style snap)', () => {
    const r = normalizeVideoParams(c, { duration_seconds: 9 });
    expect(r.ok && r.value.duration).toBe(9);
  });
});

import { describe, expect, it } from 'vitest';
import { assetLifecyclePresentation, type ResolvedAsset } from './asset-lifecycle';

const available = (expiresAt: string | null): ResolvedAsset => ({
  id: 'asset-1',
  available: true,
  assetUrl: 'https://assets.seed.local/current.mp4',
  thumbnailUrl: null,
  kind: 'video',
  title: 'Клип',
  expiresAt,
});

describe('identified media lifecycle presentation', () => {
  it('shows retention only for finite storage and gates it off for permanent storage', () => {
    expect(assetLifecyclePresentation(available('2026-08-01T00:00:00.000Z'))).toEqual({
      kind: 'finite',
      expiresAt: '2026-08-01T00:00:00.000Z',
    });
    expect(assetLifecyclePresentation(available(null))).toEqual({ kind: 'permanent' });
  });

  it('fails closed while an id is missing, foreign, deleted, or unresolved', () => {
    expect(assetLifecyclePresentation({ id: 'asset-1', available: false })).toEqual({
      kind: 'unavailable',
    });
    expect(assetLifecyclePresentation(undefined)).toEqual({ kind: 'unavailable' });
  });
});

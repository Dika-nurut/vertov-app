// Guardrail for the multi-track model (research/archive/studio-multitrack-overlay-plan-2026-06.md).
// §B retired the lossy `overlays`/`TOverlay` projection: `tracks` is the sole
// canonical model and new rows persist as v2 `{tracks}`. What remains here is the
// READ-ONLY legacy hydrate — an old `{timeline, overlays}` blob must still load
// into the track stack with the overlay fields mapped onto the right clip fields.
import { describe, expect, it } from 'vitest';
import {
  BASE_TRACK_ID,
  hydrateTracks,
  legacyToTracks,
  normalizeClip,
  trackId,
  TRACKS_SCHEMA_VERSION,
} from '../app/studio/_tracks';
import type { TClip } from '../app/studio/_model';

/** The legacy persisted overlay shape (v1 blobs). Plain object — the `TOverlay`
 *  type was retired; only old on-disk rows ever carry this shape now. */
const overlay = (over: Record<string, unknown> = {}) => ({
  uid: 'o1',
  url: 'https://cdn/x.mp4',
  atSec: 3.5,
  inSec: 0.25,
  outSec: 4.75,
  scale: 0.35,
  posX: 28,
  posY: -24,
  opacity: 0.9,
  muted: true,
  gainDb: -6,
  ...over,
});

const baseClip = (over: Partial<TClip> = {}): TClip =>
  normalizeClip({ uid: 'c1', url: 'https://cdn/base.mp4', dur: 10, inSec: 0, outSec: 8, ...over });

describe('legacy overlay → upper-track clip mapping (read path)', () => {
  it('maps the overlay fields onto the right clip fields', () => {
    const c = legacyToTracks([], [overlay()])[1]!.clips[0]!;
    expect(c.startSec).toBe(3.5); // atSec → startSec
    expect(c.volumeDb).toBe(-6); // gainDb → volumeDb
    expect(c.muted).toBe(true);
    expect(c.opacity).toBe(0.9);
    expect(c.transform).toEqual({
      scale: 0.35,
      posX: 28,
      posY: -24,
      rotate: 0,
      crop: { left: 0, top: 0, right: 0, bottom: 0 },
    });
    expect(c.transition).toBe('cut'); // gains the full clip default set
  });

  it('handles a range of geometries / gains / opacities', () => {
    for (const o of [
      overlay({ scale: 1, posX: 0, posY: 0, opacity: 1, gainDb: 0, muted: false }),
      overlay({ scale: 0.1, posX: -40, posY: 40, opacity: 0.5, gainDb: 12 }),
      overlay({ atSec: 0, inSec: 0, outSec: 1 }),
    ]) {
      const c = legacyToTracks([], [o])[1]!.clips[0]!;
      expect(c.startSec).toBe(o.atSec);
      expect(c.transform!.scale).toBe(o.scale);
      expect(c.volumeDb).toBe(o.gainDb);
    }
  });
});

describe('legacy {timeline, overlays} → tracks', () => {
  it('builds base track 0 + overlay track 1', () => {
    const tracks = legacyToTracks([baseClip()], [overlay()]);
    expect(tracks).toHaveLength(2);
    expect(tracks[0]!.id).toBe(BASE_TRACK_ID);
    expect(tracks[0]!.clips).toHaveLength(1);
    expect(tracks[1]!.clips).toHaveLength(1);
  });

  it('omits the overlay track when there are no overlays', () => {
    const tracks = legacyToTracks([baseClip()], []);
    expect(tracks).toHaveLength(1);
    expect(tracks[0]!.id).toBe(BASE_TRACK_ID);
  });

  it('always yields a base track even when empty', () => {
    expect(legacyToTracks([], [])).toEqual([{ id: BASE_TRACK_ID, kind: 'video', clips: [] }]);
  });
});

describe('hydrateTracks accepts either persisted shape', () => {
  it('hydrates a legacy {timeline, overlays} blob', () => {
    const tracks = hydrateTracks({ timeline: [baseClip()], overlays: [overlay()] });
    expect(tracks).toHaveLength(2);
    expect(tracks[1]!.clips[0]!.startSec).toBe(3.5);
  });

  it('hydrates a v2 {tracks} blob and re-normalizes partial clips', () => {
    const tracks = hydrateTracks({
      tracks: [{ id: trackId(0), clips: [{ uid: 'c1', url: 'u', dur: 5, inSec: 0, outSec: 5 }] }],
    });
    expect(tracks[0]!.clips[0]!.speed).toBe(1); // default filled
    expect(tracks[0]!.clips[0]!.transition).toBe('cut');
  });

  it('preserves stable gallery identity and keeps legacy URL-only clips loadable', () => {
    const identified = hydrateTracks({
      tracks: [
        {
          id: trackId(0),
          clips: [
            {
              uid: 'identified',
              url: 'https://assets.seed.local/snapshot.mp4',
              assetId: 'gallery-stable-id',
            },
          ],
        },
      ],
    });
    expect(identified[0]!.clips[0]).toMatchObject({
      url: 'https://assets.seed.local/snapshot.mp4',
      assetId: 'gallery-stable-id',
    });
    expect(normalizeClip({ uid: 'legacy', url: 'https://external.example/clip.mp4' }).assetId).toBe(
      undefined,
    );
  });

  it('carries track lock/hide flags through hydration', () => {
    const tracks = hydrateTracks({
      tracks: [
        { id: trackId(0), clips: [], hidden: true },
        { id: trackId(1), clips: [], locked: true },
      ],
    });
    expect(tracks[0]!.hidden).toBe(true);
    expect(tracks[1]!.locked).toBe(true);
  });

  it('falls back to an empty base track for an empty blob', () => {
    expect(hydrateTracks({})).toEqual([{ id: BASE_TRACK_ID, kind: 'video', clips: [] }]);
  });

  it('exposes a stable schema version', () => {
    expect(TRACKS_SCHEMA_VERSION).toBe(2);
  });

  it('backfills a uid for a malformed or legacy clip that has none', () => {
    const tracks = hydrateTracks({
      tracks: [{ id: trackId(0), clips: [{ url: 'u', dur: 5, inSec: 0, outSec: 5 }] }],
    });

    const uid = tracks[0]!.clips[0]!.uid;
    expect(typeof uid).toBe('string');
    expect(uid.length).toBeGreaterThan(0);
  });

  it('preserves an existing clip uid', () => {
    expect(normalizeClip({ uid: 'keep-me', url: 'u' }).uid).toBe('keep-me');
  });
});

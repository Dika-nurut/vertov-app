// Studio editor — generic multi-track timeline model (Phase 0 of the
// multi-track / CapCut-parity-overlay plan, research/archive/studio-multitrack-overlay-plan-2026-06.md).
//
// Today the editor splits footage into `timeline: TClip[]` (the base track) and a
// second-class `overlays: TOverlay[]` array (picture-in-picture). The target is a
// single generic model: `tracks: Track[]`, where track 0 is the base (sequential
// layout, transitions, ripple) and tracks 1..N stack upward — and an "overlay" is
// just an ordinary `TClip` on an upper track, inheriting every clip capability.
//
// This module is the data-model seam: the `Track` type plus PURE serializers that
// convert between the legacy `{timeline, overlays}` shape and `Track[]`, and back.
// It is deliberately runtime-dependency-free (it imports only TYPES from `_model`,
// which erase at compile time) so it unit-tests in a plain node env without pulling
// React / icon modules. Nothing imports it yet — wiring is Phase 1.
//
// Positioning model (plan §6 decision 1): the base track stays SEQUENTIAL (clips
// laid end-to-end, the deeply-wired transition/ripple/snap machinery is unchanged);
// clips on upper tracks are ABSOLUTELY placed via `TClip.startSec`. Lowest blast
// radius — base playback/layout code needs no change.
import type { TClip, TTransform } from './_model';

/** The legacy persisted PiP-overlay shape (v1 `{timeline, overlays}` blobs).
 *  Retained ONLY so old rows still hydrate — new rows are v2 `{tracks}`. The
 *  canonical model is a `TClip` on an upper track; this is just the on-disk
 *  shape the read path maps FROM. */
interface LegacyOverlay {
  uid: string;
  url: string;
  atSec: number;
  inSec: number;
  outSec: number;
  scale: number;
  posX: number;
  posY: number;
  opacity?: number;
  muted?: boolean;
  gainDb?: number;
}

/** Current persisted-blob schema version. v1 = legacy `{timeline, overlays}`;
 *  v2 = `{tracks}`. The hydrator reads either; the serializer writes v2. */
export const TRACKS_SCHEMA_VERSION = 2;

/** A stack layer in the timeline. Track 0 is the base (sequential); tracks 1..N
 *  stack upward and composite on top (higher index = nearer the viewer). */
export interface Track {
  id: string;
  kind: 'video';
  /** Ordered. Base-track clips are sequential; upper-track clips use `startSec`. */
  clips: TClip[];
  locked?: boolean;
  hidden?: boolean;
}

export const BASE_TRACK_ID = 'track-0';

/** Stable id for the track at stack index `i` (0 = base). */
export const trackId = (i: number): string => (i === 0 ? BASE_TRACK_ID : `track-${i}`);

/** Identity transform built locally (avoids a runtime import of `_model`, which
 *  pulls the icon barrel). Mirrors DEFAULT_TRANSFORM. */
const identityTransform = (): TTransform => ({
  scale: 1,
  posX: 0,
  posY: 0,
  rotate: 0,
  crop: { left: 0, top: 0, right: 0, bottom: 0 },
});

// Module-local fallback uid for hydration only. A legacy/imported/malformed clip
// without a uid otherwise reaches editor state keyed by `uid` and can crash the
// whole project surface. Keep this dependency-free so `_tracks` remains a pure
// data-model seam.
let hydrationUidCounter = 0;
const fallbackHydrationUid = (): string => `hy-${++hydrationUidCounter}`;

/** Fill a partially-specified clip (e.g. an old persisted blob) with the field
 *  defaults the editor expects. Mirrors the inline normalization that used to
 *  live in `useStudioProject` load. */
export function normalizeClip(c: Partial<TClip>): TClip {
  return {
    speed: 1,
    muted: false,
    volumeDb: 0,
    transition: 'cut',
    transitionSec: 0.5,
    filter: 'none',
    ...c,
    uid: c.uid ?? fallbackHydrationUid(),
  } as TClip;
}

/** Map a legacy persisted PiP overlay onto a clip for an upper track. The
 *  overlay's absolute `atSec` becomes the clip's `startSec`; its scale/posX/posY
 *  become a `transform`; `gainDb` maps to `volumeDb`. READ-ONLY back-compat: this
 *  is how old `{timeline, overlays}` rows hydrate into the canonical track model. */
function overlayToClip(o: LegacyOverlay): TClip {
  return normalizeClip({
    uid: o.uid,
    url: o.url,
    // overlays carry no source duration; the trimmed-out point is the best bound.
    dur: o.outSec,
    inSec: o.inSec,
    outSec: o.outSec,
    startSec: o.atSec,
    muted: o.muted ?? false,
    volumeDb: o.gainDb ?? 0,
    opacity: o.opacity ?? 1,
    transform: { ...identityTransform(), scale: o.scale, posX: o.posX, posY: o.posY },
  });
}

/** Build the track stack from the legacy `{timeline, overlays}` shape: track 0 is
 *  the base footage; track 1 holds the overlays mapped to clips. Empty input
 *  yields a single empty base track so the editor always has a base to add to. */
export function legacyToTracks(timeline: Partial<TClip>[], overlays: LegacyOverlay[]): Track[] {
  const tracks: Track[] = [{ id: trackId(0), kind: 'video', clips: timeline.map(normalizeClip) }];
  if (overlays.length > 0) {
    tracks.push({ id: trackId(1), kind: 'video', clips: overlays.map(overlayToClip) });
  }
  return tracks;
}

/** Hydrate either persisted shape into `Track[]`. Accepts a v2 `{tracks}` blob
 *  (clips re-normalized defensively) or a legacy `{timeline, overlays}` blob.
 *  Always returns at least one (base) track. */
export function hydrateTracks(blob: {
  tracks?: { id?: string; clips?: Partial<TClip>[]; locked?: boolean; hidden?: boolean }[];
  timeline?: Partial<TClip>[];
  overlays?: LegacyOverlay[];
}): Track[] {
  if (Array.isArray(blob.tracks) && blob.tracks.length > 0) {
    return blob.tracks.map((t, i) => ({
      id: t.id ?? trackId(i),
      kind: 'video',
      clips: Array.isArray(t.clips) ? t.clips.map(normalizeClip) : [],
      ...(t.locked ? { locked: true } : {}),
      ...(t.hidden ? { hidden: true } : {}),
    }));
  }
  return legacyToTracks(
    Array.isArray(blob.timeline) ? blob.timeline : [],
    Array.isArray(blob.overlays) ? blob.overlays : [],
  );
}

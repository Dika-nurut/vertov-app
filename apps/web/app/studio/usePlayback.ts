// Studio transport (extracted from StudioClient.tsx, split 5k/N). Owns the
// playhead/playing state, the rAF playback loop, the imperative per-frame
// media sync, and scrub/togglePlay — plus the 4 media-element ref maps, which
// it returns so the preview JSX can attach to them. Project inputs are
// injected; clipWindow stays in StudioClient (shared with clipVisual). The
// move is verbatim — same loop/sync/timing relocated behind a hook seam.
import { useCallback, useEffect, useRef, useState } from 'react';
import { clipRateAt, clipSourceT, dbToLin, mediaFadeGain } from './_model';
import type { TAudio, TClip, TSfx } from './_model';
import { DUCK_ATTACK_SEC, DUCK_RELEASE_SEC, duckGainDbAt } from '../../lib/ducking';

export function usePlayback({
  timeline,
  upperClips,
  music,
  voiceover,
  sfx,
  totalDur,
  clipWindow,
}: {
  timeline: TClip[];
  /** PiP/overlay clips on upper tracks (track 1..N), absolutely placed by startSec. */
  upperClips: TClip[];
  music: TAudio | null;
  voiceover: TAudio | null;
  /** Timed sound-effect clips, each played within [atSec, atSec+clipDur]. */
  sfx: TSfx[];
  totalDur: number;
  clipWindow: (i: number) => { start: number; end: number };
}) {
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const videoEls = useRef(new Map<string, HTMLVideoElement>());
  const ovEls = useRef(new Map<string, HTMLVideoElement>());
  const musicEl = useRef<HTMLAudioElement | null>(null);
  const voEl = useRef<HTMLAudioElement | null>(null);
  // One <audio> per SFX (keyed by uid), attached by the preview like videoEls.
  const sfxEls = useRef(new Map<string, HTMLAudioElement>());
  const playheadRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const lastWall = useRef(0);
  const lastStateSync = useRef(0);

  /** Imperative per-frame media sync (seek/play/pause/volume). */
  const syncMedia = useCallback(
    (t: number, isPlaying: boolean) => {
      timeline.forEach((c, i) => {
        const el = videoEls.current.get(c.uid);
        if (!el) return;
        const { start, end } = clipWindow(i);
        const inWindow = t >= start - 0.05 && t < end;
        if (!inWindow) {
          if (!el.paused) el.pause();
          return;
        }
        const sourceT = clipSourceT(c, t - start);
        // freeze/reversed can't free-run forward — hold paused and seek
        // (reversed previews as a stepped seek; render plays it smoothly)
        const stepped = Boolean(c.freeze || c.reversed);
        if (Math.abs(el.currentTime - sourceT) > (stepped ? 0.04 : 0.18)) {
          el.currentTime = sourceT;
        }
        el.playbackRate = clipRateAt(c, t - start);
        el.volume = c.muted ? 0 : dbToLin(c.volumeDb);
        if (isPlaying && el.paused && !stepped) void el.play().catch(() => {});
        if ((!isPlaying || stepped) && !el.paused) el.pause();
      });
      // E8/III: PiP overlay clips on upper tracks — seek/play within their window
      for (const c of upperClips) {
        const el = ovEls.current.get(c.uid);
        if (!el) continue;
        const at0 = c.startSec ?? 0;
        const len = Math.max(0.1, c.outSec - c.inSec);
        const inWindow = t >= at0 && t < at0 + len;
        if (!inWindow) {
          if (!el.paused) el.pause();
          continue;
        }
        const at = c.inSec + (t - at0);
        if (Math.abs(el.currentTime - at) > 0.18) el.currentTime = at;
        el.volume = c.muted ? 0 : dbToLin(c.volumeDb);
        if (isPlaying && el.paused) void el.play().catch(() => {});
        if (!isPlaying && !el.paused) el.pause();
      }
      for (const [track, el] of [
        [music, musicEl.current],
        [voiceover, voEl.current],
      ] as const) {
        if (!el) continue;
        if (!track || t < track.fromSec || t >= totalDur) {
          if (!el.paused) el.pause();
          continue;
        }
        const at = t - track.fromSec;
        if (Math.abs(el.currentTime - at) > 0.25) el.currentTime = at;
        // Auto-ducking (music only): dip under voiceover speech. dbToLin clamps at
        // 1 — fine, ducking only subtracts. Mirrors the worker's volume expr.
        const duckDb = track.duck
          ? duckGainDbAt(t, track.duck.segments, {
              duckDb: track.duck.db,
              attackSec: DUCK_ATTACK_SEC,
              releaseSec: DUCK_RELEASE_SEC,
            })
          : 0;
        // fadeIn/fadeOut ride on top of gain+duck to mirror the worker's afades
        // (studio-graph.ts addTrack) — without this the preview played full
        // volume through the 1s ramps while the export faded.
        el.volume =
          dbToLin(track.gainDb + duckDb) *
          mediaFadeGain(t, track.fromSec, totalDur, track.fadeIn, track.fadeOut);
        if (isPlaying && el.paused) void el.play().catch(() => {});
        if (!isPlaying && !el.paused) el.pause();
      }
      // Timed SFX — play each within [atSec, atSec+clipDur]; drift-corrected and
      // seek-corrected the same way music is. Window length falls back to the
      // element's own decoded duration when durSec isn't known yet.
      for (const s of sfx) {
        const el = sfxEls.current.get(s.uid);
        if (!el) continue;
        const clipDur =
          s.durSec ?? (Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 0);
        const end = clipDur > 0 ? s.atSec + clipDur : Infinity;
        if (t < s.atSec || t >= end || t >= totalDur) {
          if (!el.paused) el.pause();
          continue;
        }
        const at = t - s.atSec;
        if (Math.abs(el.currentTime - at) > 0.25) el.currentTime = at;
        el.volume = dbToLin(s.gainDb);
        if (isPlaying && el.paused) void el.play().catch(() => {});
        if (!isPlaying && !el.paused) el.pause();
      }
    },
    [timeline, clipWindow, upperClips, music, voiceover, sfx, totalDur],
  );

  // rAF transport loop.
  useEffect(() => {
    if (!playing) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      syncMedia(playheadRef.current, false);
      return;
    }
    lastWall.current = performance.now();
    const step = (now: number) => {
      const dt = (now - lastWall.current) / 1000;
      lastWall.current = now;
      let t = playheadRef.current + dt;
      if (t >= totalDur) {
        t = totalDur;
        playheadRef.current = t;
        setPlayhead(t);
        setPlaying(false);
        return;
      }
      playheadRef.current = t;
      syncMedia(t, true);
      // Throttle React state to ~30fps — the rAF math stays at 60.
      if (now - lastStateSync.current > 33) {
        lastStateSync.current = now;
        setPlayhead(t);
      }
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [playing, totalDur, syncMedia]);

  const scrub = useCallback(
    (t: number) => {
      const clamped = Math.max(0, Math.min(t, Math.max(0, totalDur)));
      playheadRef.current = clamped;
      setPlayhead(clamped);
      syncMedia(clamped, false);
    },
    [totalDur, syncMedia],
  );

  function togglePlay() {
    if (timeline.length === 0) return;
    if (!playing && playheadRef.current >= totalDur - 0.05) scrub(0);
    setPlaying((p) => !p);
  }

  return {
    playing,
    setPlaying,
    playhead,
    playheadRef,
    scrub,
    togglePlay,
    videoEls,
    ovEls,
    musicEl,
    voEl,
    sfxEls,
  };
}

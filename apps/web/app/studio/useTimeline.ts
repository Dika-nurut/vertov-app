// useTimeline — the studio's timeline INTERACTION layer (§C step 4 state-lift).
//
// Owns the interaction state (zoom/pps, per-lane locks, magnetic snap, hover,
// multi-selection, drag transients) and the timeline action handlers
// (select/split/freeze/duplicate/remove/keyframe-move, pointer drag-reorder,
// base-clip trim, overlay-block trim, text-block move/trim, scrub, zoom). The
// raw project data + undo/redo/save stay in `useStudioProject`; the rAF preview
// stays in `usePlayback`. This hook sits on top of both — it receives the data
// setters + the patch helpers + the playback bits it needs and returns the
// handlers/state the timeline UI consumes. Behaviour is identical to the inline
// version it replaced (verbatim move); the floor (prod-floor.sh) guards it.
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clipOutDur, clipSourceT } from './_model';
import type { TClip, TText, TAudio, Selection, TKeyframes, KfProp } from './_model';
import { rulerTicks } from './_timeline/ruler';
import { nextUid } from './_uid';
import { analyzeMusicBeats } from '../../lib/beat-detect';

export function useTimeline({
  timeline,
  setTimeline,
  selection,
  setSelection,
  patchClip,
  patchUpperClip,
  patchText,
  playhead,
  playheadRef,
  scrub,
  setPlaying,
  videoEls,
  clipStarts,
  totalDur,
  music,
}: {
  timeline: TClip[];
  setTimeline: React.Dispatch<React.SetStateAction<TClip[]>>;
  selection: Selection;
  setSelection: React.Dispatch<React.SetStateAction<Selection>>;
  patchClip: (uid: string, patch: Partial<TClip>) => void;
  patchUpperClip: (uid: string, patch: Partial<TClip>) => void;
  patchText: (uid: string, patch: Partial<TText>) => void;
  playhead: number;
  playheadRef: React.MutableRefObject<number>;
  scrub: (t: number) => void;
  setPlaying: React.Dispatch<React.SetStateAction<boolean>>;
  videoEls: React.RefObject<Map<string, HTMLVideoElement>>;
  clipStarts: number[];
  totalDur: number;
  /** The music track (if any) — its `fromSec` offset is what maps beat times
   * (relative to the file itself) onto the timeline. */
  music: TAudio | null;
}) {
  // S2: timeline zoom (px/sec). Replaces the old hardcoded PPS=28. Range tuned so
  // a 6s social clip and a 2-min edit both stay legible (CapCut spec §5.1 zoom group).
  const [pps, setPps] = useState(28);
  const ppsRef = useRef(28);
  // Once the user touches a zoom control we stop auto-fitting the timeline to
  // the viewport width (so we don't fight their manual scale).
  const userZoomed = useRef(false);
  // S2: per-lane lock (CapCut track header) — a locked lane ignores selection +
  // drag so you can't nudge a finished track. UI-only, never serialized.
  const [lockedTracks, setLockedTracks] = useState<Set<string>>(() => new Set());
  const isLocked = useCallback((id: string) => lockedTracks.has(id), [lockedTracks]);
  const toggleLock = useCallback(
    (id: string) =>
      setLockedTracks((s) => {
        const n = new Set(s);
        if (n.has(id)) n.delete(id);
        else n.add(id);
        return n;
      }),
    [],
  );
  // S2: magnetic snap — playhead/overlay drags pull to cut points + bounds.
  const [snapOn, setSnapOn] = useState(true);
  // Beat markers (§ beat-detect): analyzed once per music URL and cached, so
  // toggling off/on doesn't re-decode the file. Beat times are relative to the
  // music FILE (t=0 at its own start) — `music.fromSec` maps them onto the
  // timeline wherever the callers need that (rendering, snapping).
  const [beatsOn, setBeatsOn] = useState(false);
  const [beats, setBeats] = useState<number[]>([]);
  const [bpm, setBpm] = useState<number | null>(null);
  const [beatBusy, setBeatBusy] = useState(false);
  const beatCache = useRef<Map<string, { beats: number[]; bpm: number | null }>>(new Map());
  // Read inside the async completion below, so an in-flight analyze() that
  // outlives a track swap can tell its result is stale (music is a plain param,
  // not a ref, so a memoized closure over it would go stale between renders).
  const musicRef = useRef(music);
  musicRef.current = music;
  const toggleBeats = useCallback(
    (musicUrl: string | null) => {
      if (beatsOn) {
        setBeatsOn(false);
        setBeats([]);
        setBpm(null);
        return;
      }
      if (!musicUrl) return;
      const cached = beatCache.current.get(musicUrl);
      if (cached) {
        setBeats(cached.beats);
        setBpm(cached.bpm);
        setBeatsOn(true);
        return;
      }
      setBeatBusy(true);
      analyzeMusicBeats(musicUrl)
        .then((result) => {
          beatCache.current.set(musicUrl, result);
          // Bail if the music track changed while this decode was in flight —
          // applying it now would show beats for a track that's no longer loaded.
          if (musicRef.current?.url !== musicUrl) return;
          setBeats(result.beats);
          setBpm(result.bpm);
          setBeatsOn(true);
        })
        .catch(() => {
          if (musicRef.current?.url !== musicUrl) return;
          setBeatsOn(false);
        })
        .finally(() => setBeatBusy(false));
    },
    [beatsOn],
  );
  // Track changed → cached beats/bpm for the old url are no longer relevant to
  // this timeline (re-toggling the new track re-analyzes or hits its own cache
  // entry); clear rather than leaving stale markers visible.
  const prevMusicUrl = useRef(music?.url);
  useEffect(() => {
    if (music?.url !== prevMusicUrl.current) {
      prevMusicUrl.current = music?.url;
      setBeatsOn(false);
      setBeats([]);
      setBpm(null);
    }
  }, [music?.url]);
  // §6: which timeline clip is hovered → drives its per-clip hover toolbar.
  // JS-state (not CSS :hover) so the toolbar is deterministic to drive/verify.
  const [hoverClip, setHoverClip] = useState<string | null>(null);
  // §6.3: timeline-seconds of the active snap guide-line (null = none). Set
  // while a trim/drag locks onto a target; cleared on pointer-up.
  const [snapGuide, setSnapGuide] = useState<number | null>(null);
  // §6.5: live drag-reorder — the dragged clip's pixel offset + the insertion
  // gap (others-space index + its timeline position for the guide line).
  const [reorderDrag, setReorderDrag] = useState<{
    uid: string;
    dx: number;
    insertIdx: number;
    lineSec: number;
  } | null>(null);
  // suppresses the click a drag emits (so a reorder doesn't also re-select).
  const reorderMoved = useRef(false);
  // §6.4: multi-selected video clips (Shift = range, ⌘/Ctrl = toggle). Always
  // contains the primary `selection` clip; Del ripples them all out (the gapless
  // lane closes the gap on its own).
  const [multiSel, setMultiSel] = useState<Set<string>>(new Set());

  const moveKeyframe = (uid: string, oldT: number, newT: number) =>
    setTimeline((tl) =>
      tl.map((c) => {
        if (c.uid !== uid || !c.keyframes) return c;
        const next: TKeyframes = {};
        (Object.keys(c.keyframes) as KfProp[]).forEach((p) => {
          const arr = c.keyframes![p];
          if (arr) next[p] = arr.map((k) => (Math.abs(k.t - oldT) < 0.01 ? { ...k, t: newT } : k));
        });
        return { ...c, keyframes: next };
      }),
    );

  const removeClip = useCallback((uid: string) => {
    setTimeline((tl) => tl.filter((c) => c.uid !== uid));
    setSelection((s) => (s?.kind === 'clip' && s.uid === uid ? null : s));
    videoEls.current.delete(uid);
  }, []);

  // §6.4: keep the multi-selection in lockstep with the primary selection — any
  // single-clip select (a plain click, addClip, dup, …) collapses it to that
  // clip; deselecting clears it. The multi-click handler adds to the set BEFORE
  // moving the primary, so a genuine multi-pick (primary ∈ set) survives this.
  useEffect(() => {
    if (selection?.kind === 'clip') {
      setMultiSel((prev) => (prev.has(selection.uid) ? prev : new Set([selection.uid])));
    } else {
      setMultiSel((prev) => (prev.size ? new Set() : prev));
    }
  }, [selection]);

  /** §6.4: click-select a clip with CapCut modifiers — Shift = range from the
   * primary, ⌘/Ctrl = toggle, plain = single. */
  const selectClipAt = (
    e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean },
    i: number,
  ) => {
    const uid = timeline[i]?.uid;
    if (!uid) return;
    if (e.shiftKey && selection?.kind === 'clip') {
      const a = timeline.findIndex((x) => x.uid === selection.uid);
      const [lo, hi] = a < i ? [a, i] : [i, a];
      setMultiSel(new Set(timeline.slice(lo, hi + 1).map((x) => x.uid)));
      setSelection({ kind: 'clip', uid });
    } else if (e.metaKey || e.ctrlKey) {
      const next = new Set(multiSel);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      setMultiSel(next);
      if (next.has(uid)) setSelection({ kind: 'clip', uid });
      else {
        const any = [...next][0];
        setSelection(any ? { kind: 'clip', uid: any } : null);
      }
    } else {
      setMultiSel(new Set([uid]));
      setSelection({ kind: 'clip', uid });
    }
  };

  /** §6.4: ripple-delete every selected clip at once. The lane is gapless, so
   * removing them slides the survivors together with no gap to close. */
  const deleteSelectedClips = useCallback(() => {
    setMultiSel((sel) => {
      if (sel.size === 0) return sel;
      setTimeline((tl) => tl.filter((c) => !sel.has(c.uid)));
      sel.forEach((uid) => videoEls.current.delete(uid));
      setSelection(null);
      return new Set();
    });
  }, []);

  /** Duplicate a clip in place (CapCut Ctrl+D / floating-toolbar copy) — clone
   * right after the original and select the copy. */
  const duplicateClip = useCallback((uid: string) => {
    setTimeline((tl) => {
      const i = tl.findIndex((c) => c.uid === uid);
      if (i < 0) return tl;
      const copy = { ...tl[i]!, uid: nextUid() };
      // select the copy so the inspector/canvas follow it (CapCut behaviour).
      setSelection({ kind: 'clip', uid: copy.uid });
      return [...tl.slice(0, i + 1), copy, ...tl.slice(i + 1)];
    });
  }, []);

  /** Split the clip under the playhead at the playhead (CapCut 'S'). */
  const splitAtPlayhead = useCallback(() => {
    const t = playheadRef.current;
    setTimeline((tl) => {
      let acc = 0;
      for (let i = 0; i < tl.length; i++) {
        const c = tl[i]!;
        const dur = clipOutDur(c);
        const overlap = i < tl.length - 1 && c.transition !== 'cut' ? c.transitionSec : 0;
        if (t > acc + 0.15 && t < acc + dur - 0.15) {
          const sourceAt = c.inSec + (t - acc) * c.speed;
          const left: TClip = { ...c, outSec: sourceAt, transition: 'cut', transitionSec: 0.5 };
          const right: TClip = { ...c, uid: nextUid(), inSec: sourceAt };
          return [...tl.slice(0, i), left, right, ...tl.slice(i + 1)];
        }
        acc += dur - overlap;
      }
      return tl;
    });
  }, []);

  /** E4: freeze-frame — split at the playhead and slot a 3s still of the
   * current frame between the halves (CapCut's freeze gesture). */
  const freezeAtPlayhead = useCallback(() => {
    const t = playheadRef.current;
    setTimeline((tl) => {
      let acc = 0;
      for (let i = 0; i < tl.length; i++) {
        const c = tl[i]!;
        const dur = clipOutDur(c);
        const overlap = i < tl.length - 1 && c.transition !== 'cut' ? c.transitionSec : 0;
        if (t >= acc && t < acc + dur && !c.freeze) {
          const sourceAt = clipSourceT(c, t - acc);
          const still: TClip = {
            ...c,
            uid: nextUid(),
            freeze: { atSec: sourceAt, durSec: 3 },
            transition: 'cut',
            transitionSec: 0.5,
            muted: true,
          };
          if (t > acc + 0.15 && t < acc + dur - 0.15) {
            const left: TClip = { ...c, outSec: sourceAt, transition: 'cut', transitionSec: 0.5 };
            const right: TClip = { ...c, uid: nextUid(), inSec: sourceAt };
            return [...tl.slice(0, i), left, still, right, ...tl.slice(i + 1)];
          }
          return [...tl.slice(0, i + 1), still, ...tl.slice(i + 1)];
        }
        acc += dur - overlap;
      }
      return tl;
    });
  }, []);

  /** §6.5: where would the dragged clip drop, given the pointer's timeline time?
   * Computed over the OTHER clips (the dragged one removed) so the insertion gap
   * and its guide-line are accurate. `insertIdx` is in others-space; `lineSec` is
   * the gap's timeline position. */
  const computeInsert = (uid: string, t: number): { insertIdx: number; lineSec: number } => {
    const others = timeline.filter((c) => c.uid !== uid);
    let acc = 0;
    for (let i = 0; i < others.length; i++) {
      const w = clipOutDur(others[i]!);
      if (t < acc + w / 2) return { insertIdx: i, lineSec: acc };
      acc += w;
    }
    return { insertIdx: others.length, lineSec: acc };
  };

  /** §6.5: drop the dragged clip into an others-space index (already excludes
   * the clip), so a reorder is a clean splice with no index bookkeeping. */
  const moveClipToIndex = (uid: string, insertIdx: number) =>
    setTimeline((tl) => {
      const moved = tl.find((c) => c.uid === uid);
      if (!moved) return tl;
      const others = tl.filter((c) => c.uid !== uid);
      const dest = Math.max(0, Math.min(others.length, insertIdx));
      others.splice(dest, 0, moved);
      return others;
    });

  /** Timeline seconds under a viewport X (scroll-aware) — shared by reorder. */
  const timeFromClientX = (clientX: number): number => {
    const scroller = scrollerRef.current;
    if (!scroller) return 0;
    const rect = scroller.getBoundingClientRect();
    return Math.max(0, (clientX - rect.left + scroller.scrollLeft) / pps);
  };

  /** §6.5: begin a pointer-based clip drag-reorder. Activates only past a small
   * threshold (so a tap still selects); ghosts the clip + shows an insertion gap
   * line; commits the move on release. Replaces the old native-DnD swap. */
  const startReorder = (e: React.PointerEvent, uid: string) => {
    if (isLocked('video')) return;
    const startX = e.clientX;
    let active = false;
    const move = (ev: PointerEvent) => {
      if (!active && Math.abs(ev.clientX - startX) < 4) return;
      active = true;
      reorderMoved.current = true;
      const { insertIdx, lineSec } = computeInsert(uid, timeFromClientX(ev.clientX));
      setReorderDrag({ uid, dx: ev.clientX - startX, insertIdx, lineSec });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (active) {
        const { insertIdx } = computeInsert(uid, timeFromClientX(ev.clientX));
        moveClipToIndex(uid, insertIdx);
        // let the synthetic click fire and be swallowed, then re-arm selection
        setTimeout(() => (reorderMoved.current = false), 0);
      }
      setReorderDrag(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /* ---------- trim handles (pointer drag on selected clip edges) ---------- */
  const trimDrag = useRef<{
    uid: string;
    edge: 'in' | 'out';
    startX: number;
    startVal: number;
  } | null>(null);
  function onTrimPointerDown(e: React.PointerEvent, c: TClip, edge: 'in' | 'out') {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    trimDrag.current = {
      uid: c.uid,
      edge,
      startX: e.clientX,
      startVal: edge === 'in' ? c.inSec : c.outSec,
    };
  }
  function onTrimPointerMove(e: React.PointerEvent) {
    const d = trimDrag.current;
    if (!d) return;
    const clip = timeline.find((c) => c.uid === d.uid);
    if (!clip) return;
    // px → timeline seconds → SOURCE seconds (respect speed).
    const dSrc = ((e.clientX - d.startX) / pps) * clip.speed;
    if (d.edge === 'in') {
      // The left edge is pinned by the gapless layout (its start is fixed by the
      // prior clips), so there is no edge to snap a guide-line to here.
      setSnapGuide(null);
      patchClip(d.uid, {
        inSec: Math.min(Math.max(0, d.startVal + dSrc), clip.outSec - 0.2),
      });
    } else {
      let newOut = Math.max(Math.min(clip.dur, d.startVal + dSrc), clip.inSec + 0.2);
      // §6.3: snap the OUT edge's timeline position to the playhead / start / end
      // and draw a guide. The linear back-calc holds only for uniform speed.
      if (!clip.freeze && !clip.speedCurve) {
        const idx = timeline.findIndex((c) => c.uid === d.uid);
        const start = clipStarts[idx] ?? 0;
        const edgePos = start + (newOut - clip.inSec) / (clip.speed || 1);
        const snap = snapTimelineEdge(edgePos);
        setSnapGuide(snap.guide);
        if (snap.guide != null) {
          newOut = Math.max(
            Math.min(clip.dur, clip.inSec + (snap.sec - start) * (clip.speed || 1)),
            clip.inSec + 0.2,
          );
        }
      }
      patchClip(d.uid, { outSec: newOut });
    }
  }
  function onTrimPointerUp() {
    trimDrag.current = null;
    setSnapGuide(null);
  }

  /* ---------- overlay trim (pointer-capture pattern, like base clips) ----------
   * Window-listener drags don't fire reliably on a thin handle; the base-clip
   * trim uses setPointerCapture + React onPointerMove on the SAME element, so the
   * handle keeps receiving events as the pointer leaves it. Mirror that here. */
  const ovTrimDrag = useRef<{
    uid: string;
    edge: 'in' | 'out';
    startX: number;
    startIn: number;
    startOut: number;
    startAt: number;
  } | null>(null);
  function onOverlayTrimDown(e: React.PointerEvent, o: TClip, edge: 'in' | 'out') {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    ovTrimDrag.current = {
      uid: o.uid,
      edge,
      startX: e.clientX,
      startIn: o.inSec,
      startOut: o.outSec,
      startAt: o.startSec ?? 0,
    };
  }
  function onOverlayTrimMove(e: React.PointerEvent) {
    const d = ovTrimDrag.current;
    if (!d) return;
    const dSrc = (e.clientX - d.startX) / pps;
    if (d.edge === 'out') {
      const newOut = Math.max(
        d.startIn + 0.2,
        Math.min(d.startIn + 600, Math.round((d.startOut + dSrc) * 10) / 10),
      );
      patchUpperClip(d.uid, { outSec: newOut });
    } else {
      // Head-trim: shift startSec by the same amount so the visible content stays put.
      const newIn = Math.max(
        0,
        Math.min(d.startOut - 0.2, Math.round((d.startIn + dSrc) * 10) / 10),
      );
      const newAt = Math.max(0, Math.round((d.startAt + (newIn - d.startIn)) * 10) / 10);
      patchUpperClip(d.uid, { inSec: newIn, startSec: newAt });
    }
  }
  function onOverlayTrimUp() {
    ovTrimDrag.current = null;
  }

  /* ---------- text-block timeline edits (move + trim both edges) ----------
   * Titles were select-only on the tape; now they move + trim like clips. */
  function onTextMoveDown(e: React.PointerEvent, t: TText) {
    e.stopPropagation();
    setSelection({ kind: 'text', uid: t.uid });
    const startX = e.clientX;
    const startFrom = t.fromSec;
    const len = Math.max(0.2, t.toSec - t.fromSec);
    const move = (ev: PointerEvent) => {
      const raw = Math.max(0, Math.round((startFrom + (ev.clientX - startX) / pps) * 10) / 10);
      const from = snapSec(raw);
      setSnapGuide(snapOn && Math.abs(from - raw) > 1e-3 ? from : null);
      patchText(t.uid, { fromSec: from, toSec: Math.round((from + len) * 10) / 10 });
    };
    const up = () => {
      setSnapGuide(null);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
  const txTrimDrag = useRef<{
    uid: string;
    edge: 'from' | 'to';
    startX: number;
    startFrom: number;
    startTo: number;
  } | null>(null);
  function onTextTrimDown(e: React.PointerEvent, t: TText, edge: 'from' | 'to') {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    txTrimDrag.current = {
      uid: t.uid,
      edge,
      startX: e.clientX,
      startFrom: t.fromSec,
      startTo: t.toSec,
    };
  }
  function onTextTrimMove(e: React.PointerEvent) {
    const d = txTrimDrag.current;
    if (!d) return;
    const dt = (e.clientX - d.startX) / pps;
    if (d.edge === 'to') {
      patchText(d.uid, {
        toSec: Math.max(d.startFrom + 0.2, Math.round((d.startTo + dt) * 10) / 10),
      });
    } else {
      patchText(d.uid, {
        fromSec: Math.max(0, Math.min(d.startTo - 0.2, Math.round((d.startFrom + dt) * 10) / 10)),
      });
    }
  }
  function onTextTrimUp() {
    txTrimDrag.current = null;
  }

  /** §6.3: snap a dragged timeline EDGE to the playhead / 0 / end and report the
   * guide-line position (null = no snap). Gapless clip boundaries ripple with
   * the edit, so the playhead + the project bounds are the stable targets. */
  function snapTimelineEdge(sec: number): { sec: number; guide: number | null } {
    if (!snapOn) return { sec, guide: null };
    let best = sec;
    let bestD = 9 / pps;
    let hit: number | null = null;
    const consider = (t: number) => {
      const dd = Math.abs(t - sec);
      if (dd < bestD) {
        bestD = dd;
        best = t;
        hit = t;
      }
    };
    consider(0);
    consider(totalDur);
    consider(playhead);
    return { sec: best, guide: hit };
  }

  /** Magnetic snap (CapCut "Attach"): pull a candidate time to the nearest cut
   * point / clip boundary / 0 / end when within ~9px, so edits land on a frame
   * a user actually cares about. No-op when the magnet is off. */
  function snapSec(sec: number): number {
    if (!snapOn) return sec;
    let best = sec;
    let bestD = 9 / pps;
    const consider = (t: number) => {
      const dd = Math.abs(t - sec);
      if (dd < bestD) {
        bestD = dd;
        best = t;
      }
    };
    consider(0);
    consider(totalDur);
    clipStarts.forEach((s, i) => {
      consider(s);
      const c = timeline[i];
      if (c) consider(s + clipOutDur(c));
    });
    if (beatsOn && music) {
      const fromSec = music.fromSec;
      beats.forEach((b) => consider(fromSec + b));
    }
    return best;
  }

  /* ---------- scrub by pointer on the ruler/track area ---------- */
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const scrubbing = useRef(false);
  function timeFromPointer(e: React.PointerEvent): number {
    const scroller = scrollerRef.current;
    if (!scroller) return 0;
    const rect = scroller.getBoundingClientRect();
    return (e.clientX - rect.left + scroller.scrollLeft) / pps;
  }
  function onScrubDown(e: React.PointerEvent) {
    scrubbing.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setPlaying(false);
    scrub(snapSec(timeFromPointer(e)));
  }
  function onScrubMove(e: React.PointerEvent) {
    if (scrubbing.current) scrub(snapSec(timeFromPointer(e)));
  }
  function onScrubUp() {
    scrubbing.current = false;
  }

  const PPS_MIN = 4;
  const PPS_MAX = 240;
  /** Zoom to a px/sec value, keeping the playhead anchored on screen (CapCut:
   * "zoom from a 6s clip to a 2-min edit without losing the playhead"). */
  const zoomTo = useCallback((next: number) => {
    const clamped = Math.min(PPS_MAX, Math.max(PPS_MIN, next));
    const scroller = scrollerRef.current;
    const anchorSec = playheadRef.current;
    const anchorScreenX = scroller ? anchorSec * ppsRef.current - scroller.scrollLeft : 0;
    ppsRef.current = clamped;
    setPps(clamped);
    if (scroller) {
      requestAnimationFrame(() => {
        scroller.scrollLeft = Math.max(0, anchorSec * clamped - anchorScreenX);
      });
    }
  }, []);
  /** Fit the whole edit into the visible timeline width. */
  const fitZoom = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    zoomTo((scroller.clientWidth - 48) / Math.max(totalDur, 1));
  }, [totalDur, zoomTo]);

  // Keep the timeline spanning the full viewport width: re-fit px/sec whenever
  // the edit's total duration changes — until the user takes manual zoom
  // control. This is what makes a freshly-added clip fill the lane instead of
  // sitting in a short stub on the left.
  useEffect(() => {
    if (userZoomed.current || totalDur <= 0) return;
    // Don't re-fit mid-trim: a live trim changes totalDur every frame, and
    // re-fitting would shift px/sec under the cursor (the edge slides off the
    // snap target). One re-fit lands naturally after the drag releases.
    if (trimDrag.current) return;
    const scroller = scrollerRef.current;
    if (!scroller || scroller.clientWidth <= 0) return;
    zoomTo((scroller.clientWidth - 24) / Math.max(totalDur, 1));
  }, [totalDur, zoomTo]);

  const trackWidth = Math.max(totalDur * pps + 60, 320);
  const ruler = useMemo(() => rulerTicks(totalDur, pps), [totalDur, pps]);

  return {
    // zoom / scroll
    pps,
    userZoomed,
    zoomTo,
    fitZoom,
    scrollerRef,
    trackWidth,
    ruler,
    // locks / snap / hover
    isLocked,
    toggleLock,
    snapOn,
    setSnapOn,
    snapGuide,
    setSnapGuide,
    snapSec,
    // beat markers
    beatsOn,
    beats,
    bpm,
    beatBusy,
    toggleBeats,
    hoverClip,
    setHoverClip,
    // selection / multi-select
    multiSel,
    selectClipAt,
    // reorder
    reorderDrag,
    reorderMoved,
    startReorder,
    timeFromClientX,
    // clip actions
    removeClip,
    deleteSelectedClips,
    duplicateClip,
    splitAtPlayhead,
    freezeAtPlayhead,
    moveKeyframe,
    // base-clip trim
    onTrimPointerDown,
    onTrimPointerMove,
    onTrimPointerUp,
    // overlay-block trim
    onOverlayTrimDown,
    onOverlayTrimMove,
    onOverlayTrimUp,
    // text-block move/trim
    onTextMoveDown,
    onTextTrimDown,
    onTextTrimMove,
    onTextTrimUp,
    // scrub
    onScrubDown,
    onScrubMove,
    onScrubUp,
  };
}

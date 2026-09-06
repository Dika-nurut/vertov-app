// Studio project model + persistence (extracted from StudioClient.tsx, split
// 4/N). Owns the serialised project snapshot (tracks/texts/audio/format/bg),
// debounced autosave + pagehide flush, and the snapshot-stack undo/redo.
//
// Multi-track model (Phase 1, research/archive/studio-multitrack-overlay-plan-2026-06.md):
// the canonical state is now `tracks: Track[]` — track 0 is the base footage
// (sequential), tracks 1..N stack upward. The legacy `timeline`/`overlays` API
// (and the 100+ call sites that use it) is preserved as a DERIVED view over the
// tracks plus setter shims, so this is a no-behavior-change internal refactor:
// `timeline` === track 0's clips, `overlays` === the upper-track clips projected
// to the old PiP shape. New multi-track UI uses `tracks`/`setTracks` directly.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSaveStatus } from '../_components/SaveIndicator';
import { FORMATS } from './_model';
import type { TClip, TText, TAudio, TSfx, Format, PopText } from './_model';
import { BASE_TRACK_ID, hydrateTracks, TRACKS_SCHEMA_VERSION, type Track } from './_tracks';
import {
  chooseStudioTimeline,
  clearStudioRecoveryThrough,
  createStudioRecovery,
  readStudioRecovery,
  writeStudioRecovery,
} from '@/lib/studio-recovery';

type Updater<T> = T | ((prev: T) => T);
const resolve = <T>(action: Updater<T>, prev: T): T =>
  typeof action === 'function' ? (action as (p: T) => T)(prev) : action;

const emptyBaseTrack = (): Track => ({ id: BASE_TRACK_ID, kind: 'video', clips: [] });

export function useStudioProject(
  apiUrl: string,
  onSnapshotApplied: () => void,
  /** When set, autosave/load target a specific named project
   *  (`/v1/studio/projects/:id`); otherwise the reserved scratch project
   *  (`/v1/studio/project`) behind the quick `/studio` editor. */
  studioProjectId?: string,
  /** Scopes local crash recovery so switching accounts cannot expose a draft. */
  ownerId?: string,
) {
  // Single source of truth for which row this editor reads/writes.
  const projectUrl = studioProjectId
    ? `${apiUrl}/v1/studio/projects/${studioProjectId}`
    : `${apiUrl}/v1/studio/project`;
  const recoveryStudioProjectId = studioProjectId ?? 'scratch';
  const save = useSaveStatus();
  // Canonical timeline state: the track stack (track 0 = base, 1..N = overlays).
  const [tracks, setTracks] = useState<Track[]>(() => [emptyBaseTrack()]);
  const [texts, setTexts] = useState<TText[]>([]);
  // Word-pop captions («по словам») — a single dedicated lane, separate from
  // `texts` (which caps at 12); word-pop routinely produces 50–200 words.
  const [popText, setPopText] = useState<PopText | null>(null);
  const [music, setMusic] = useState<TAudio | null>(null);
  const [voiceover, setVoiceover] = useState<TAudio | null>(null);
  const [sfx, setSfx] = useState<TSfx[]>([]);
  const [format, setFormat] = useState<Format>(FORMATS[0]!);
  // S3 subsystem G: composition background fill (null = the default black).
  const [bgColor, setBgColor] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  // Production handoff provenance/idempotency lives beside the editable
  // timeline fields. Preserve it across ordinary Studio autosaves.
  const boardHandoffRef = useRef<Record<string, unknown> | null>(null);

  // ---- Legacy `timeline` view over the track stack ----
  // `timeline` is track 0's clips, kept as a derived view + setter shim so the
  // ~100 base-track call sites keep working unchanged. (The `overlays`/TOverlay
  // projection was retired — upper-track clips are read directly as `tracks`.)
  const timeline = useMemo<TClip[]>(() => tracks[0]?.clips ?? [], [tracks]);

  const setTimeline = useCallback((action: Updater<TClip[]>) => {
    setTracks((prev) => {
      const base = prev[0] ?? emptyBaseTrack();
      const nextClips = resolve(action, base.clips);
      return [{ ...base, clips: nextClips }, ...prev.slice(1)];
    });
  }, []);

  /* ---------- project autosave (debounced PUT, load once) ---------- */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(projectUrl, { credentials: 'include' });
        if (res.ok) {
          const body = await res.json();
          const serverTimeline = body?.timeline;
          const recovery = ownerId
            ? readStudioRecovery(window.localStorage, ownerId, recoveryStudioProjectId)
            : null;
          const selected = chooseStudioTimeline(serverTimeline, recovery);
          const t = selected.timeline;
          boardHandoffRef.current =
            t &&
            typeof t === 'object' &&
            !Array.isArray(t) &&
            typeof t.__boardHandoff === 'object' &&
            t.__boardHandoff !== null &&
            !Array.isArray(t.__boardHandoff)
              ? (t.__boardHandoff as Record<string, unknown>)
              : null;
          // Accept the v2 `{tracks}` blob or the legacy `{timeline, overlays}`
          // blob — hydrateTracks normalizes either into the track stack.
          if (!cancelled && t && typeof t === 'object' && (t.tracks || t.timeline)) {
            // start the save clock above the persisted rev so the first edit wins
            revRef.current = selected.rev + 1;
            setTracks(hydrateTracks(t));
            setTexts(Array.isArray(t.texts) ? t.texts : []);
            const loadedPopText = t.popText as PopText | null | undefined;
            setPopText(
              loadedPopText && Array.isArray(loadedPopText.words) && loadedPopText.words.length
                ? loadedPopText
                : null,
            );
            const loadedMusic = t.music as TAudio | null | undefined;
            const loadedVoiceover = t.voiceover as TAudio | null | undefined;
            setMusic(
              loadedMusic
                ? {
                    ...loadedMusic,
                    fadeIn: loadedMusic.fadeIn ?? false,
                    fadeOut: loadedMusic.fadeOut ?? false,
                  }
                : null,
            );
            setVoiceover(
              loadedVoiceover
                ? {
                    ...loadedVoiceover,
                    fadeIn: loadedVoiceover.fadeIn ?? false,
                    fadeOut: loadedVoiceover.fadeOut ?? false,
                  }
                : null,
            );
            // Hydrate defensively: only well-shaped rows, gainDb defaults to 0.
            setSfx(
              Array.isArray(t.sfx)
                ? t.sfx
                    .filter(
                      (s: unknown): s is TSfx =>
                        !!s &&
                        typeof (s as TSfx).url === 'string' &&
                        typeof (s as TSfx).atSec === 'number',
                    )
                    .map((s: TSfx) => ({
                      ...s,
                      gainDb: typeof s.gainDb === 'number' ? s.gainDb : 0,
                      name: typeof s.name === 'string' ? s.name : 'Звук',
                    }))
                : [],
            );
            const f = FORMATS.find((x) => x.id === t.formatId);
            if (f) setFormat(f);
            if (typeof t.bgColor === 'string' || t.bgColor === null) setBgColor(t.bgColor);
          }
        }
      } catch {
        /* fresh project */
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ownerId, projectUrl, recoveryStudioProjectId]);

  // Monotonic save revision — stamped on every PUT so the server can drop a
  // stale older write that lands after a newer one (debounced vs pagehide race).
  // Seeded above the loaded blob's rev so the first client save always wins.
  const revRef = useRef(0);

  const projectSnapRef = useRef({
    schemaVersion: TRACKS_SCHEMA_VERSION,
    tracks,
    texts,
    popText,
    music,
    voiceover,
    sfx,
    formatId: format.id,
    bgColor,
    ...(boardHandoffRef.current ? { __boardHandoff: boardHandoffRef.current } : {}),
  });
  const persistedTracks = tracks.map((track) => ({
    ...track,
    clips: track.clips.map(
      ({ assetUnavailable: _unavailable, assetExpiresAt: _expires, ...clip }) => clip,
    ),
  }));
  projectSnapRef.current = {
    schemaVersion: TRACKS_SCHEMA_VERSION,
    tracks: persistedTracks,
    texts,
    popText,
    music,
    voiceover,
    sfx,
    formatId: format.id,
    bgColor,
    ...(boardHandoffRef.current ? { __boardHandoff: boardHandoffRef.current } : {}),
  };
  // Persisted blob: canonical `tracks` only (v2). The legacy `{timeline, overlays}`
  // dual-write was retired — it was a LOSSY projection (it dropped rotate/crop/
  // color/anim/keyframes from upper-track clips), so a stray legacy read could wipe
  // those fields. Old rows still load: `hydrateTracks` keeps a read-only legacy
  // branch ({timeline, overlays} → tracks). New rows are v2; this is the single app.
  const serializeBlob = () => projectSnapRef.current;
  const savingProjRef = useRef(false);
  const dirtyProjRef = useRef(false);
  const persistProjRef = useRef<() => void>(() => {});
  persistProjRef.current = () => {
    if (savingProjRef.current) {
      dirtyProjRef.current = true;
      return;
    }
    savingProjRef.current = true;
    save.run(async () => {
      let ok = false;
      const timeline = serializeBlob();
      const rev = revRef.current;
      try {
        const res = await fetch(projectUrl, {
          method: 'PUT',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ timeline, rev }),
        });
        const response: unknown = await res.json().catch(() => null);
        const skipped =
          typeof response === 'object' &&
          response !== null &&
          (response as { skipped?: unknown }).skipped === true;
        ok = res.ok && !skipped;
        if (ok && ownerId) {
          clearStudioRecoveryThrough(window.localStorage, ownerId, recoveryStudioProjectId, rev);
        }
      } catch {
        ok = false;
      }
      savingProjRef.current = false;
      if (dirtyProjRef.current) {
        dirtyProjRef.current = false;
        persistProjRef.current();
      }
      return ok;
    });
  };

  useEffect(() => {
    if (!hydrated) return;
    revRef.current += 1; // each edit bumps the save revision
    if (ownerId) {
      try {
        writeStudioRecovery(
          window.localStorage,
          createStudioRecovery({
            ownerId,
            studioProjectId: recoveryStudioProjectId,
            rev: revRef.current,
            timeline: serializeBlob(),
          }),
        );
      } catch {
        // Oversized projects are rejected by the same 256 KiB server contract.
        // Keep the editor usable even if a draft cannot be cached locally.
      }
    }
    const t = setTimeout(() => persistProjRef.current(), 1200);
    return () => clearTimeout(t);
  }, [
    hydrated,
    ownerId,
    recoveryStudioProjectId,
    tracks,
    texts,
    popText,
    music,
    voiceover,
    sfx,
    format,
    bgColor,
  ]);

  // The 1200ms debounce can drop the last edit if the user closes/navigates
  // first. Flush on pagehide / tab-hide with a keepalive PUT so the request
  // survives teardown — this SHRINKS the loss window, it doesn't eliminate it:
  // keepalive bodies are size-capped (~64 KB) so a very large project may not
  // flush, and the `rev` stamp only guarantees an older in-flight save can't
  // clobber this one (server drops stale revs), not that this one is delivered.
  useEffect(() => {
    if (!hydrated) return;
    const flush = () => {
      try {
        void fetch(projectUrl, {
          method: 'PUT',
          credentials: 'include',
          keepalive: true,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ timeline: serializeBlob(), rev: revRef.current }),
        });
      } catch {
        /* best-effort on teardown */
      }
    };
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, [hydrated, projectUrl]);

  /* ---------- undo / redo (§5.2) ----------
   * One history stack over the SAME project snapshot the autosave serialises, so
   * every content edit (tracks/texts/audio/format/bg) is undoable for free.
   * Bursts (a slider drag) coalesce: the capture is debounced and records the
   * PRE-burst baseline, so Cmd+Z rewinds the whole gesture, not one frame. */
  type ProjectSnap = typeof projectSnapRef.current;
  const undoStack = useRef<ProjectSnap[]>([]);
  const redoStack = useRef<ProjectSnap[]>([]);
  const committedSnap = useRef<ProjectSnap | null>(null);
  const [histVer, setHistVer] = useState(0);
  const snapEq = (a: ProjectSnap, b: ProjectSnap) => JSON.stringify(a) === JSON.stringify(b);

  // Seed the baseline once the project hydrates.
  useEffect(() => {
    if (hydrated && !committedSnap.current) committedSnap.current = projectSnapRef.current;
  }, [hydrated]);

  /** Fold any pending (uncaptured) edit into history. Returns true if it pushed. */
  const captureHistory = useCallback((clearRedo: boolean) => {
    const cur = projectSnapRef.current;
    if (committedSnap.current && !snapEq(committedSnap.current, cur)) {
      undoStack.current.push(committedSnap.current);
      if (undoStack.current.length > 100) undoStack.current.shift();
      committedSnap.current = cur;
      if (clearRedo) redoStack.current = [];
      return true;
    }
    return false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced capture: after edits settle, record the pre-burst baseline.
  useEffect(() => {
    if (!hydrated) return;
    const t = setTimeout(() => {
      if (captureHistory(true)) setHistVer((v) => v + 1);
    }, 500);
    return () => clearTimeout(t);
  }, [hydrated, captureHistory, tracks, texts, popText, music, voiceover, sfx, format, bgColor]);

  /** Apply a snapshot to all project state. Sets the baseline to it so the
   * capture effect doesn't re-record the applied state as a fresh edit. */
  const applySnap = useCallback((s: ProjectSnap) => {
    committedSnap.current = s;
    setTracks(s.tracks);
    setTexts(s.texts);
    setPopText(s.popText);
    setMusic(s.music);
    setVoiceover(s.voiceover);
    setSfx(s.sfx);
    const f = FORMATS.find((x) => x.id === s.formatId);
    if (f) setFormat(f);
    setBgColor(s.bgColor);
    onSnapshotApplied(); // a referenced clip/text may no longer exist
  }, []);

  const undo = useCallback(() => {
    captureHistory(true); // commit any pending coalesced edit first
    const prev = undoStack.current.pop();
    if (!prev) return;
    redoStack.current.push(projectSnapRef.current);
    applySnap(prev);
    setHistVer((v) => v + 1);
  }, [captureHistory, applySnap]);

  const redo = useCallback(() => {
    const next = redoStack.current.pop();
    if (!next) return;
    undoStack.current.push(projectSnapRef.current);
    applySnap(next);
    setHistVer((v) => v + 1);
  }, [applySnap]);

  // Undo is available the instant an edit lands — not only after the 500ms
  // capture debounce — because undo() flushes the pending edit first. So reflect
  // a live uncommitted edit (dirty) too, or the button lags the keyboard.
  const undoDirty =
    !!committedSnap.current && !snapEq(committedSnap.current, projectSnapRef.current);
  const canUndo = histVer >= 0 && (undoStack.current.length > 0 || undoDirty);
  const canRedo = redoStack.current.length > 0;

  return {
    tracks,
    setTracks,
    timeline,
    setTimeline,
    texts,
    setTexts,
    popText,
    setPopText,
    music,
    setMusic,
    voiceover,
    setVoiceover,
    sfx,
    setSfx,
    format,
    setFormat,
    bgColor,
    setBgColor,
    hydrated,
    save,
    undo,
    redo,
    canUndo,
    canRedo,
  };
}

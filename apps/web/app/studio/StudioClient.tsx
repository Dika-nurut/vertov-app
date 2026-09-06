'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAudioPeaks } from './_kit/useAudioPeaks';
import { FeatureHint } from '../_components/FeatureHint';
import { useFilmstrip } from './_kit/useFilmstrip';
import { probeDuration } from './_kit/probe';
import {
  Music,
  Mic,
  Clapperboard,
  Volume2,
  Sparkles,
  ArrowLeftRight,
  SlidersHorizontal,
  Captions,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Lock,
  Unlock,
  Magnet,
  Proportions,
  Crop,
  RotateCcw,
  Undo2,
  Redo2,
  UploadCloud,
  Palette,
  Gauge,
  Layers,
  Zap,
} from './_icons';

import {
  Transition,
  Filter,
  DEFAULT_TRANSFORM,
  transformStyle,
  CurvePreset,
  CURVE_LABELS,
  CURVE_CSS,
  TColor,
  HslChannel,
  THslAdjust,
  THsl,
  HSL_SWATCHES,
  hslActive,
  DEFAULT_COLOR,
  PRESET_COLOR,
  TClip,
  BlendMode,
  BLEND_LABELS,
  MaskShape,
  TMask,
  MASK_LABEL,
  maskStyle,
  kfValueAt,
  AnimKind,
  TAnim,
  ANIM_LABEL,
  AnimSeg,
  AnimPreset,
  FADE_IN,
  FADE_OUT,
  ANIM_PRESETS,
  TText,
  TextTemplate,
  TEXT_TEMPLATES,
  TAudio,
  Format,
  txPreview,
  FILTER_LABEL,
  EFFECTS,
  ExportPhase,
  Selection,
  mmss,
  SPEED_CURVES_UI,
  CURVE_LABEL,
  rampSegments,
  clipOutDur,
  clipRateAt,
  dbToLin,
  InspectorTab,
  BG_SWATCHES,
  SMART_ROUTES,
} from './_model';
import type { SpeedCurve, StudioClip } from './_model';
export type { StudioClip } from './_model';
import { SourceTile } from './_components/SourceTile';
import { AudioLine } from './_components/AudioLine';
import { StudioHeader } from './_components/StudioHeader';
import { StudioProjectProvider } from './_project-context';
import { useStudioProject } from './useStudioProject';
import { useMediaImport } from './useMediaImport';
import { usePlayback } from './usePlayback';
import { useTimeline } from './useTimeline';
import { useStudioExport } from './useStudioExport';
import { useGizmo } from './useGizmo';
import { useStudioMedia, type CaptionEngine } from './useStudioMedia';
import { localAsrSupported, disposeLocalAsr } from '../../lib/local-asr/service';
import { usePenMask } from './usePenMask';
import { nextUid } from './_uid';
import { normalizeClip, trackId, BASE_TRACK_ID } from './_tracks';
import { PreviewStage } from './_preview/PreviewStage';
import { CropModal } from './_preview/CropModal';
import { Timeline } from './_timeline/Timeline';
import { Inspector } from './_inspector/Inspector';
import { Library } from './_library/Library';
import { clearHandoff, peekHandoff } from '@/lib/handoff';
import { buildAnimKeyframesEased } from '@/lib/studio-easing';
import type { EasingId } from '@/lib/studio-easing';
import { useResolvedAssets } from '@/lib/asset-lifecycle';
import { AssetLifecycleNotice } from '../_components/AssetLifecycleNotice';

export function StudioClient({
  initialClips,
  apiUrl,
  studioProjectId,
  workspaceProjectId,
  projectTitle,
  ownerId,
  isAnonymous = false,
}: {
  initialClips: StudioClip[];
  apiUrl: string;
  /** When set, this editor edits a specific named project; otherwise the quick
   *  scratch project behind `/studio`. */
  studioProjectId?: string;
  /** The enclosing Среда project, kept distinct from the Studio composition id. */
  workspaceProjectId?: string;
  projectTitle?: string;
  /** Authenticated/anonymous account id; scopes crash recovery in this browser. */
  ownerId?: string;
  /** Pre-paywall anonymous browsing (2026-07-07 follow-up): Studio itself has
   *  no wall, but "Открыть в архиве" after a render points at /gallery, which
   *  DOES require a real account — hide it for a "Гость" session rather than
   *  offer a link that silently bounces to /login. */
  isAnonymous?: boolean;
}) {
  const [selection, setSelection] = useState<Selection>(null);
  const {
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
    tracks,
    setTracks,
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
  } = useStudioProject(apiUrl, () => setSelection(null), studioProjectId, ownerId);
  const [ratioOpen, setRatioOpen] = useState(false);
  // S4: which library panel the IconRail shows.
  const [libSection, setLibSection] = useState('media');
  // S5: title-safe / rule-of-thirds guides over the preview (CapCut "axis").
  const [safeZones, setSafeZones] = useState(false);
  // S5: crop modal (subsystem B). Edits transform.crop live (mirrored by the
  // preview clip-path AND the ffmpeg crop chain → preview==export).
  const [cropOpen, setCropOpen] = useState(false);
  const [phase, setPhase] = useState<ExportPhase>({ kind: 'idle' });
  // Whole-video-track mute = every clip muted (CapCut track-header speaker toggle).
  const allMuted = timeline.length > 0 && timeline.every((c) => c.muted);
  const identifiedAssetIds = useMemo(
    () =>
      tracks.flatMap((track) =>
        track.clips.flatMap((clip) => (clip.assetId ? [clip.assetId] : [])),
      ),
    [tracks],
  );
  const assetLifecycle = useResolvedAssets(apiUrl, identifiedAssetIds);
  useEffect(() => {
    if (identifiedAssetIds.length === 0 || assetLifecycle.size === 0) return;
    setTracks((previous) => {
      let changed = false;
      const next = previous.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => {
          if (!clip.assetId) return clip;
          const asset = assetLifecycle.get(clip.assetId);
          const patch = asset?.available
            ? {
                url: asset.assetUrl,
                assetUnavailable: false,
                assetExpiresAt: asset.expiresAt,
              }
            : { assetUnavailable: true, assetExpiresAt: null };
          if (
            clip.url === patch.url &&
            clip.assetUnavailable === patch.assetUnavailable &&
            clip.assetExpiresAt === patch.assetExpiresAt
          ) {
            return clip;
          }
          changed = true;
          return { ...clip, ...patch };
        }),
      }));
      return changed ? next : previous;
    });
  }, [assetLifecycle, identifiedAssetIds.length, setTracks]);
  const [handoffClips] = useState<StudioClip[]>(() =>
    peekHandoff('studio').map((assetUrl, index) => ({
      id: `handoff-${index}-${assetUrl}`,
      assetUrl,
    })),
  );
  useEffect(() => {
    if (handoffClips.length > 0) clearHandoff('studio');
  }, [handoffClips.length]);
  // Auto-ducking windows are derived from the voiceover at analysis time
  // (`duck.sourceKey` = `${url}@${fromSec}`). If the voiceover is edited,
  // swapped, or removed afterward, the stored windows no longer describe it —
  // strip the stale duck rather than keep dipping music under speech that's
  // moved or gone. Specs without `sourceKey` (pre-existing projects) are left
  // alone: there's nothing to compare against.
  useEffect(() => {
    const key = music?.duck?.sourceKey;
    if (!key) return;
    const currentKey = voiceover ? `${voiceover.url}@${voiceover.fromSec}` : null;
    if (key === currentKey) return;
    setMusic((m) => (m?.duck ? { ...m, duck: undefined } : m));
  }, [voiceover?.url, voiceover?.fromSec, music?.duck?.sourceKey, setMusic]);
  const mediaInitialClips = useMemo(() => {
    const byUrl = new Map<string, StudioClip>();
    for (const clip of [...initialClips, ...handoffClips]) {
      if (clip.assetUrl) byUrl.set(clip.assetUrl, clip);
    }
    return [...byUrl.values()];
  }, [initialClips, handoffClips]);

  /* ---------- derived timeline geometry ---------- */
  const clipStarts = useMemo(() => {
    const starts: number[] = [];
    let acc = 0;
    for (let i = 0; i < timeline.length; i++) {
      starts.push(acc);
      const c = timeline[i]!;
      acc +=
        clipOutDur(c) - (i < timeline.length - 1 && c.transition !== 'cut' ? c.transitionSec : 0);
    }
    return starts;
  }, [timeline]);

  const totalDur = useMemo(() => {
    if (timeline.length === 0) return 0;
    const last = timeline[timeline.length - 1]!;
    return (clipStarts[timeline.length - 1] ?? 0) + clipOutDur(last);
  }, [timeline, clipStarts]);

  const selectedClip =
    selection?.kind === 'clip' ? (timeline.find((c) => c.uid === selection.uid) ?? null) : null;
  const selectedText =
    selection?.kind === 'text' ? (texts.find((t) => t.uid === selection.uid) ?? null) : null;
  // III.1 (G1) / §B: an "overlay" is just a clip on an upper track. The lossy
  // `overlays` (TOverlay) projection was retired — the lane, playback, preview and
  // inspector all read these CANONICAL upper-track `TClip`s directly (lossless:
  // rotate/crop/color/anim survive) and mutate via `patchUpperClip`.
  const upperClips = useMemo(() => tracks.slice(1).flatMap((t) => t.clips), [tracks]);
  const selectedOverlayClip =
    selection?.kind === 'overlay'
      ? (upperClips.find((c) => c.uid === selection.uid) ?? null)
      : null;
  const selectedIdx = selectedClip ? timeline.findIndex((c) => c.uid === selectedClip.uid) : -1;
  // E1: the context inspector's active tab — kept per selection, reset on
  // selecting a different clip (CapCut opens each clip on its main tab).
  const [inspTab, setInspTab] = useState<InspectorTab>('main');
  // Animation gallery (§4.3): which group is shown, the in/out duration, and
  // which preset is applied per clip (UI hint for the active tile).
  const [animGroup, setAnimGroup] = useState<'in' | 'out' | 'combo'>('in');
  const [animDur, setAnimDur] = useState(0.5);
  const [animEasing, setAnimEasing] = useState<EasingId>('smooth');
  const [animApplied, setAnimApplied] = useState<Record<string, string>>({});

  const [hslChannel, setHslChannel] = useState<HslChannel>('r');
  useEffect(
    () => setInspTab('main'),
    [selectedClip?.uid, selectedOverlayClip?.uid, selectedText?.uid],
  );

  /* ---------- live preview engine ----------
     One hidden-or-visible <video> per timeline clip, stacked in the preview
     box. A rAF loop advances the playhead; per frame each element gets
     play/pause + drift-corrected currentTime, and transition windows are
     approximated by fading the OUTGOING clip over the incoming one. Music
     and voiceover ride along in <audio> elements. Approximation, not a
     compositor — but the edit is judged without spending a render. */
  // Per-clip preview load state (CapCut shows a buffering chip / failed state on
  // the canvas instead of a silent black frame). Keyed by clip uid.
  const [vidStatus, setVidStatus] = useState<Record<string, 'buffering' | 'ready' | 'error'>>({});
  const markVid = useCallback(
    (uid: string, s: 'buffering' | 'ready' | 'error') =>
      setVidStatus((m) => (m[uid] === s ? m : { ...m, [uid]: s })),
    [],
  );

  const clipWindow = useCallback(
    (i: number): { start: number; end: number } => {
      const start = clipStarts[i] ?? 0;
      return { start, end: start + clipOutDur(timeline[i]!) };
    },
    [clipStarts, timeline],
  );

  /** Visibility + opacity + transition geometry of clip i at time t. The
   * geometry (transform / clipPath / zBoost) is the crown-jewel preview==export
   * mirror of the xfade mode — see `txPreview` in _model. Opacity-only
   * transitions (crossfade/dip/flash) return the same numbers as before. */
  const clipVisual = useCallback(
    (
      i: number,
      t: number,
    ): {
      visible: boolean;
      opacity: number;
      transform?: string;
      clipPath?: string;
      zBoost?: boolean;
    } => {
      const c = timeline[i]!;
      const { start, end } = clipWindow(i);
      if (t < start || t >= end) return { visible: false, opacity: 0 };
      // Outgoing side of MY transition into the next clip.
      if (i < timeline.length - 1 && c.transition !== 'cut') {
        const overlapStart = clipStarts[i + 1]!;
        if (t >= overlapStart) {
          const p = Math.min(1, (t - overlapStart) / Math.max(0.01, c.transitionSec));
          const tx = txPreview(c.transition, 'out', p);
          if (tx)
            return {
              visible: true,
              opacity: tx.opacity,
              ...(tx.transform ? { transform: tx.transform } : {}),
              ...(tx.clipPath ? { clipPath: tx.clipPath } : {}),
            };
        }
      }
      // Incoming side of the PREVIOUS clip's transition (geometry/hold-and-appear).
      if (i > 0 && timeline[i - 1]!.transition !== 'cut') {
        const prev = timeline[i - 1]!;
        const myStart = clipStarts[i]!;
        const overlapEnd = myStart + prev.transitionSec;
        if (t < overlapEnd) {
          const p = Math.min(1, (t - myStart) / Math.max(0.01, prev.transitionSec));
          const tx = txPreview(prev.transition, 'in', p);
          if (tx)
            return {
              visible: true,
              opacity: tx.opacity,
              ...(tx.transform ? { transform: tx.transform } : {}),
              ...(tx.clipPath ? { clipPath: tx.clipPath } : {}),
              ...(tx.lift ? { zBoost: true } : {}),
            };
        }
      }
      return { visible: true, opacity: 1 };
    },
    [timeline, clipStarts, clipWindow],
  );

  const {
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
  } = usePlayback({ timeline, upperClips, music, voiceover, sfx, totalDur, clipWindow });

  const {
    exportRes,
    setExportRes,
    exportFps,
    setExportFps,
    exportFmt,
    setExportFmt,
    exportOpen,
    setExportOpen,
    exportBtnRef,
    shareCopied,
    setShareCopied,
    history,
    onExport,
    cancelRender,
    uploadAudio,
  } = useStudioExport({
    apiUrl,
    ...(workspaceProjectId ? { workspaceProjectId } : {}),
    timeline,
    tracks,
    texts,
    popText,
    music,
    voiceover,
    sfx,
    format,
    bgColor,
    playhead,
    totalDur,
    setPhase,
    setPlaying,
  });

  /** The clip Library Effects/Filters apply to: the selected clip, or — so the
   * catalogs aren't dead when nothing is selected — the clip under the playhead
   * (what the preview shows), falling back to the first clip. */
  const libClip = useMemo(() => {
    if (selectedClip) return selectedClip;
    const i = timeline.findIndex((_, idx) => {
      const w = clipWindow(idx);
      return playhead >= w.start && playhead < w.end;
    });
    return timeline[i >= 0 ? i : 0] ?? null;
  }, [selectedClip, timeline, playhead, clipWindow]);

  /* ---------- timeline ops ---------- */
  /** E8: drop a source as a PiP overlay starting at the playhead. */
  const addPip = useCallback(
    async (url: string, assetId?: string) => {
      const dur = await probeDuration(url);
      const uid = nextUid();
      const atSec = Math.round(playheadRef.current * 10) / 10;
      setTracks((prev) => {
        // E8 PiP cap: at most 6 upper-track clips (was overlays.slice(0, 6)).
        const upperCount = prev.slice(1).reduce((n, t) => n + t.clips.length, 0);
        if (upperCount >= 6) return prev;
        // Mirror the old TOverlay defaults inline (scale/pos → transform; the
        // source duration bounds out; volume 0 dB, unmuted).
        const clip = normalizeClip({
          uid,
          url,
          ...(assetId ? { assetId } : {}),
          dur,
          inSec: 0,
          outSec: dur,
          startSec: atSec,
          muted: false,
          volumeDb: 0,
          opacity: 1,
          transform: { ...DEFAULT_TRANSFORM, scale: 0.35, posX: 28, posY: -24 },
        });
        const base = prev[0] ?? { id: BASE_TRACK_ID, kind: 'video' as const, clips: [] };
        const upper = prev[1] ?? { id: trackId(1), kind: 'video' as const, clips: [] };
        return [base, { ...upper, clips: [...upper.clips, clip] }, ...prev.slice(2)];
      });
      setSelection({ kind: 'overlay', uid });
    },
    [setTracks],
  );
  // III.1 (G1): patch the CANONICAL upper-track clip in place (lossless, unlike
  // the old TOverlay round-trip which dropped rotate/crop/color/anim). Every
  // rich overlay edit — transform/color/anim/flips AND timing/trim — routes here
  // so a later edit can't wipe fields the TOverlay projection can't hold.
  const patchUpperClip = useCallback(
    (uid: string, patch: Partial<TClip>) => {
      setTracks((prev) =>
        prev.map((t, i) =>
          i === 0
            ? t
            : { ...t, clips: t.clips.map((c) => (c.uid === uid ? { ...c, ...patch } : c)) },
        ),
      );
    },
    [setTracks],
  );
  const removeOverlay = useCallback(
    (uid: string) => {
      setTracks((prev) => {
        const base = prev[0]!;
        const upper = prev
          .slice(1)
          .map((t) => ({ ...t, clips: t.clips.filter((c) => c.uid !== uid) }))
          .filter((t) => t.clips.length > 0);
        return [base, ...upper];
      });
      setSelection((s) => (s?.kind === 'overlay' && s.uid === uid ? null : s));
    },
    [setTracks],
  );

  const addClip = useCallback(async (url: string, assetId?: string) => {
    const dur = await probeDuration(url);
    setTimeline((tl) => {
      const uid = nextUid();
      setSelection({ kind: 'clip', uid });
      return [
        ...tl,
        {
          uid,
          url,
          ...(assetId ? { assetId } : {}),
          dur,
          inSec: 0,
          outSec: dur,
          speed: 1,
          muted: false,
          volumeDb: 0,
          transition: 'cut',
          transitionSec: 0.5,
          filter: 'none',
        },
      ];
    });
  }, []);

  const patchClip = (uid: string, patch: Partial<TClip>) =>
    setTimeline((tl) => tl.map((c) => (c.uid === uid ? { ...c, ...patch } : c)));

  /** Drop a sound-effect clip at the current playhead (rounded 0.1s). Capped at
   * 10 (the render/API ceiling). Consumed by the Audio library panel. */
  const addSfx = useCallback(
    (url: string, name: string, durSec?: number) => {
      const atSec = Math.round(playheadRef.current * 10) / 10;
      setSfx((prev) =>
        prev.length >= 10
          ? prev
          : [
              ...prev,
              {
                uid: nextUid(),
                url,
                name,
                atSec,
                gainDb: 0,
                ...(typeof durSec === 'number' ? { durSec } : {}),
              },
            ],
      );
    },
    [setSfx, playheadRef],
  );

  const { stageBoxRef, gizmoTip, snapGuides, onGizmoDown } = useGizmo({
    selectedClip,
    patchClip,
    togglePlay,
  });
  const pen = usePenMask({ selectedClip, patchClip, stageBoxRef });

  // G4: transitions are applied on the TIMELINE, not in the inspector. A tile
  // dragged out of the left «Переходы» library drops onto a clip junction; the
  // junction also stays click-cyclable for a quick toggle. `txDragId` carries the
  // dragged transition; the window-listener drag (the repo's standard pattern)
  // resolves the drop target via elementFromPoint so it works without HTML5 DnD.
  const [txDragId, setTxDragId] = useState<Transition | null>(null);
  const startTxDrag = useCallback((t: Transition, _e: React.PointerEvent) => {
    // No preventDefault — the click fallback (apply to the selected clip) must
    // still fire when the press/release lands on the same tile.
    setTxDragId(t);
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointerup', up);
      setTxDragId(null);
      const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      const junction = el?.closest('[data-testid="transition-btn"]') as HTMLElement | null;
      const uid = junction?.dataset.uid;
      if (uid) patchClip(uid, { transition: t });
    };
    window.addEventListener('pointerup', up);
  }, []);

  // Apply an animation preset → compile to keyframes on the clip (renders
  // end-to-end). Passing null clears the animation.
  const applyAnim = (
    uid: string,
    preset: AnimPreset | null,
    durSec: number,
    easingOverride?: EasingId,
  ) => {
    const easing = easingOverride ?? animEasing;
    setTimeline((tl) =>
      tl.map((c) =>
        c.uid === uid
          ? preset
            ? {
                ...c,
                keyframes: buildAnimKeyframesEased(preset, clipOutDur(c), durSec, easing),
              }
            : { ...c, keyframes: undefined }
          : c,
      ),
    );
    setAnimApplied((m) => {
      const next = { ...m };
      if (preset) next[uid] = preset.id;
      else delete next[uid];
      return next;
    });
  };

  const onUploadError = useCallback((message: string) => setPhase({ kind: 'failed', message }), []);
  const { clips, upload, importing, dragOver, setDragOver, cancelUpload, onDropFiles } =
    useMediaImport(apiUrl, mediaInitialClips, addClip, onUploadError);

  /* ---------- text ops ---------- */
  const addText = (opts?: {
    text?: string;
    position?: TText['position'];
    font?: TText['font'];
    sizeFrac?: number;
    fade?: boolean;
  }) => {
    const uid = nextUid();
    const from = Math.min(0.5, Math.max(0, totalDur - 1));
    setTexts((ts) => [
      ...ts,
      {
        uid,
        text: opts?.text ?? 'Твой текст',
        fromSec: from,
        toSec: Math.min(Math.max(from + 2, 2), Math.max(totalDur, 2)),
        position: opts?.position ?? 'bottom',
        font: opts?.font ?? 'sans',
        fade: opts?.fade ?? true,
        ...(opts?.sizeFrac ? { sizeFrac: opts.sizeFrac } : {}),
      },
    ]);
    setSelection({ kind: 'text', uid });
  };

  const patchText = (uid: string, patch: Partial<TText>) =>
    setTexts((ts) => ts.map((t) => (t.uid === uid ? { ...t, ...patch } : t)));

  const removeText = useCallback((uid: string) => {
    setTexts((ts) => ts.filter((t) => t.uid !== uid));
    setSelection((s) => (s?.kind === 'text' && s.uid === uid ? null : s));
  }, []);

  // §C step 4 — the timeline INTERACTION layer (zoom/snap/select/trim/reorder/
  // scrub + clip/text/overlay actions + the interaction state they touch) lives
  // in useTimeline now; raw data + undo/redo stay in useStudioProject.
  const {
    pps,
    userZoomed,
    zoomTo,
    fitZoom,
    scrollerRef,
    trackWidth,
    ruler,
    isLocked,
    toggleLock,
    snapOn,
    setSnapOn,
    snapGuide,
    setSnapGuide,
    snapSec,
    beatsOn,
    beats,
    bpm,
    beatBusy,
    toggleBeats,
    hoverClip,
    setHoverClip,
    multiSel,
    selectClipAt,
    reorderDrag,
    reorderMoved,
    startReorder,
    timeFromClientX,
    removeClip,
    deleteSelectedClips,
    duplicateClip,
    splitAtPlayhead,
    freezeAtPlayhead,
    moveKeyframe,
    onTrimPointerDown,
    onTrimPointerMove,
    onTrimPointerUp,
    onOverlayTrimDown,
    onOverlayTrimMove,
    onOverlayTrimUp,
    onTextMoveDown,
    onTextTrimDown,
    onTextTrimMove,
    onTextTrimUp,
    onScrubDown,
    onScrubMove,
    onScrubUp,
  } = useTimeline({
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
  });

  // Transcription engine: server (Deepgram) or whisper-in-browser (zero cost).
  // Local support is browser-only, so probe after mount to avoid a hydration
  // mismatch; the «Локально» option appears once we know it's available.
  const [engine, setEngine] = useState<CaptionEngine>('server');
  const [localSupported, setLocalSupported] = useState(false);
  useEffect(() => {
    setLocalSupported(localAsrSupported());
    return () => disposeLocalAsr();
  }, []);

  const { captioning, asrProgress, onSrtUpload, autoCaption, autoCaptionWords } = useStudioMedia({
    apiUrl,
    engine,
    timeline,
    clipStarts,
    selectedIdx,
    setTexts,
    setPopText,
    setPhase,
  });
  // Auto-caption mode toggle («По словам»): pop mode routes the button to
  // autoCaptionWords + shows the pop-caption summary.
  const [popMode, setPopMode] = useState(false);

  /* ---------- keyboard (CapCut muscle memory) ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable)
        return;
      const mod = e.metaKey || e.ctrlKey;
      // Undo / redo (CapCut: ⌘Z / ⌘⇧Z, plus ⌘Y). Handle before the bare-key ops
      // so ⌘S/⌘Z never fall through to split.
      if (mod && /^[zZyYяЯнН]$/.test(e.key)) {
        e.preventDefault();
        if ((e.key === 'z' || e.key === 'я') && !e.shiftKey) undo();
        else redo();
        return;
      }
      if (mod) return; // leave other ⌘/Ctrl chords to the browser
      if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
      } else if (e.key === 's' || e.key === 'ы') {
        splitAtPlayhead();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (multiSel.size > 0) deleteSelectedClips();
        else if (selection?.kind === 'clip') removeClip(selection.uid);
        else if (selection?.kind === 'text') removeText(selection.uid);
        else if (selection?.kind === 'overlay') removeOverlay(selection.uid);
      } else if (e.key === 'ArrowLeft') {
        scrub(playheadRef.current - (e.shiftKey ? 1 : 0.1));
      } else if (e.key === 'ArrowRight') {
        scrub(playheadRef.current + (e.shiftKey ? 1 : 0.1));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selection,
    multiSel,
    deleteSelectedClips,
    splitAtPlayhead,
    removeClip,
    removeText,
    removeOverlay,
    scrub,
    undo,
    redo,
    timeline.length,
    playing,
    totalDur,
  ]);

  const busy = phase.kind === 'uploading' || phase.kind === 'rendering';
  // §6.1: adaptive ruler — a "nice" labelled interval chosen for the current
  // zoom (px/sec) so labels stay ~66px apart at any zoom, with minor ticks
  // subdividing and clock (M:SS) labels once the edit runs past a minute.

  /* Visible texts at the playhead (preview overlay). The export applies a
     min-duration floor (useStudioExport serializes toSec as max(toSec, from+0.2);
     the worker drawtext floors further to from+0.1) so a sub-0.2s overlay stays on
     screen a beat longer than authored — mirror that floor here so the preview shows
     the SAME window the export renders. */
  const liveTexts = texts.filter(
    (t) => playhead >= t.fromSec && playhead <= Math.max(t.toSec, t.fromSec + 0.2),
  );
  /* Word-pop caption («по словам»): the single word active at the playhead + the
     shared style (preview mirror of the worker's popText drawtext lane). */
  const livePop = (() => {
    if (!popText) return null;
    // Half-open [fromSec,toSec) — matches the worker's pop-lane enable window
    // (gte*lt) so adjacent words don't both read "active" on their shared boundary.
    // The export floors a word's end to from+0.1 (serialize +0.05 → drawtext +0.1);
    // mirror it so a very short word pops for the same beat as the render.
    const w = popText.words.find(
      (x) => playhead >= x.fromSec && playhead < Math.max(x.toSec, x.fromSec + 0.1),
    );
    if (!w) return null;
    const { words: _words, ...style } = popText;
    return { text: w.text, style };
  })();
  // Flash (dip-to-white) preview: a white veil peaking mid-overlap (the clips dip
  // to 0 like dip-to-black, but the veil is white instead of the black stage) —
  // mirrors ffmpeg xfade=fadewhite so preview≈export.
  const flashOpacity = (() => {
    let o = 0;
    for (let i = 0; i < timeline.length - 1; i++) {
      if (timeline[i]!.transition !== 'flash') continue;
      const ovStart = clipStarts[i + 1] ?? 0;
      const dur = Math.max(0.01, timeline[i]!.transitionSec);
      if (playhead >= ovStart && playhead <= ovStart + dur) {
        const p = (playhead - ovStart) / dur;
        o = Math.max(o, Math.max(0, 1 - Math.abs(2 * p - 1)));
      }
    }
    return o;
  })();

  return (
    <StudioProjectProvider workspaceProjectId={workspaceProjectId ?? null}>
      {/* Anchored to the library upload entry (not centered): the centered
          fallback landed on top of the empty-stage 01 card on first paint,
          hiding the primary entry CTA. The upload stays mounted whenever the
          editor is, so the hint keeps its discoverability next to it. */}
      <FeatureHint surface="studio" target="studio-upload" />
      {/* Desktop-required gate (review #1): a timeline NLE needs a pointer and
          real width — a clipped 5-column editor on a phone is worse than an
          honest message. A true mobile editor would be a separate product. */}
      <div
        data-testid="studio-mobile-gate"
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 px-8 py-12 text-center lg:hidden"
      >
        <span className="glass grid h-14 w-14 place-items-center rounded-[var(--radius-md)] text-[color:var(--color-fg)]">
          <Clapperboard size={26} />
        </span>
        <div className="space-y-2">
          <h1 className="font-display text-[20px] font-medium text-[color:var(--color-fg)]">
            Монтаж — на компьютере
          </h1>
          <p className="mx-auto max-w-xs text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
            Видеоредактор рассчитан на большой экран и мышь — таймлайн, гизмо и инспектор не
            помещаются на телефоне. Открой Vertov на компьютере, чтобы смонтировать ролик.
          </p>
        </div>
        <a
          href={isAnonymous ? '/' : '/studio/projects'}
          className="press-inset inline-flex items-center gap-2 rounded-[var(--radius-sm)] border-[1.5px] border-[color:var(--color-line2)] px-4 py-2 text-[13px] font-medium text-[color:var(--color-fg)]"
        >
          {isAnonymous ? '← На главную' : '← К проектам'}
        </a>
      </div>
      <div className="hidden min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] overflow-hidden lg:grid">
        {/* ───────── Zone: Header (S1) — fixed app bar; no hero, no page scroll ───────── */}
        <StudioHeader
          projectTitle={projectTitle}
          isAnonymous={isAnonymous}
          workspaceProjectId={workspaceProjectId}
          save={save}
          exportBtnRef={exportBtnRef}
          exportOpen={exportOpen}
          setExportOpen={setExportOpen}
          playhead={playhead}
          totalDur={totalDur}
          setFormat={setFormat}
          exportRes={exportRes}
          setExportRes={setExportRes}
          exportFps={exportFps}
          setExportFps={setExportFps}
          exportFmt={exportFmt}
          setExportFmt={setExportFmt}
          onExport={onExport}
          timeline={timeline}
          busy={busy}
          phase={phase}
          cancelRender={cancelRender}
        />

        {/* ───────── Zone: Body — CapCut 5-zone shell (measured target dims):
          [76 rail][280 library][center: preview+timeline][0|310 inspector][56 right rail].
          All five span the FULL body height (single grid row) so both rails are
          full-height and the timeline lives INSIDE the center column, not under
          the rails. ───────── */}
        <div
          className="grid min-h-0 gap-2 overflow-hidden bg-[color:var(--color-bg)] p-2 transition-[grid-template-columns] duration-200 ease-out"
          style={{
            gridTemplateColumns: `76px 280px minmax(0,1fr) ${selection ? '310px' : '0px'} 56px`,
            gridTemplateRows: 'minmax(0,1fr)',
            gridTemplateAreas: '"rail library center inspector rightrail"',
          }}
        >
          {/* ── IconRail (72px) — library switcher; S4 fills the panels ── */}
          <Library
            libSection={libSection}
            setLibSection={setLibSection}
            dragOver={dragOver}
            setDragOver={setDragOver}
            onDropFiles={onDropFiles}
            importing={importing}
            upload={upload}
            clips={clips}
            timeline={timeline}
            addClip={addClip}
            addPip={addPip}
            history={history}
            libClip={libClip}
            patchClip={patchClip}
            music={music}
            setMusic={setMusic}
            voiceover={voiceover}
            setVoiceover={setVoiceover}
            addSfx={addSfx}
            busy={busy}
            uploadAudio={uploadAudio}
            apiUrl={apiUrl}
            selectedClip={selectedClip}
            startTxDrag={startTxDrag}
            addText={addText}
            autoCaption={autoCaption}
            autoCaptionWords={autoCaptionWords}
            engine={engine}
            setEngine={setEngine}
            localSupported={localSupported}
            asrProgress={asrProgress}
            popMode={popMode}
            setPopMode={setPopMode}
            popWordCount={popText?.words.length ?? 0}
            onClearPop={() => setPopText(null)}
            captioning={captioning}
            onSrtUpload={onSrtUpload}
          />

          {/* Center column (CapCut lv-layout-content): preview takes all spare
            height, the timeline is a fixed slab pinned to the bottom. */}
          <div className="flex min-h-0 flex-col gap-2" style={{ gridArea: 'center' }}>
            {(() => {
              const identified = tracks.flatMap((track) =>
                track.clips.filter((clip) => clip.assetId),
              );
              const unavailable = identified.some((clip) => clip.assetUnavailable !== false);
              const expiry = identified
                .map((clip) => clip.assetExpiresAt)
                .filter((value): value is string => !!value)
                .sort()[0];
              const expiringClip = expiry
                ? identified.find((clip) => clip.assetExpiresAt === expiry)
                : undefined;
              return unavailable || expiry ? (
                <AssetLifecycleNotice
                  unavailable={unavailable}
                  {...(expiry ? { expiresAt: expiry } : {})}
                  {...(!unavailable && expiringClip ? { assetUrl: expiringClip.url } : {})}
                />
              ) : null;
            })()}
            {/* ── Zone: Stage (preview) — flex:1; block flow inside so the aspect
              box keeps a definite width (mx-auto fills the cell). ── */}
            <PreviewStage
              isAnonymous={isAnonymous}
              hydrated={hydrated}
              timeline={timeline}
              phase={phase}
              setPhase={setPhase}
              playhead={playhead}
              totalDur={totalDur}
              dragOver={dragOver}
              setDragOver={setDragOver}
              onDropFiles={onDropFiles}
              importing={importing}
              upload={upload}
              cancelUpload={cancelUpload}
              clips={clips}
              addClip={addClip}
              format={format}
              setFormat={setFormat}
              stageBoxRef={stageBoxRef}
              bgColor={bgColor}
              ratioOpen={ratioOpen}
              setRatioOpen={setRatioOpen}
              safeZones={safeZones}
              setSafeZones={setSafeZones}
              selectedClip={selectedClip}
              selectedIdx={selectedIdx}
              duplicateClip={duplicateClip}
              splitAtPlayhead={splitAtPlayhead}
              setCropOpen={setCropOpen}
              removeClip={removeClip}
              patchClip={patchClip}
              setSelection={setSelection}
              clipVisual={clipVisual}
              clipWindow={clipWindow}
              videoEls={videoEls}
              markVid={markVid}
              vidStatus={vidStatus}
              sfx={sfx}
              sfxEls={sfxEls}
              music={music}
              voiceover={voiceover}
              musicEl={musicEl}
              voEl={voEl}
              upperClips={upperClips}
              ovEls={ovEls}
              patchUpperClip={patchUpperClip}
              selectedOverlayClip={selectedOverlayClip}
              flashOpacity={flashOpacity}
              liveTexts={liveTexts}
              livePop={livePop}
              togglePlay={togglePlay}
              playing={playing}
              onGizmoDown={onGizmoDown}
              snapGuides={snapGuides}
              gizmoTip={gizmoTip}
              pen={pen}
              shareCopied={shareCopied}
              setShareCopied={setShareCopied}
            />

            {/* ── Zone: Timeline — fixed slab at the bottom of the center column
              (CapCut bottom-part-container ≈ 230px). ── */}
            <Timeline
              canUndo={canUndo}
              undo={undo}
              canRedo={canRedo}
              redo={redo}
              snapOn={snapOn}
              setSnapOn={setSnapOn}
              pps={pps}
              userZoomed={userZoomed}
              zoomTo={zoomTo}
              fitZoom={fitZoom}
              upperClips={upperClips}
              music={music}
              voiceover={voiceover}
              sfx={sfx}
              setSfx={setSfx}
              isLocked={isLocked}
              toggleLock={toggleLock}
              allMuted={allMuted}
              setTimeline={setTimeline}
              scrollerRef={scrollerRef}
              trackWidth={trackWidth}
              ruler={ruler}
              onScrubDown={onScrubDown}
              onScrubMove={onScrubMove}
              onScrubUp={onScrubUp}
              selectedOverlayClip={selectedOverlayClip}
              setSelection={setSelection}
              snapSec={snapSec}
              setSnapGuide={setSnapGuide}
              patchUpperClip={patchUpperClip}
              removeOverlay={removeOverlay}
              onOverlayTrimDown={onOverlayTrimDown}
              onOverlayTrimMove={onOverlayTrimMove}
              onOverlayTrimUp={onOverlayTrimUp}
              apiUrl={apiUrl}
              timeline={timeline}
              selection={selection}
              multiSel={multiSel}
              clipStarts={clipStarts}
              reorderDrag={reorderDrag}
              setHoverClip={setHoverClip}
              hoverClip={hoverClip}
              startReorder={startReorder}
              reorderMoved={reorderMoved}
              selectClipAt={selectClipAt}
              splitAtPlayhead={splitAtPlayhead}
              duplicateClip={duplicateClip}
              setCropOpen={setCropOpen}
              removeClip={removeClip}
              patchClip={patchClip}
              onTrimPointerDown={onTrimPointerDown}
              onTrimPointerMove={onTrimPointerMove}
              onTrimPointerUp={onTrimPointerUp}
              selectedClip={selectedClip}
              selectedIdx={selectedIdx}
              moveKeyframe={moveKeyframe}
              playhead={playhead}
              txDragId={txDragId}
              texts={texts}
              onTextMoveDown={onTextMoveDown}
              onTextTrimDown={onTextTrimDown}
              onTextTrimMove={onTextTrimMove}
              onTextTrimUp={onTextTrimUp}
              totalDur={totalDur}
              snapGuide={snapGuide}
              beatsOn={beatsOn}
              beats={beats}
              bpm={bpm}
              beatBusy={beatBusy}
              toggleBeats={toggleBeats}
              setPlaying={setPlaying}
              scrub={scrub}
              timeFromClientX={timeFromClientX}
              togglePlay={togglePlay}
              playing={playing}
              addText={addText}
            />
          </div>

          {/* ── Zone: Inspector (panel) + right rail — extracted to _inspector/Inspector ── */}
          <Inspector
            selection={selection}
            selectedClip={selectedClip}
            selectedIdx={selectedIdx}
            selectedOverlayClip={selectedOverlayClip}
            selectedText={selectedText}
            patchClip={patchClip}
            patchUpperClip={patchUpperClip}
            removeClip={removeClip}
            removeOverlay={removeOverlay}
            removeText={removeText}
            patchText={patchText}
            freezeAtPlayhead={freezeAtPlayhead}
            inspTab={inspTab}
            setInspTab={setInspTab}
            playhead={playhead}
            clipWindow={clipWindow}
            hslChannel={hslChannel}
            setHslChannel={setHslChannel}
            animGroup={animGroup}
            setAnimGroup={setAnimGroup}
            animApplied={animApplied}
            applyAnim={applyAnim}
            animDur={animDur}
            setAnimDur={setAnimDur}
            animEasing={animEasing}
            setAnimEasing={setAnimEasing}
            bgColor={bgColor}
            setBgColor={setBgColor}
            totalDur={totalDur}
          />
        </div>
        {/* S5 Crop modal (CapCut subsystem B). Live: edits transform.crop, which
          the preview clip-path AND the ffmpeg crop chain both honour. */}
        {cropOpen && selectedClip && (
          <CropModal
            clip={selectedClip}
            setCropOpen={setCropOpen}
            patchClip={patchClip}
            format={format}
          />
        )}
      </div>
    </StudioProjectProvider>
  );
}

// Preview stage (Zone: Stage) — the flex:1 preview plate: header (playhead/dur),
// the hydration/empty gate, the aspect box with base + PiP <video> stacks, grade
// overlays, live text, transport, the floating layer toolbar, the transform
// gizmo, and the done/failed footers. Extracted VERBATIM from StudioClient
// (§C component-split); purely presentational — every handler/ref/state value
// arrives as a prop. The CSS-mirror helpers stay imported from _model so
// preview == export is unaffected.
'use client';

import Link from 'next/link';
import { assetSrc } from '@/lib/asset-src';
import {
  Loader2,
  Clapperboard,
  Scissors,
  Copy,
  FlipHorizontal,
  Crop,
  Trash2,
  Pause,
  Play,
  Download,
  Check,
  Grid3x3,
} from '../_icons';
import {
  DEFAULT_TRANSFORM,
  colorCss,
  FILTER_CSS,
  GRAIN_SVG,
  animAdjust,
  kfAdjust,
  clipGeometryStyle,
  clipOutDur,
  fmt,
  TEXT_FONT_CLASS,
  TEXT_DEFAULT_FRAC,
  plateTextColor,
} from '../_model';
import type {
  TAudio,
  TClip,
  TText,
  PopText,
  TSfx,
  Format,
  ExportPhase,
  Selection,
  StudioClip,
} from '../_model';
import type { PenMask } from '../usePenMask';
import { EmptyStage } from './EmptyStage';
import { RatioPicker } from './RatioPicker';
import { CanvasToolbar } from './CanvasToolbar';
import { PenMaskLayer } from './PenMaskLayer';

type ClipVisual = {
  visible: boolean;
  opacity: number;
  transform?: string;
  clipPath?: string;
  zBoost?: boolean;
};

export function PreviewStage({
  isAnonymous,
  hydrated,
  timeline,
  phase,
  setPhase,
  playhead,
  totalDur,
  // empty-stage / media import
  dragOver,
  setDragOver,
  onDropFiles,
  importing,
  upload,
  cancelUpload,
  clips,
  addClip,
  format,
  setFormat,
  // aspect box
  stageBoxRef,
  bgColor,
  ratioOpen,
  setRatioOpen,
  safeZones,
  setSafeZones,
  // selection + clip ops
  selectedClip,
  selectedIdx,
  duplicateClip,
  splitAtPlayhead,
  setCropOpen,
  removeClip,
  patchClip,
  setSelection,
  // preview engine
  clipVisual,
  clipWindow,
  videoEls,
  markVid,
  vidStatus,
  // timed sound effects (hidden <audio> per clip, synced by usePlayback)
  sfx,
  sfxEls,
  // music / voiceover tracks (hidden <audio>, synced by usePlayback — the
  // refs existed before this fix but were never attached to a DOM node, so
  // preview playback was silently muted for both)
  music,
  voiceover,
  musicEl,
  voEl,
  // overlays
  upperClips,
  ovEls,
  patchUpperClip,
  selectedOverlayClip,
  // veil + text + transport
  flashOpacity,
  liveTexts,
  livePop,
  togglePlay,
  playing,
  // gizmo
  onGizmoDown,
  snapGuides,
  gizmoTip,
  // freeform pen mask
  pen,
  // done footer
  shareCopied,
  setShareCopied,
}: {
  /** Pre-paywall anonymous browsing (2026-07-07 follow-up): hides "Открыть в
   *  архиве" — /gallery requires a real account, unlike Studio itself. */
  isAnonymous: boolean;
  hydrated: boolean;
  timeline: TClip[];
  phase: ExportPhase;
  setPhase: (p: ExportPhase) => void;
  playhead: number;
  totalDur: number;
  dragOver: boolean;
  setDragOver: (v: boolean) => void;
  onDropFiles: (files: FileList | null) => void;
  importing: boolean;
  upload: { pct: number; name: string } | null;
  cancelUpload: () => void;
  clips: StudioClip[];
  addClip: (url: string, assetId?: string) => void;
  format: Format;
  setFormat: (f: Format) => void;
  stageBoxRef: React.RefObject<HTMLDivElement | null>;
  bgColor: string | null;
  ratioOpen: boolean;
  setRatioOpen: React.Dispatch<React.SetStateAction<boolean>>;
  safeZones: boolean;
  setSafeZones: (fn: (v: boolean) => boolean) => void;
  selectedClip: TClip | null;
  selectedIdx: number;
  duplicateClip: (uid: string) => void;
  splitAtPlayhead: () => void;
  setCropOpen: (v: boolean) => void;
  removeClip: (uid: string) => void;
  patchClip: (uid: string, patch: Partial<TClip>) => void;
  setSelection: (s: Selection) => void;
  clipVisual: (i: number, t: number) => ClipVisual;
  clipWindow: (i: number) => { start: number; end: number };
  videoEls: React.RefObject<Map<string, HTMLVideoElement>>;
  markVid: (uid: string, s: 'buffering' | 'ready' | 'error') => void;
  vidStatus: Record<string, 'buffering' | 'ready' | 'error'>;
  sfx: TSfx[];
  sfxEls: React.RefObject<Map<string, HTMLAudioElement>>;
  music: TAudio | null;
  voiceover: TAudio | null;
  musicEl: React.RefObject<HTMLAudioElement | null>;
  voEl: React.RefObject<HTMLAudioElement | null>;
  upperClips: TClip[];
  ovEls: React.RefObject<Map<string, HTMLVideoElement>>;
  patchUpperClip: (uid: string, patch: Partial<TClip>) => void;
  selectedOverlayClip: TClip | null;
  flashOpacity: number;
  liveTexts: TText[];
  /** Word-pop caption («по словам»): the single word active at the playhead, plus
   * the shared style, or null. Rendered as one centered text like liveTexts. */
  livePop: { text: string; style: Omit<PopText, 'words'> } | null;
  togglePlay: () => void;
  playing: boolean;
  onGizmoDown: (mode: 'move' | 'scale' | 'rotate', e: React.PointerEvent) => void;
  snapGuides: { x: boolean; y: boolean };
  gizmoTip: string | null;
  pen: PenMask;
  shareCopied: boolean;
  setShareCopied: (v: boolean) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto rounded-[var(--radius-md)] bg-[color:var(--color-surface)] p-4 shadow-[var(--offset-sm)] ring-1 ring-inset ring-[color:var(--color-line)]/10">
      {/* Hidden <audio> per SFX — usePlayback attaches to sfxEls (keyed by uid,
        the same Map+callback-ref pattern as the clip videos) and drives play/
        seek/volume so the timed effect is audible in the live preview. */}
      {sfx.map((s) => (
        <audio
          key={s.uid}
          data-testid="sfx-audio"
          ref={(el) => {
            if (el) sfxEls.current.set(s.uid, el);
            else sfxEls.current.delete(s.uid);
          }}
          src={assetSrc(s.url)}
          preload="auto"
          className="hidden"
        />
      ))}
      {/* Hidden <audio> for music/voiceover — same DOM-attach pattern as the SFX
        elements above. usePlayback already seeks/plays/pauses via musicEl/voEl;
        those refs just never had an element to attach to (latent silent-preview
        bug — fixed here, not by touching usePlayback's sync logic). */}
      {music && (
        <audio
          data-testid="music-audio"
          ref={(el) => {
            musicEl.current = el;
          }}
          src={assetSrc(music.url)}
          preload="auto"
          className="hidden"
        />
      )}
      {voiceover && (
        <audio
          data-testid="voiceover-audio"
          ref={(el) => {
            voEl.current = el;
          }}
          src={assetSrc(voiceover.url)}
          preload="auto"
          className="hidden"
        />
      )}
      {/* Header only when an actual preview/result is shown — the empty
        stage owns the full plate (no header competing above it). */}
      {hydrated && (timeline.length > 0 || phase.kind === 'done') && (
        <div className="mb-2.5 flex shrink-0 items-baseline justify-between">
          <p className="label-eyebrow">
            {phase.kind === 'done' ? 'Готовый ролик' : 'Предпросмотр'}
          </p>
          <span className="tnum font-mono text-[11px] text-[color:var(--color-faint)]">
            {fmt(playhead)} / {fmt(totalDur)}
          </span>
        </div>
      )}
      {!hydrated ? (
        /* Don't flash the empty uploader before the saved project loads. */
        <div
          data-testid="stage-loading"
          className="grid min-h-0 flex-1 place-items-center rounded-[var(--radius-md)] bg-[color:var(--color-surface2)]"
        >
          <Loader2 size={22} className="seed-spin text-[color:var(--color-faint)]" />
        </div>
      ) : timeline.length === 0 && phase.kind !== 'done' ? (
        /* Empty stage = the entry point: drag-drop / pick-from-device /
         pick-from-platform-projects, plus the ratio choice up front. */
        <EmptyStage
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
        />
      ) : (
        <div
          ref={stageBoxRef}
          className="relative mx-auto my-auto"
          style={{
            aspectRatio: format.width / format.height,
            // Drive the box off a DEFINITE height so aspect-ratio resolves
            // the width. The parent is a flex column and `mx-auto` opts out
            // of the width-stretch, so a bare `max-height` + aspect-ratio
            // collapsed the box to 0×0 (blank preview while the timeline
            // filmstrip still showed). Height = viewport − app/studio
            // headers − timeline − label, leaving room for the gizmo
            // handles; `maxWidth` keeps a wide ratio from overflowing.
            height: 'min(calc(100vh - 420px), 540px)',
            maxWidth: '100%',
          }}
        >
          {/* Inner clipped surface — overflow-hidden so scaled clips clip
            to the frame (preview==export). The transform gizmo lives in
            the OUTER wrapper so its handles aren't clipped at the edges. */}
          <div
            className="absolute inset-0 overflow-hidden rounded-[var(--radius-md)] border-[1.5px] border-[color:var(--color-line)]"
            // Intentional canvas black (video-black stage, preview==export) — not a
            // design-token violation; no --color token is pure black.
            style={{ backgroundColor: bgColor ?? '#000000' }}
          >
            {/* Ratio chip (CapCut subsystem A) — on-canvas aspect picker. */}
            {phase.kind !== 'done' && (
              <RatioPicker
                format={format}
                setFormat={setFormat}
                ratioOpen={ratioOpen}
                setRatioOpen={setRatioOpen}
              />
            )}
            {/* Safe-zone axis toggle (CapCut subsystem, top-right of canvas). */}
            {phase.kind !== 'done' && (
              <button
                type="button"
                data-testid="safezone-toggle"
                aria-pressed={safeZones}
                title={safeZones ? 'Скрыть направляющие' : 'Безопасные зоны'}
                onClick={() => setSafeZones((v) => !v)}
                className={
                  'glass-menu absolute right-2 top-2 z-50 grid h-7 w-7 place-items-center rounded-[var(--radius-sm)] ring-1 ring-inset ring-[color:var(--color-line)]/20 ' +
                  (safeZones ? 'text-[color:var(--color-accent)]' : 'text-[color:var(--color-fg)]')
                }
              >
                <Grid3x3 size={13} />
              </button>
            )}
            {/* Title-safe (90%) inset + rule-of-thirds guides. */}
            {safeZones && phase.kind !== 'done' && (
              <div
                data-testid="safezone-guides"
                className="pointer-events-none absolute inset-0 z-20"
              >
                <div className="absolute inset-[5%] rounded-[2px] border-[1.5px] border-[color:var(--color-line-soft)]" />
                <div className="absolute inset-[10%] rounded-[2px] border-[1.5px] border-dashed border-[color:var(--color-line-soft)]" />
                <div className="absolute left-1/3 top-0 h-full w-px bg-white/15" />
                <div className="absolute left-2/3 top-0 h-full w-px bg-white/15" />
                <div className="absolute left-0 top-1/3 h-px w-full bg-white/15" />
                <div className="absolute left-0 top-2/3 h-px w-full bg-white/15" />
              </div>
            )}
            {/* Floating selection toolbar (CapCut subsystem J) — acts on the
          selected clip over the canvas. */}
            {selectedClip && phase.kind !== 'done' && !pen.active && (
              <CanvasToolbar
                clip={selectedClip}
                duplicateClip={duplicateClip}
                splitAtPlayhead={splitAtPlayhead}
                setCropOpen={setCropOpen}
                removeClip={removeClip}
                penActive={pen.active}
                onPen={pen.start}
              />
            )}
            {phase.kind === 'done' ? (
              <video
                src={assetSrc(phase.url)}
                data-testid="render-result"
                controls
                autoPlay
                loop
                className="h-full w-full object-contain"
              />
            ) : timeline.length === 0 ? (
              <div className="grid h-full w-full place-items-center text-center">
                <div className="flex flex-col items-center gap-3 px-6">
                  <Clapperboard size={26} className="text-[color:var(--color-line2)]" />
                  <p className="max-w-[18rem] text-[13px] text-[color:var(--color-muted-foreground)]">
                    Добавь клипы на дорожку, чтобы начать монтаж.
                  </p>
                </div>
              </div>
            ) : (
              <>
                {/* Stacked per-clip videos — the live composition. Earlier
              clips sit ABOVE later ones so fading the outgoing clip
              reveals the incoming underneath (crossfade approximation). */}
                {timeline.map((c, i) => {
                  const vis = clipVisual(i, playhead);
                  // E6/E7: entrance/exit + keyframe factors at the playhead
                  const tIn = playhead - clipWindow(i).start;
                  const anim = animAdjust(c, tIn, clipOutDur(c));
                  const kfa = kfAdjust(c, tIn);
                  anim.opacity *= kfa.opacity;
                  anim.transformExtra += kfa.transformExtra;
                  const geo = clipGeometryStyle(c);
                  // Compose the transition transform after the clip's own
                  // geometry + anim/keyframe transforms (don't clobber);
                  // a transition clip-path takes precedence over crop for
                  // the brief overlap window.
                  const composedTransform =
                    `${geo.transform ?? ''}${anim.transformExtra}${vis.transform ? ` ${vis.transform}` : ''}`.trim();
                  return (
                    <video
                      key={`${c.uid}:${c.assetUnavailable === false ? 'ready' : c.assetId ? 'pending' : 'external'}`}
                      ref={(el) => {
                        if (el) videoEls.current.set(c.uid, el);
                        else videoEls.current.delete(c.uid);
                      }}
                      src={c.assetId && c.assetUnavailable !== false ? undefined : assetSrc(c.url)}
                      data-asset-unavailable={c.assetUnavailable ? 'true' : undefined}
                      aria-label={c.assetUnavailable ? 'Материал недоступен' : undefined}
                      // Only the on-screen clip eagerly buffers; the rest
                      // stay at metadata so a long timeline doesn't open
                      // 20 full video streams at once.
                      preload={vis.visible ? 'auto' : 'metadata'}
                      playsInline
                      onLoadStart={() => markVid(c.uid, 'buffering')}
                      onWaiting={() => markVid(c.uid, 'buffering')}
                      onCanPlay={() => markVid(c.uid, 'ready')}
                      onPlaying={() => markVid(c.uid, 'ready')}
                      onError={() => markVid(c.uid, 'error')}
                      className="absolute inset-0 h-full w-full object-contain"
                      style={{
                        opacity: vis.visible ? vis.opacity * anim.opacity : 0,
                        // A geometric incoming clip (iris/zoom) lifts above
                        // its outgoing partner so the reveal reads on top.
                        zIndex: vis.zBoost ? timeline.length + 5 : timeline.length - i,
                        filter:
                          [FILTER_CSS[c.filter], colorCss(c.color)]
                            .filter((f) => f && f !== 'none')
                            .join(' ') || 'none',
                        visibility: vis.visible ? 'visible' : 'hidden',
                        ...geo,
                        ...(vis.clipPath ? { clipPath: vis.clipPath } : {}),
                        ...(composedTransform ? { transform: composedTransform } : {}),
                      }}
                    />
                  );
                })}
                {/* Buffering / failed state on the live clip — CapCut shows
                  a canvas chip instead of a silent black frame. */}
                {(() => {
                  const i = timeline.findIndex((_, idx) => clipVisual(idx, playhead).visible);
                  if (i < 0) return null;
                  const uid = timeline[i]!.uid;
                  const st = vidStatus[uid];
                  if (st === 'buffering')
                    return (
                      <div
                        data-testid="clip-buffering"
                        className="pointer-events-none absolute inset-0 z-[44] grid place-items-center"
                      >
                        <span className="glass-menu flex items-center gap-2 rounded-[var(--radius-sm)] px-3 py-1.5 text-[13px] text-[color:var(--color-muted-foreground)]">
                          <Loader2 size={14} className="seed-spin" /> Загрузка…
                        </span>
                      </div>
                    );
                  if (st === 'error')
                    return (
                      <div
                        data-testid="clip-error"
                        className="pointer-events-none absolute inset-0 z-[44] grid place-items-center"
                      >
                        <div className="glass-menu flex flex-col items-center gap-2 rounded-[var(--radius-md)] px-4 py-3 text-center">
                          <span className="text-[13px] text-[color:var(--color-muted-foreground)]">
                            Не удалось загрузить клип
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              markVid(uid, 'buffering');
                              videoEls.current.get(uid)?.load();
                            }}
                            className="press-inset pointer-events-auto rounded-[var(--radius-sm)] px-3 py-1 text-[11px] font-semibold text-[color:var(--color-fg)] ring-1 ring-inset ring-[color:var(--color-line)]/20"
                          >
                            Повторить
                          </button>
                        </div>
                      </div>
                    );
                  return null;
                })()}
                {/* E3: vignette + grain overlays (CSS can't filter these) —
              one pair per graded clip, tracking its visibility. */}
                {timeline.map((c, i) => {
                  const g = c.color;
                  if (!g || (!g.vignette && !g.grain)) return null;
                  const vis = clipVisual(i, playhead);
                  if (!vis.visible) return null;
                  return (
                    <div
                      key={`grade-${c.uid}`}
                      className="pointer-events-none absolute inset-0"
                      style={{ zIndex: timeline.length - i, opacity: vis.opacity }}
                      data-testid="grade-overlay"
                    >
                      {g.vignette > 0 && (
                        <div
                          className="absolute inset-0"
                          style={{
                            background: `radial-gradient(ellipse at center, transparent 52%, rgba(0,0,0,${(g.vignette / 100) * 0.55}) 100%)`,
                          }}
                        />
                      )}
                      {g.grain > 0 && (
                        <div
                          className="absolute inset-0 mix-blend-overlay"
                          style={{
                            backgroundImage: GRAIN_SVG,
                            opacity: (g.grain / 100) * 0.4,
                          }}
                        />
                      )}
                    </div>
                  );
                })}
                {/* E8/III.1: PiP overlays above the main stack. Rendered from
                  the CANONICAL upper-track clip so the preview honours the
                  full RENDERABLE instrument set (transform incl. rotate/crop,
                  colour grade, flips, static opacity, in/out animation) — the
                  exact set the worker bakes into the alpha layer, so
                  preview == export holds. Mask/blend/keyframes are gated out
                  of the overlay inspector (the layer path can't honour them). */}
                {upperClips.map((c) => {
                  const startSec = c.startSec ?? 0;
                  const len = Math.max(0.1, c.outSec - c.inSec);
                  const visible = playhead >= startSec && playhead < startSec + len;
                  const tr = c.transform ?? DEFAULT_TRANSFORM;
                  // Upper tracks render as STATIC overlays — the worker strips
                  // keyframes/anims from track clips (they'd break the alpha layer),
                  // so the preview must not animate them either (preview==export).
                  const flips = `${c.flipH ? ' scaleX(-1)' : ''}${c.flipV ? ' scaleY(-1)' : ''}`;
                  const cr = tr.crop;
                  const cropped = cr.left || cr.top || cr.right || cr.bottom;
                  const filter = [
                    c.filter !== 'none' ? FILTER_CSS[c.filter] : '',
                    colorCss(c.color),
                  ]
                    .filter(Boolean)
                    .join(' ');
                  return (
                    <video
                      key={`${c.uid}:${c.assetUnavailable === false ? 'ready' : c.assetId ? 'pending' : 'external'}`}
                      data-testid="pip-video"
                      ref={(el) => {
                        if (el) ovEls.current.set(c.uid, el);
                        else ovEls.current.delete(c.uid);
                      }}
                      src={c.assetId && c.assetUnavailable !== false ? undefined : assetSrc(c.url)}
                      data-asset-unavailable={c.assetUnavailable ? 'true' : undefined}
                      aria-label={c.assetUnavailable ? 'Материал недоступен' : undefined}
                      playsInline
                      preload="metadata"
                      onPointerDown={(e) => {
                        // Direct manipulation: drag the overlay in the preview to
                        // reposition it (transform.posX/posY). Selects on press; a
                        // press that doesn't move is just a select.
                        e.stopPropagation();
                        setSelection({ kind: 'overlay', uid: c.uid });
                        const stage = stageBoxRef.current;
                        if (!stage) return;
                        const rect = stage.getBoundingClientRect();
                        const sx = e.clientX;
                        const sy = e.clientY;
                        const sPosX = tr.posX;
                        const sPosY = tr.posY;
                        const clampP = (v: number) => Math.max(-100, Math.min(100, v));
                        const move = (ev: PointerEvent) => {
                          patchUpperClip(c.uid, {
                            transform: {
                              ...tr,
                              posX: Math.round(
                                clampP(sPosX + ((ev.clientX - sx) / rect.width) * 100),
                              ),
                              posY: Math.round(
                                clampP(sPosY + ((ev.clientY - sy) / rect.height) * 100),
                              ),
                            },
                          });
                        };
                        const up = () => {
                          window.removeEventListener('pointermove', move);
                          window.removeEventListener('pointerup', up);
                        };
                        window.addEventListener('pointermove', move);
                        window.addEventListener('pointerup', up);
                      }}
                      className="absolute z-[45] cursor-move touch-none rounded-[4px] shadow-[var(--offset-lg)]"
                      style={{
                        left: `calc(50% + ${tr.posX}%)`,
                        top: `calc(50% + ${tr.posY}%)`,
                        width: `${tr.scale * 100}%`,
                        transform: `translate(-50%, -50%) rotate(${tr.rotate}deg)${flips}`,
                        ...(cropped
                          ? {
                              clipPath: `inset(${cr.top * 100}% ${cr.right * 100}% ${cr.bottom * 100}% ${cr.left * 100}%)`,
                            }
                          : {}),
                        ...(filter ? { filter } : {}),
                        opacity: visible ? (c.opacity ?? 1) : 0,
                        visibility: visible ? 'visible' : 'hidden',
                        outline:
                          selectedOverlayClip?.uid === c.uid
                            ? '1.5px solid rgba(var(--accent-rgb),0.8)'
                            : 'none',
                      }}
                    />
                  );
                })}
                {/* Flash (dip-to-white) veil — above the clips, below text. */}
                {flashOpacity > 0 && (
                  <div
                    aria-hidden="true"
                    data-testid="flash-veil"
                    className="pointer-events-none absolute inset-0 z-30 bg-white"
                    style={{ opacity: flashOpacity }}
                  />
                )}
                {/* Live text overlays (render approximation of drawtext). */}
                {liveTexts.map((t) => {
                  const fadeP = t.fade
                    ? Math.min(
                        1,
                        (playhead - t.fromSec) / 0.3,
                        Math.max(0, (t.toSec - playhead) / 0.3),
                      )
                    : 1;
                  return (
                    <div
                      key={t.uid}
                      className={
                        'pointer-events-none absolute inset-x-0 z-30 flex justify-center px-[6%] ' +
                        (t.position === 'top'
                          ? 'top-[8%]'
                          : t.position === 'center'
                            ? 'top-1/2 -translate-y-1/2'
                            : 'bottom-[10%]')
                      }
                      style={{ opacity: Math.max(0, fadeP) }}
                    >
                      <span
                        className={
                          'text-center font-bold leading-tight text-white [text-shadow:0_1px_8px_rgba(0,0,0,0.7)] ' +
                          TEXT_FONT_CLASS[t.font]
                        }
                        style={{
                          // Mirror drawtext's height·sizeFrac by scaling the
                          // baseline clamp linearly with sizeFrac (default
                          // unchanged at ratio 1) → preview tracks export.
                          fontSize: (() => {
                            const s = (t.sizeFrac ?? TEXT_DEFAULT_FRAC) / TEXT_DEFAULT_FRAC;
                            return `clamp(${(12 * s).toFixed(1)}px, ${(6.5 * s).toFixed(2)}cqw, ${(42 * s).toFixed(0)}px)`;
                          })(),
                          ...(t.plate
                            ? {
                                backgroundColor: t.plate.color,
                                color: plateTextColor(t.plate.color),
                                // Uniform to match ffmpeg's boxborderw (0.35×fontsize on
                                // every side) — see apps/worker/src/studio-graph.ts.
                                padding: '0.35em',
                              }
                            : {}),
                        }}
                      >
                        {t.text}
                      </span>
                    </div>
                  );
                })}
                {/* Word-pop caption («по словам»): the active word, one centered
                    element mirroring the popText drawtext lane (font/size/plate). */}
                {livePop && (
                  <div
                    className={
                      'pointer-events-none absolute inset-x-0 z-30 flex justify-center px-[6%] ' +
                      (livePop.style.position === 'top'
                        ? 'top-[8%]'
                        : livePop.style.position === 'bottom'
                          ? 'bottom-[10%]'
                          : 'top-1/2 -translate-y-1/2')
                    }
                  >
                    <span
                      className={
                        'text-center font-bold leading-tight text-white [text-shadow:0_1px_8px_rgba(0,0,0,0.7)] ' +
                        TEXT_FONT_CLASS[livePop.style.font]
                      }
                      style={{
                        fontSize: (() => {
                          const s =
                            (livePop.style.sizeFrac ?? TEXT_DEFAULT_FRAC) / TEXT_DEFAULT_FRAC;
                          return `clamp(${(12 * s).toFixed(1)}px, ${(6.5 * s).toFixed(2)}cqw, ${(42 * s).toFixed(0)}px)`;
                        })(),
                        ...(livePop.style.plate
                          ? {
                              backgroundColor: livePop.style.plate.color,
                              color: plateTextColor(livePop.style.plate.color),
                              padding: '0.35em',
                            }
                          : {}),
                      }}
                    >
                      {livePop.text}
                    </span>
                  </div>
                )}
                {/* Transport overlay */}
                <button
                  type="button"
                  data-testid="transport-toggle"
                  onClick={togglePlay}
                  aria-label={playing ? 'Пауза' : 'Воспроизвести'}
                  className="absolute inset-0 z-40 grid place-items-center"
                >
                  <span
                    className={
                      'grid h-14 w-14 place-items-center rounded-[var(--radius-sm)] bg-black/80 ring-1 ring-inset ring-[color:var(--color-line)]/30 transition-opacity duration-200 ' +
                      (playing ? 'opacity-0 hover:opacity-100' : 'opacity-100')
                    }
                  >
                    {playing ? (
                      <Pause size={22} className="text-white" />
                    ) : (
                      <Play size={22} className="ml-1 text-white" />
                    )}
                  </span>
                </button>
              </>
            )}
          </div>

          {/* Floating contextual toolbar (CapCut §5) — quick layer actions
            above the selected clip in the preview, so common ops don't
            require a trip to the inspector. Reuses the same handlers. */}
          {phase.kind !== 'done' &&
            selectedClip &&
            selectedIdx >= 0 &&
            !pen.active &&
            clipVisual(selectedIdx, playhead).visible && (
              <div
                data-testid="layer-toolbar"
                className="pointer-events-auto absolute left-1/2 top-2 z-[44] flex -translate-x-1/2 items-center gap-0.5 rounded-[var(--radius-md)] bg-black/85 px-1 py-1 shadow-[var(--offset-sm)]"
              >
                {(
                  [
                    {
                      id: 'split',
                      title: 'Разрезать под плейхедом (S)',
                      icon: <Scissors size={15} />,
                      run: () => splitAtPlayhead(),
                    },
                    {
                      id: 'dup',
                      title: 'Дублировать',
                      icon: <Copy size={15} />,
                      run: () => duplicateClip(selectedClip.uid),
                    },
                    {
                      id: 'mirror',
                      title: 'Отразить по горизонтали',
                      icon: <FlipHorizontal size={15} />,
                      run: () => patchClip(selectedClip.uid, { flipH: !selectedClip.flipH }),
                    },
                    {
                      id: 'crop',
                      title: 'Кадрировать',
                      icon: <Crop size={15} />,
                      run: () => setCropOpen(true),
                    },
                    {
                      id: 'del',
                      title: 'Удалить клип (Del)',
                      icon: <Trash2 size={15} />,
                      danger: true,
                      run: () => removeClip(selectedClip.uid),
                    },
                  ] as const
                ).map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    title={b.title}
                    data-testid={`layer-tool-${b.id}`}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      b.run();
                    }}
                    className={
                      'grid h-7 w-7 place-items-center rounded-[var(--radius-sm)] text-white/85 transition-colors hover:bg-white/15 ' +
                      ((b as { danger?: boolean }).danger
                        ? 'hover:text-red-400'
                        : 'hover:text-white')
                    }
                  >
                    {b.icon}
                  </button>
                ))}
              </div>
            )}

          {/* Transform gizmo — in the UNCLIPPED wrapper so the handles
            aren't clipped at the frame edges. Edits the same transform
            model the inspector fields do, so preview==export holds. */}
          {phase.kind !== 'done' &&
            selectedClip &&
            selectedIdx >= 0 &&
            !pen.active &&
            clipVisual(selectedIdx, playhead).visible &&
            (() => {
              const t = { ...DEFAULT_TRANSFORM, ...selectedClip.transform };
              const inv = Math.min(2.2, 1 / t.scale);
              return (
                <div
                  className="pointer-events-none absolute inset-0 z-[41]"
                  data-testid="gizmo-layer"
                >
                  {snapGuides.x && (
                    <div className="absolute left-1/2 top-0 z-[42] h-full w-px -translate-x-1/2 bg-[color:var(--color-accent)]" />
                  )}
                  {snapGuides.y && (
                    <div className="absolute left-0 top-1/2 z-[42] h-px w-full -translate-y-1/2 bg-[color:var(--color-accent)]" />
                  )}
                  <div
                    data-testid="canvas-transform"
                    onPointerDown={(e) => onGizmoDown('move', e)}
                    className="pointer-events-auto absolute inset-0 cursor-move touch-none"
                    style={{
                      transform: `translate(${t.posX}%, ${t.posY}%) rotate(${t.rotate}deg) scale(${t.scale})`,
                      transformOrigin: 'center',
                    }}
                  >
                    <div className="absolute inset-0 ring-[1.5px] ring-inset ring-[rgba(var(--accent-rgb),0.9)]" />
                    {(
                      [
                        ['0%', '0%', 'cursor-nwse-resize'],
                        ['100%', '0%', 'cursor-nesw-resize'],
                        ['0%', '100%', 'cursor-nesw-resize'],
                        ['100%', '100%', 'cursor-nwse-resize'],
                      ] as const
                    ).map(([x, y, cur], idx) => (
                      <span
                        key={idx}
                        data-testid="gizmo-handle"
                        data-handle="scale"
                        onPointerDown={(e) => onGizmoDown('scale', e)}
                        className={
                          'absolute h-3 w-3 rounded-[2px] border-2 border-[color:var(--color-accent)] bg-white ' +
                          cur
                        }
                        style={{
                          left: x,
                          top: y,
                          transform: `translate(-50%,-50%) scale(${inv})`,
                        }}
                      />
                    ))}
                    <span
                      data-testid="gizmo-rotate"
                      data-handle="rotate"
                      onPointerDown={(e) => onGizmoDown('rotate', e)}
                      className="absolute left-1/2 top-0 h-3.5 w-3.5 cursor-grab rounded-[var(--radius-xs)] border-2 border-[color:var(--color-accent)] bg-white"
                      style={{ transform: `translate(-50%,-200%) scale(${inv})` }}
                    />
                  </div>
                  {gizmoTip && (
                    <div className="absolute bottom-2 left-1/2 z-[43] -translate-x-1/2 rounded-[var(--radius-sm)] bg-black/75 px-2.5 py-1 font-mono text-[11px] text-white">
                      {gizmoTip}
                    </div>
                  )}
                </div>
              );
            })()}

          {/* Freeform (pen) mask draw surface — outer wrapper so the path/anchors
            aren't clipped at the frame edges. Edits the same `mask` model the
            geq + CSS SVG mirror render, so preview==export holds. */}
          {phase.kind !== 'done' && selectedClip && pen.active && <PenMaskLayer pen={pen} />}
        </div>
      )}
      {phase.kind === 'done' && (
        <div className="mt-3 flex flex-wrap items-center gap-4 text-[13px]">
          <a
            href={assetSrc(phase.url)}
            download
            className="inline-flex items-center gap-1.5 text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)]"
          >
            <Download size={15} /> Скачать MP4
          </a>
          <button
            type="button"
            data-testid="share-link"
            onClick={() => {
              void navigator.clipboard?.writeText(phase.url).then(
                () => {
                  setShareCopied(true);
                  window.setTimeout(() => setShareCopied(false), 1800);
                },
                () => {},
              );
            }}
            className="inline-flex items-center gap-1.5 text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)]"
          >
            <Check
              size={15}
              className={shareCopied ? 'text-[color:var(--color-accent)]' : 'hidden'}
            />
            {shareCopied ? 'Ссылка скопирована' : 'Поделиться (просмотр)'}
          </button>
          {!isAnonymous && (
            <Link
              href="/gallery"
              className="text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)]"
            >
              Открыть в архиве
            </Link>
          )}
          <button
            type="button"
            onClick={() => setPhase({ kind: 'idle' })}
            className="text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)]"
          >
            Продолжить монтаж
          </button>
        </div>
      )}
      {phase.kind === 'failed' && (
        <p data-testid="studio-error" className="mt-3 text-[13px] text-destructive">
          Ошибка: {phase.message}
        </p>
      )}
    </div>
  );
}

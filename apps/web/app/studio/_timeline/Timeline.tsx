// Timeline (Zone: Timeline) — the fixed bottom slab: toolbar + track-header
// gutter + the scroller (ruler, overlay lane, base-clip video track with
// filmstrips / hover toolbar / trim / keyframes / transition junctions /
// reorder + insertion line, text lane, audio lanes, snap guide, playhead) +
// the transport row. Extracted VERBATIM from StudioClient (§C component-split);
// purely presentational — every handler/ref/state value arrives as a prop.
'use client';

import {
  Scissors,
  Copy,
  Crop,
  Trash2,
  Type,
  Plus,
  Pause,
  Play,
  VolumeX,
  LineVertical,
  Intersect,
  CircleHalf,
} from '../_icons';
import { clipOutDur, FILTER_CSS, TRANSITION_LABEL } from '../_model';
import type { TClip, TText, TAudio, TSfx, Transition, Selection } from '../_model';
import { cardVisual } from '../../../lib/visual-hash';
import { ClipFilmstrip, AudioLaneClip } from '../_components/timeline-clips';
import { TimelineToolbar } from './TimelineToolbar';
import { TrackHeaders } from './TrackHeaders';
import type { RulerTick } from './ruler';

export function Timeline({
  // toolbar
  canUndo,
  undo,
  canRedo,
  redo,
  snapOn,
  setSnapOn,
  pps,
  userZoomed,
  zoomTo,
  fitZoom,
  beatsOn,
  beats,
  bpm,
  beatBusy,
  toggleBeats,
  // track headers
  upperClips,
  music,
  voiceover,
  sfx,
  setSfx,
  isLocked,
  toggleLock,
  allMuted,
  setTimeline,
  // scroller geometry
  scrollerRef,
  trackWidth,
  ruler,
  // scrub
  onScrubDown,
  onScrubMove,
  onScrubUp,
  // overlay lane
  selectedOverlayClip,
  setSelection,
  snapSec,
  setSnapGuide,
  patchUpperClip,
  removeOverlay,
  onOverlayTrimDown,
  onOverlayTrimMove,
  onOverlayTrimUp,
  apiUrl,
  // base track
  timeline,
  selection,
  multiSel,
  clipStarts,
  reorderDrag,
  setHoverClip,
  hoverClip,
  startReorder,
  reorderMoved,
  selectClipAt,
  splitAtPlayhead,
  duplicateClip,
  setCropOpen,
  removeClip,
  patchClip,
  onTrimPointerDown,
  onTrimPointerMove,
  onTrimPointerUp,
  selectedClip,
  selectedIdx,
  moveKeyframe,
  playhead,
  txDragId,
  // text lane
  texts,
  onTextMoveDown,
  onTextTrimDown,
  onTextTrimMove,
  onTextTrimUp,
  // audio lanes
  totalDur,
  snapGuide,
  // playhead + transport
  setPlaying,
  scrub,
  timeFromClientX,
  togglePlay,
  playing,
  addText,
}: {
  canUndo: boolean;
  undo: () => void;
  canRedo: boolean;
  redo: () => void;
  snapOn: boolean;
  setSnapOn: React.Dispatch<React.SetStateAction<boolean>>;
  pps: number;
  userZoomed: React.MutableRefObject<boolean>;
  zoomTo: (next: number) => void;
  fitZoom: () => void;
  beatsOn: boolean;
  beats: number[];
  bpm: number | null;
  beatBusy: boolean;
  toggleBeats: (musicUrl: string | null) => void;
  upperClips: TClip[];
  music: TAudio | null;
  voiceover: TAudio | null;
  sfx: TSfx[];
  setSfx: React.Dispatch<React.SetStateAction<TSfx[]>>;
  isLocked: (id: string) => boolean;
  toggleLock: (id: string) => void;
  allMuted: boolean;
  setTimeline: React.Dispatch<React.SetStateAction<TClip[]>>;
  scrollerRef: React.RefObject<HTMLDivElement | null>;
  trackWidth: number;
  ruler: RulerTick[];
  onScrubDown: (e: React.PointerEvent) => void;
  onScrubMove: (e: React.PointerEvent) => void;
  onScrubUp: () => void;
  selectedOverlayClip: TClip | null;
  setSelection: (s: Selection) => void;
  snapSec: (sec: number) => number;
  setSnapGuide: (v: number | null) => void;
  patchUpperClip: (uid: string, patch: Partial<TClip>) => void;
  removeOverlay: (uid: string) => void;
  onOverlayTrimDown: (e: React.PointerEvent, o: TClip, edge: 'in' | 'out') => void;
  onOverlayTrimMove: (e: React.PointerEvent) => void;
  onOverlayTrimUp: () => void;
  apiUrl: string;
  timeline: TClip[];
  selection: Selection;
  multiSel: Set<string>;
  clipStarts: number[];
  reorderDrag: { uid: string; dx: number; insertIdx: number; lineSec: number } | null;
  setHoverClip: React.Dispatch<React.SetStateAction<string | null>>;
  hoverClip: string | null;
  startReorder: (e: React.PointerEvent, uid: string) => void;
  reorderMoved: React.MutableRefObject<boolean>;
  selectClipAt: (e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }, i: number) => void;
  splitAtPlayhead: () => void;
  duplicateClip: (uid: string) => void;
  setCropOpen: (v: boolean) => void;
  removeClip: (uid: string) => void;
  patchClip: (uid: string, patch: Partial<TClip>) => void;
  onTrimPointerDown: (e: React.PointerEvent, c: TClip, edge: 'in' | 'out') => void;
  onTrimPointerMove: (e: React.PointerEvent) => void;
  onTrimPointerUp: () => void;
  selectedClip: TClip | null;
  selectedIdx: number;
  moveKeyframe: (uid: string, oldT: number, newT: number) => void;
  playhead: number;
  txDragId: Transition | null;
  texts: TText[];
  onTextMoveDown: (e: React.PointerEvent, t: TText) => void;
  onTextTrimDown: (e: React.PointerEvent, t: TText, edge: 'from' | 'to') => void;
  onTextTrimMove: (e: React.PointerEvent) => void;
  onTextTrimUp: () => void;
  totalDur: number;
  snapGuide: number | null;
  setPlaying: React.Dispatch<React.SetStateAction<boolean>>;
  scrub: (t: number) => void;
  timeFromClientX: (clientX: number) => number;
  togglePlay: () => void;
  playing: boolean;
  addText: () => void;
}) {
  return (
    <div className="seed-scroll h-[238px] shrink-0 overflow-auto rounded-[var(--radius-md)] bg-[color:var(--color-surface)] p-2.5 shadow-[var(--offset-sm)] ring-1 ring-inset ring-[color:var(--color-line)]/10">
      <TimelineToolbar
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
        beatsOn={beatsOn}
        bpm={bpm}
        beatBusy={beatBusy}
        musicUrl={music?.url ?? null}
        toggleBeats={toggleBeats}
      />
      <div className="flex gap-2">
        {/* ── Track headers gutter (CapCut spec §5.2) — label · lock · mute per lane.
          Heights mirror the lanes in the scroller so rows stay aligned. ── */}
        <TrackHeaders
          upperClips={upperClips}
          music={music}
          voiceover={voiceover}
          isLocked={isLocked}
          toggleLock={toggleLock}
          allMuted={allMuted}
          setTimeline={setTimeline}
        />
        <div ref={scrollerRef} className="seed-scroll relative min-w-0 flex-1 overflow-x-auto pb-1">
          <div className="relative" style={{ width: trackWidth, minWidth: '100%' }}>
            {/* Ruler */}
            <div
              data-testid="timeline-ruler"
              onPointerDown={onScrubDown}
              onPointerMove={onScrubMove}
              onPointerUp={onScrubUp}
              className="relative h-5 cursor-col-resize touch-none select-none"
            >
              {ruler.map((t) => (
                <span
                  key={t.sec}
                  className={
                    'absolute bottom-0 border-l-[1.5px] ' +
                    (t.major
                      ? 'border-[color:var(--color-line)]/45'
                      : 'border-[color:var(--color-line)]/20')
                  }
                  style={{ left: t.sec * pps, height: t.major ? 11 : 5 }}
                >
                  {t.major && (
                    <span className="absolute -top-0.5 left-1 font-mono text-[11px] tabular-nums text-[color:var(--color-faint)]">
                      {t.label}
                    </span>
                  )}
                </span>
              ))}
              {/* Beat markers («Биты» toggle) — thin non-interactive hairlines
                over the ruler at each detected/regularized beat time. */}
              {beatsOn &&
                music &&
                beats.map((b) => (
                  <span
                    key={`beat-${b}`}
                    className="pointer-events-none absolute inset-y-0 w-px bg-[rgba(var(--accent-rgb),0.35)]"
                    style={{ left: (music.fromSec + b) * pps }}
                  />
                ))}
            </div>

            {/* III.3b: overlay clips render as a REAL stacked track above
              the base — filmstrip + label + hover toolbar, like a base
              clip (positioned absolutely by atSec). */}
            {upperClips.length > 0 && (
              <div
                data-testid="overlay-lane"
                className="relative mb-1 h-[48px] rounded-[var(--radius-sm)] bg-[color:var(--color-surface2)] ring-1 ring-inset ring-[color:var(--color-line)]/15"
              >
                {upperClips.map((o) => {
                  const w = Math.max(28, (o.outSec - o.inSec) * pps);
                  const sel = selectedOverlayClip?.uid === o.uid;
                  const at0 = o.startSec ?? 0;
                  return (
                    <div
                      key={o.uid}
                      className="group absolute top-1"
                      style={{ left: at0 * pps, width: w }}
                    >
                      <button
                        type="button"
                        data-testid="overlay-block"
                        onClick={() =>
                          !isLocked('overlay') && setSelection({ kind: 'overlay', uid: o.uid })
                        }
                        onPointerDown={(e) => {
                          const startX = e.clientX;
                          const startAt = at0;
                          const move = (ev: PointerEvent) => {
                            const raw = Math.max(
                              0,
                              Math.round((startAt + (ev.clientX - startX) / pps) * 10) / 10,
                            );
                            const snapped = snapSec(raw);
                            // §6.3: show the snap guide-line when the magnet pulls.
                            setSnapGuide(snapOn && Math.abs(snapped - raw) > 1e-3 ? snapped : null);
                            patchUpperClip(o.uid, { startSec: snapped });
                          };
                          const up = () => {
                            setSnapGuide(null);
                            window.removeEventListener('pointermove', move);
                            window.removeEventListener('pointerup', up);
                          };
                          window.addEventListener('pointermove', move);
                          window.addEventListener('pointerup', up);
                        }}
                        className={
                          'relative block h-[40px] w-full cursor-grab overflow-hidden rounded-[var(--radius-xs)] text-left ring-1 ring-inset transition-[box-shadow] ' +
                          (sel
                            ? 'z-10 ring-2 ring-[color:var(--color-accent)]'
                            : 'ring-[rgba(var(--accent-rgb),0.35)] hover:ring-[rgba(var(--accent-rgb),0.6)]')
                        }
                      >
                        <span className="pointer-events-none absolute inset-0 opacity-75">
                          {o.assetId && o.assetUnavailable !== false ? (
                            <span className="grid h-full place-items-center bg-red-950/80 text-[11px] font-semibold text-red-100">
                              Материал недоступен
                            </span>
                          ) : (
                            <ClipFilmstrip
                              url={o.url}
                              inSec={o.inSec}
                              outSec={o.outSec}
                              dur={o.outSec}
                              width={w}
                              filter="none"
                              muted={!!o.muted}
                              apiUrl={apiUrl}
                            />
                          )}
                        </span>
                        <span className="pointer-events-none absolute left-1 top-1 rounded-[2px] bg-black/55 px-1 text-[11px] font-semibold text-white">
                          PiP
                        </span>
                      </button>
                      {sel && (
                        <button
                          type="button"
                          data-testid="overlay-delete-quick"
                          title="Удалить наложение (Del)"
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            removeOverlay(o.uid);
                          }}
                          className="absolute right-3 top-0.5 z-40 grid h-5 w-5 place-items-center rounded-[var(--radius-xs)] bg-black/65 text-white/85 hover:text-red-400"
                        >
                          <Trash2 size={11} />
                        </button>
                      )}
                      {sel && (
                        <>
                          <span
                            data-testid="overlay-trim-in"
                            title="Обрезать начало"
                            onPointerDown={(e) => onOverlayTrimDown(e, o, 'in')}
                            onPointerMove={onOverlayTrimMove}
                            onPointerUp={onOverlayTrimUp}
                            className="absolute inset-y-0 left-0 z-30 w-2.5 cursor-ew-resize touch-none rounded-l-[var(--radius-xs)] bg-[color:var(--color-accent)]/85"
                          />
                          <span
                            data-testid="overlay-trim-out"
                            title="Обрезать конец"
                            onPointerDown={(e) => onOverlayTrimDown(e, o, 'out')}
                            onPointerMove={onOverlayTrimMove}
                            onPointerUp={onOverlayTrimUp}
                            className="absolute inset-y-0 right-0 z-30 w-2.5 cursor-ew-resize touch-none rounded-r-[var(--radius-xs)] bg-[color:var(--color-accent)]/85"
                          />
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Video track */}
            <div
              data-testid="timeline"
              onPointerDown={onScrubDown}
              onPointerMove={onScrubMove}
              onPointerUp={onScrubUp}
              className="relative h-[64px] touch-none rounded-[var(--radius-sm)] bg-[color:var(--color-surface2)] ring-1 ring-inset ring-[color:var(--color-line)]/15"
            >
              {timeline.map((c, i) => {
                const isPrimary = selection?.kind === 'clip' && selection.uid === c.uid;
                const isSel = isPrimary || multiSel.has(c.uid);
                const left = (clipStarts[i] ?? 0) * pps;
                const width = clipOutDur(c) * pps;
                return (
                  <div
                    key={c.uid}
                    onMouseEnter={() => setHoverClip(c.uid)}
                    onMouseLeave={() => setHoverClip((h) => (h === c.uid ? null : h))}
                    style={{
                      left,
                      width,
                      background: cardVisual(c.uid).background,
                      ...(reorderDrag?.uid === c.uid
                        ? { transform: `translateX(${reorderDrag.dx}px)` }
                        : {}),
                    }}
                    className={
                      // selected = a crisp 2px outline (CapCut clip-selected).
                      // The container is NON-interactive so the per-clip toolbar
                      // buttons below are valid SIBLINGS, not nested-interactive.
                      'group absolute top-1 h-[56px] rounded-[var(--radius-sm)] ring-inset transition-[box-shadow] duration-100 ' +
                      (reorderDrag?.uid === c.uid
                        ? 'z-50 opacity-80 shadow-[6px_6px_0_0_var(--color-shadow)] ring-2 ring-[color:var(--color-accent)] '
                        : isSel
                          ? 'z-10 ring-2 ring-[color:var(--color-accent)]'
                          : 'ring-1 ring-[color:var(--color-line2)] hover:ring-[color:var(--color-line)]/40')
                    }
                  >
                    {/* Selection + drag surface — a real <button> (keyboard-
                      selectable, Enter selects) so the toolbar buttons are
                      valid siblings, not nested interactive controls. */}
                    <button
                      type="button"
                      data-testid="timeline-clip"
                      aria-label={`Клип ${i + 1}`}
                      aria-pressed={isSel}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        startReorder(e, c.uid);
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (isLocked('video')) return;
                        // a drag emits a trailing click — swallow it so a
                        // reorder doesn't also fire selection.
                        if (reorderMoved.current) return;
                        selectClipAt(e, i);
                      }}
                      className="absolute inset-0 cursor-grab touch-none overflow-hidden rounded-[var(--radius-sm)] active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)]"
                    >
                      {c.assetId && c.assetUnavailable !== false ? (
                        <span className="grid h-full place-items-center bg-red-950/80 text-[11px] font-semibold text-red-100">
                          Материал недоступен
                        </span>
                      ) : (
                        <ClipFilmstrip
                          url={c.url}
                          inSec={c.inSec}
                          outSec={c.outSec}
                          dur={c.dur}
                          width={width}
                          filter={FILTER_CSS[c.filter]}
                          muted={c.muted}
                          apiUrl={apiUrl}
                        />
                      )}
                      <span className="tnum absolute left-1 top-0.5 rounded-[3px] bg-black/55 px-1 font-mono text-[11px] text-white/80">
                        {String(i + 1).padStart(2, '0')}
                        {c.speed !== 1 ? ` ${c.speed}×` : ''}
                      </span>
                      {c.muted && (
                        <VolumeX size={10} className="absolute bottom-1 left-1 text-white/70" />
                      )}
                    </button>
                    {/* Per-clip hover toolbar (CapCut spec §6) — quick
                      split / duplicate / crop / delete on the clip itself,
                      no round-trip to the inspector. A SIBLING of the clip
                      button (not nested); the pointer-down stop keeps a press
                      on it from reaching the track scrubber. */}
                    {!isLocked('video') && (
                      <div
                        data-testid="clip-hover-toolbar"
                        onPointerDown={(e) => e.stopPropagation()}
                        className={
                          'glass-menu absolute right-1 top-1 z-30 flex items-center gap-0.5 rounded-[var(--radius-sm)] p-0.5 shadow-[var(--offset-sm)] ring-1 ring-inset ring-[color:var(--color-line)]/20 transition-opacity duration-100 ' +
                          (hoverClip === c.uid && !isSel
                            ? 'opacity-100'
                            : 'pointer-events-none opacity-0')
                        }
                      >
                        {[
                          {
                            id: 'split',
                            title: 'Разрезать под плейхедом (S)',
                            icon: <Scissors size={11} />,
                            run: () => {
                              setSelection({ kind: 'clip', uid: c.uid });
                              splitAtPlayhead();
                            },
                          },
                          {
                            id: 'dup',
                            title: 'Дублировать',
                            icon: <Copy size={11} />,
                            run: () => duplicateClip(c.uid),
                          },
                          {
                            id: 'crop',
                            title: 'Кадрировать',
                            icon: <Crop size={11} />,
                            run: () => {
                              setSelection({ kind: 'clip', uid: c.uid });
                              setCropOpen(true);
                            },
                          },
                          {
                            id: 'del',
                            title: 'Удалить (Del)',
                            icon: <Trash2 size={11} />,
                            danger: true,
                            run: () => removeClip(c.uid),
                          },
                        ].map((b) => (
                          <button
                            key={b.id}
                            type="button"
                            title={b.title}
                            data-testid={`clip-tool-${b.id}`}
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation();
                              b.run();
                            }}
                            className={
                              'grid h-5 w-5 place-items-center rounded-[var(--radius-xs)] text-[color:var(--color-muted-foreground)] hover:bg-[color:var(--color-surface2)] ' +
                              (b.danger
                                ? 'hover:text-destructive'
                                : 'hover:text-[color:var(--color-fg)]')
                            }
                          >
                            {b.icon}
                          </button>
                        ))}
                      </div>
                    )}
                    {/* Trim handles — only on a lone selection (trimming a
                      whole multi-pick is meaningless). */}
                    {isPrimary && multiSel.size <= 1 && (
                      <>
                        <span
                          data-testid="trim-in"
                          onPointerDown={(e) => onTrimPointerDown(e, c, 'in')}
                          onPointerMove={onTrimPointerMove}
                          onPointerUp={onTrimPointerUp}
                          className="absolute inset-y-0 left-0 z-20 w-2.5 cursor-ew-resize touch-none rounded-l-[var(--radius-sm)] bg-[color:var(--color-accent)]/85"
                        />
                        <span
                          data-testid="trim-out"
                          onPointerDown={(e) => onTrimPointerDown(e, c, 'out')}
                          onPointerMove={onTrimPointerMove}
                          onPointerUp={onTrimPointerUp}
                          className="absolute inset-y-0 right-0 z-20 w-2.5 cursor-ew-resize touch-none rounded-r-[var(--radius-sm)] bg-[color:var(--color-accent)]/85"
                        />
                      </>
                    )}
                  </div>
                );
              })}
              {/* §6.5: insertion-gap line — where the dragged clip will drop,
                so reordering shows a real gap preview (not a silent swap). */}
              {reorderDrag && (
                <div
                  data-testid="reorder-line"
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-y-0 z-40 w-0.5 -translate-x-1/2 rounded bg-[color:var(--color-accent)]"
                  style={{ left: reorderDrag.lineSec * pps }}
                >
                  <span className="absolute -top-1 left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 rounded-[1px] bg-[color:var(--color-accent)]" />
                </div>
              )}
              {/* S2: keyframe lane — draggable diamonds for the selected clip's
                keys (same model the inspector edits; CapCut shows keys on the
                clip so timing is editable without opening a panel). */}
              {selectedClip?.keyframes &&
                (() => {
                  const start = clipStarts[selectedIdx] ?? 0;
                  const maxT = clipOutDur(selectedClip);
                  const times = [
                    ...new Set(
                      (
                        Object.values(selectedClip.keyframes) as (
                          | { t: number; v: number }[]
                          | undefined
                        )[]
                      ).flatMap((arr) => arr?.map((k) => k.t) ?? []),
                    ),
                  ].sort((a, b) => a - b);
                  return times.map((t) => (
                    <button
                      key={`kf-lane-${t}`}
                      type="button"
                      data-testid="kf-diamond"
                      title="Перетащи ключевой кадр (добавить/убрать — в инспекторе)"
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        (e.target as HTMLElement).setPointerCapture(e.pointerId);
                        const startX = e.clientX;
                        let cur = t;
                        const mv = (ev: PointerEvent) => {
                          const nt = Math.max(0, Math.min(maxT, t + (ev.clientX - startX) / pps));
                          moveKeyframe(selectedClip.uid, cur, nt);
                          cur = nt;
                        };
                        const up = () => {
                          window.removeEventListener('pointermove', mv);
                          window.removeEventListener('pointerup', up);
                        };
                        window.addEventListener('pointermove', mv);
                        window.addEventListener('pointerup', up);
                      }}
                      style={{ left: (start + t) * pps }}
                      className={
                        'absolute bottom-0.5 z-20 h-2.5 w-2.5 -translate-x-1/2 rotate-45 cursor-ew-resize rounded-[var(--radius-xs)] bg-[color:var(--color-accent)] transition-[filter] hover:brightness-125 ' +
                        (Math.abs(start + t - playhead) < 0.12
                          ? 'scale-125 ring-2 ring-[color:var(--color-line)]'
                          : 'ring-1 ring-[color:var(--color-line)]')
                      }
                    />
                  ));
                })()}
              {/* Transition toggles at clip boundaries */}
              {timeline.slice(0, -1).map((c, i) => {
                const x = (clipStarts[i + 1] ?? 0) * pps;
                return (
                  <button
                    key={`tr-${c.uid}`}
                    type="button"
                    data-testid="transition-btn"
                    data-uid={c.uid}
                    title={
                      txDragId
                        ? `Отпусти, чтобы поставить «${TRANSITION_LABEL[txDragId]}»`
                        : `Переход: ${TRANSITION_LABEL[c.transition]} (клик — сменить · перетащи переход из библиотеки)`
                    }
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      const order: Transition[] = ['cut', 'crossfade', 'dip'];
                      const next = order[(order.indexOf(c.transition) + 1) % order.length]!;
                      patchClip(c.uid, { transition: next });
                    }}
                    style={{ left: x }}
                    className={
                      'absolute top-1/2 z-30 grid h-6 w-6 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-[var(--radius-sm)] ring-1 ring-inset transition-[colors,transform] ' +
                      (txDragId
                        ? 'scale-125 bg-[color:var(--color-accent)] text-[color:var(--color-primary-foreground)] ring-2 ring-[color:var(--color-line)]'
                        : c.transition === 'cut'
                          ? 'bg-[color:var(--color-surface)] text-[color:var(--color-muted-foreground)] ring-[color:var(--color-line)]/25 hover:text-[color:var(--color-fg)]'
                          : 'bg-[color:var(--color-accent)] text-[color:var(--color-primary-foreground)] ring-transparent')
                    }
                  >
                    {c.transition === 'cut' ? (
                      <LineVertical size={12} />
                    ) : c.transition === 'crossfade' ? (
                      <Intersect size={12} />
                    ) : (
                      <CircleHalf size={12} />
                    )}
                  </button>
                );
              })}
            </div>

            {/* Text track */}
            <div
              className="relative mt-1 h-7 rounded-[var(--radius-sm)] bg-[color:var(--color-surface2)] ring-1 ring-inset ring-[color:var(--color-line)]/15"
              onPointerDown={onScrubDown}
              onPointerMove={onScrubMove}
              onPointerUp={onScrubUp}
            >
              {texts.map((t) => {
                const isSel = selection?.kind === 'text' && selection.uid === t.uid;
                const w = Math.max(24, (t.toSec - t.fromSec) * pps);
                return (
                  <div
                    key={t.uid}
                    className="absolute top-0.5"
                    style={{ left: t.fromSec * pps, width: w }}
                  >
                    <button
                      type="button"
                      data-testid="text-block"
                      onPointerDown={(e) => {
                        if (isLocked('text')) return;
                        onTextMoveDown(e, t);
                      }}
                      style={{ width: w }}
                      className={
                        'flex h-6 cursor-grab items-center gap-1 overflow-hidden rounded-[var(--radius-xs)] border-[1.5px] px-1.5 text-left text-[11px] transition-colors ' +
                        (isSel
                          ? 'border-[color:var(--color-accent)] bg-[rgba(var(--accent-rgb),0.2)] text-[color:var(--color-fg)]'
                          : 'border-[color:var(--color-line2)] bg-[color:var(--color-surface)] text-[color:var(--color-muted-foreground)]')
                      }
                    >
                      <Type size={9} className="shrink-0" />
                      <span className="truncate">{t.text || '…'}</span>
                    </button>
                    {isSel && (
                      <>
                        <span
                          data-testid="text-trim-from"
                          title="Сдвинуть начало титра"
                          onPointerDown={(e) => onTextTrimDown(e, t, 'from')}
                          onPointerMove={onTextTrimMove}
                          onPointerUp={onTextTrimUp}
                          className="absolute inset-y-0 left-0 z-30 w-2 cursor-ew-resize touch-none rounded-l-[var(--radius-xs)] bg-[color:var(--color-accent)]/85"
                        />
                        <span
                          data-testid="text-trim-to"
                          title="Сдвинуть конец титра"
                          onPointerDown={(e) => onTextTrimDown(e, t, 'to')}
                          onPointerMove={onTextTrimMove}
                          onPointerUp={onTextTrimUp}
                          className="absolute inset-y-0 right-0 z-30 w-2 cursor-ew-resize touch-none rounded-r-[var(--radius-xs)] bg-[color:var(--color-accent)]/85"
                        />
                      </>
                    )}
                  </div>
                );
              })}
              {texts.length === 0 && (
                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[11px] text-[color:var(--color-faint)]">
                  Титры
                </span>
              )}
            </div>

            {/* Audio lanes with real browser-decoded waveforms (S2). */}
            {music && (
              <div
                data-testid="music-lane"
                className="relative mt-1 h-9 rounded-[var(--radius-sm)] bg-[color:var(--color-surface2)] ring-1 ring-inset ring-[color:var(--color-line)]/15"
              >
                <AudioLaneClip
                  url={music.url}
                  name={music.name}
                  left={music.fromSec * pps}
                  width={Math.max(8, (totalDur - music.fromSec) * pps)}
                  accent
                  apiUrl={apiUrl}
                />
              </div>
            )}
            {voiceover && (
              <div
                data-testid="vo-lane"
                className="relative mt-1 h-9 rounded-[var(--radius-sm)] bg-[color:var(--color-surface2)] ring-1 ring-inset ring-[color:var(--color-line)]/15"
              >
                <AudioLaneClip
                  url={voiceover.url}
                  name={voiceover.name}
                  left={voiceover.fromSec * pps}
                  width={Math.max(8, (totalDur - voiceover.fromSec) * pps)}
                  accent={false}
                  apiUrl={apiUrl}
                />
              </div>
            )}

            {/* SFX lane — timed sound-effect chips at their atSec. Click selects
              nothing fancy; ✕ removes; horizontal drag adjusts atSec (snapped). */}
            {sfx.length > 0 && (
              <div
                data-testid="sfx-lane"
                className="relative mt-1 h-8 rounded-[var(--radius-sm)] bg-[color:var(--color-surface2)] ring-1 ring-inset ring-[color:var(--color-line)]/15"
              >
                {sfx.map((s) => {
                  const w = Math.max(28, (s.durSec ?? 1) * pps);
                  const startDrag = (e: React.PointerEvent) => {
                    e.preventDefault();
                    e.stopPropagation();
                    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
                    const move = (ev: PointerEvent) => {
                      const raw = Math.max(0, Math.min(timeFromClientX(ev.clientX), totalDur));
                      const at = Math.round(snapSec(raw) * 10) / 10;
                      setSnapGuide(at);
                      setSfx((prev) =>
                        prev.map((x) => (x.uid === s.uid ? { ...x, atSec: at } : x)),
                      );
                    };
                    const up = () => {
                      window.removeEventListener('pointermove', move);
                      window.removeEventListener('pointerup', up);
                      setSnapGuide(null);
                    };
                    window.addEventListener('pointermove', move);
                    window.addEventListener('pointerup', up);
                  };
                  return (
                    <div
                      key={s.uid}
                      data-testid="sfx-chip"
                      title={`${s.name} · ${s.atSec.toFixed(1)}s`}
                      onPointerDown={startDrag}
                      style={{ left: s.atSec * pps, width: w }}
                      className="absolute inset-y-1 flex cursor-ew-resize touch-none items-center gap-1 overflow-hidden rounded-[var(--radius-xs)] bg-[color:var(--color-accent)]/25 px-1.5 ring-1 ring-inset ring-[color:var(--color-accent)]/50"
                    >
                      <span className="truncate text-[11px] font-medium text-[color:var(--color-fg)]">
                        {s.name}
                      </span>
                      <button
                        type="button"
                        data-testid="sfx-remove"
                        title="Убрать звук"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSfx((prev) => prev.filter((x) => x.uid !== s.uid));
                        }}
                        className="ml-auto grid h-3.5 w-3.5 shrink-0 place-items-center rounded-[2px] text-[11px] leading-none text-[color:var(--color-muted-foreground)] hover:bg-black/20 hover:text-[color:var(--color-fg)]"
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {/* §6.3: snap guide-line — a dashed vertical rule shown while a
              trim/drag locks onto the playhead or a project bound, so the
              magnet's behaviour is visible (CapCut draws the same line). */}
            {snapGuide != null && (
              <div
                data-testid="snap-guide"
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 z-30 w-px"
                style={{
                  left: snapGuide * pps,
                  backgroundImage:
                    'repeating-linear-gradient(to bottom, var(--color-accent) 0 4px, transparent 4px 8px)',
                }}
              />
            )}

            {/* Playhead — CapCut spec: a 2px body (periwinkle accent) with
            a clear grabbable head; a hairline dark edge lets it read over
            any clip colour. Source: capcut_css playhead (2px body + ruler head). */}
            {timeline.length > 0 && (
              <div
                data-testid="playhead"
                className="pointer-events-none absolute bottom-0 top-0 z-40 w-0.5 bg-[color:var(--color-accent)] shadow-[0_0_0_0.5px_rgba(0,0,0,0.45)]"
                style={{ left: playhead * pps }}
              >
                {/* The HEAD is a real grab handle — drag it to scrub. The
                  body stays pointer-events-none so it never eats clip
                  clicks. (Generous hit-box around the small visible nub.) */}
                <button
                  type="button"
                  data-testid="playhead-handle"
                  aria-label="Перетащи плейхед"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    (e.target as HTMLElement).setPointerCapture(e.pointerId);
                    setPlaying(false);
                    const move = (ev: PointerEvent) => scrub(snapSec(timeFromClientX(ev.clientX)));
                    const up = () => {
                      window.removeEventListener('pointermove', move);
                      window.removeEventListener('pointerup', up);
                    };
                    window.addEventListener('pointermove', move);
                    window.addEventListener('pointerup', up);
                  }}
                  className="pointer-events-auto absolute -left-[7px] -top-0.5 h-4 w-4 cursor-ew-resize touch-none rounded-b-[3px] p-0"
                >
                  <span className="absolute left-[2px] top-0.5 h-2.5 w-3 rounded-b-[3px] bg-[color:var(--color-accent)] shadow-[1px_1px_0_0_var(--color-shadow)]" />
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Transport row under the timeline */}
      <div className="mt-1.5 flex items-center justify-between px-1">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={togglePlay}
            disabled={timeline.length === 0}
            aria-label={playing ? 'Пауза' : 'Воспроизвести'}
            className="press-inset grid h-8 w-8 place-items-center rounded-[var(--radius-sm)] bg-[color:var(--color-surface2)] text-[color:var(--color-fg)] ring-1 ring-inset ring-[color:var(--color-line)]/15 hover:bg-[color:var(--color-surface)] disabled:opacity-40"
          >
            {playing ? <Pause size={13} /> : <Play size={13} className="ml-0.5" />}
          </button>
          <button
            type="button"
            onClick={splitAtPlayhead}
            disabled={timeline.length === 0}
            title="Разрезать под плейхедом (S)"
            className="press-inset grid h-8 w-8 place-items-center rounded-[var(--radius-sm)] text-[color:var(--color-muted-foreground)] hover:bg-[color:var(--color-surface2)] hover:text-[color:var(--color-fg)] disabled:opacity-40"
          >
            <Scissors size={13} />
          </button>
        </div>
        <button
          type="button"
          data-testid="add-text"
          onClick={() => addText()}
          disabled={timeline.length === 0}
          className="press-inset inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-sm)] border-[1.5px] border-[color:var(--color-line2)] px-3 text-[13px] font-medium text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)] disabled:opacity-40"
        >
          <Plus size={13} /> Титр
        </button>
      </div>
    </div>
  );
}

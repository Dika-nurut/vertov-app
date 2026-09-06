// Inspector (Zone: Inspector + right rail) — the selection switch that docks the
// context panel (base clip → MainPanel/Speed/Animation/Audio/Background/Smart,
// overlay → OverlayInspector, text → TextInspector, nothing → the 3-step hint)
// plus the persistent right icon rail that picks the active section. Extracted
// VERBATIM from StudioClient (§C component-split); purely presentational — every
// handler/state value arrives as a prop. Each child panel keeps its own imports.
'use client';

import {
  Rewind,
  Snowflake,
  FlipHorizontal,
  FlipVertical,
  Trash2,
  Plus,
  Scissors,
  Film,
} from '../_icons';
import { INSPECTOR_TABS, TEXT_TABS } from '../_model';
import type { TClip, TText, Selection, InspectorTab, HslChannel, AnimPreset } from '../_model';
import { MainPanel } from './MainPanel';
import { SpeedPanel } from './SpeedPanel';
import { AnimationPanel } from './AnimationPanel';
import { AudioPanel } from './AudioPanel';
import { BackgroundPanel } from './BackgroundPanel';
import { SmartPanel } from './SmartPanel';
import { OverlayInspector, OVERLAY_TABS } from './OverlayInspector';
import { TextInspector } from './TextInspector';
import type { EasingId } from '../../../lib/studio-easing';

export function Inspector({
  selection,
  selectedClip,
  selectedIdx,
  selectedOverlayClip,
  selectedText,
  patchClip,
  patchUpperClip,
  removeClip,
  removeOverlay,
  removeText,
  patchText,
  freezeAtPlayhead,
  inspTab,
  setInspTab,
  playhead,
  clipWindow,
  hslChannel,
  setHslChannel,
  animGroup,
  setAnimGroup,
  animApplied,
  applyAnim,
  animDur,
  setAnimDur,
  animEasing,
  setAnimEasing,
  bgColor,
  setBgColor,
  totalDur,
}: {
  selection: Selection;
  selectedClip: TClip | null;
  selectedIdx: number;
  selectedOverlayClip: TClip | null;
  selectedText: TText | null;
  patchClip: (uid: string, patch: Partial<TClip>) => void;
  patchUpperClip: (uid: string, patch: Partial<TClip>) => void;
  removeClip: (uid: string) => void;
  removeOverlay: (uid: string) => void;
  removeText: (uid: string) => void;
  patchText: (uid: string, patch: Partial<TText>) => void;
  freezeAtPlayhead: () => void;
  inspTab: InspectorTab;
  setInspTab: React.Dispatch<React.SetStateAction<InspectorTab>>;
  playhead: number;
  clipWindow: (i: number) => { start: number; end: number };
  hslChannel: HslChannel;
  setHslChannel: React.Dispatch<React.SetStateAction<HslChannel>>;
  animGroup: 'in' | 'out' | 'combo';
  setAnimGroup: React.Dispatch<React.SetStateAction<'in' | 'out' | 'combo'>>;
  animApplied: Record<string, string>;
  applyAnim: (uid: string, preset: AnimPreset | null, durSec: number) => void;
  animDur: number;
  setAnimDur: React.Dispatch<React.SetStateAction<number>>;
  animEasing: EasingId;
  setAnimEasing: React.Dispatch<React.SetStateAction<EasingId>>;
  bgColor: string | null;
  setBgColor: (value: string | null) => void;
  totalDur: number;
}) {
  return (
    <>
      {/* ── Zone: Inspector — docks 0→320px on selection (CapCut) ── */}
      <aside
        className={
          'min-h-0 overflow-y-auto overflow-x-hidden ' +
          (selection
            ? 'rounded-[var(--radius-md)] bg-[color:var(--color-surface)] p-3 shadow-[var(--offset-sm)] ring-1 ring-inset ring-[color:var(--color-line)]/10'
            : '')
        }
        style={{ gridArea: 'inspector' }}
      >
        <p className="label-eyebrow mb-3">Параметры</p>
        {selectedClip ? (
          <div
            className="glass space-y-4 rounded-[var(--radius-md)] p-4"
            data-testid="clip-inspector"
          >
            <div className="flex items-center justify-between">
              <span className="text-[13px] font-semibold text-[color:var(--color-fg)]">
                Клип {selectedIdx + 1}
              </span>
              {/* Split lives on the timeline now (transport row + per-clip
                hover toolbar) — the inspector header keeps only the per-clip
                ops with no timeline home: reverse / freeze / flip / delete. */}
              <div className="flex items-center gap-1">
                {/* E4 toolbar: reverse / freeze / flip */}
                <button
                  type="button"
                  title="Развернуть (играть задом наперёд)"
                  data-testid="clip-reverse"
                  aria-pressed={Boolean(selectedClip.reversed)}
                  disabled={Boolean(selectedClip.freeze)}
                  onClick={() => patchClip(selectedClip.uid, { reversed: !selectedClip.reversed })}
                  className={
                    'grid h-8 w-8 place-items-center rounded-[var(--radius-sm)] press-inset hover:bg-[color:var(--color-surface2)] disabled:opacity-30 ' +
                    (selectedClip.reversed
                      ? 'text-[color:var(--color-accent)]'
                      : 'text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)]')
                  }
                >
                  <Rewind size={14} />
                </button>
                <button
                  type="button"
                  title="Стоп-кадр (3с) под плейхедом"
                  data-testid="clip-freeze"
                  onClick={freezeAtPlayhead}
                  className="grid h-8 w-8 place-items-center rounded-[var(--radius-sm)] text-[color:var(--color-muted-foreground)] press-inset hover:bg-[color:var(--color-surface2)] hover:text-[color:var(--color-fg)]"
                >
                  <Snowflake size={14} />
                </button>
                <button
                  type="button"
                  title="Отразить по горизонтали"
                  data-testid="clip-flip-h"
                  aria-pressed={Boolean(selectedClip.flipH)}
                  onClick={() => patchClip(selectedClip.uid, { flipH: !selectedClip.flipH })}
                  className={
                    'grid h-8 w-8 place-items-center rounded-[var(--radius-sm)] press-inset hover:bg-[color:var(--color-surface2)] ' +
                    (selectedClip.flipH
                      ? 'text-[color:var(--color-accent)]'
                      : 'text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)]')
                  }
                >
                  <FlipHorizontal size={14} />
                </button>
                <button
                  type="button"
                  title="Отразить по вертикали"
                  data-testid="clip-flip-v"
                  aria-pressed={Boolean(selectedClip.flipV)}
                  onClick={() => patchClip(selectedClip.uid, { flipV: !selectedClip.flipV })}
                  className={
                    'grid h-8 w-8 place-items-center rounded-[var(--radius-sm)] press-inset hover:bg-[color:var(--color-surface2)] ' +
                    (selectedClip.flipV
                      ? 'text-[color:var(--color-accent)]'
                      : 'text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)]')
                  }
                >
                  <FlipVertical size={14} />
                </button>
                <button
                  type="button"
                  title="Удалить клип (Del)"
                  onClick={() => removeClip(selectedClip.uid)}
                  className="grid h-8 w-8 place-items-center rounded-[var(--radius-sm)] text-[color:var(--color-faint)] press-inset hover:bg-[color:var(--color-surface2)] hover:text-destructive"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>

            {/* Active section name — tabs now live on the persistent right
              rail (CapCut), so the panel just titles its current section. */}
            <p className="label-eyebrow" data-testid="insp-section">
              {INSPECTOR_TABS.find((t) => t.id === inspTab)?.label}
            </p>

            {inspTab === 'main' && (
              <MainPanel
                clip={selectedClip}
                patchClip={patchClip}
                playhead={playhead}
                clipWindow={clipWindow}
                selectedIdx={selectedIdx}
                hslChannel={hslChannel}
                setHslChannel={setHslChannel}
              />
            )}

            {inspTab === 'speed' && <SpeedPanel clip={selectedClip} patchClip={patchClip} />}

            {/* §4.3 Animation gallery — In/Out/Combo presets compiled to
              keyframes (render end-to-end; preview==export). */}
            {inspTab === 'animation' && (
              <AnimationPanel
                clip={selectedClip}
                animGroup={animGroup}
                setAnimGroup={setAnimGroup}
                animApplied={animApplied}
                applyAnim={applyAnim}
                animDur={animDur}
                setAnimDur={setAnimDur}
                animEasing={animEasing}
                setAnimEasing={setAnimEasing}
              />
            )}

            {inspTab === 'audio' && <AudioPanel clip={selectedClip} patchClip={patchClip} />}
            {inspTab === 'background' && (
              <BackgroundPanel bgColor={bgColor} setBgColor={setBgColor} />
            )}
            {inspTab === 'smart' && <SmartPanel clip={selectedClip} patchClip={patchClip} />}
          </div>
        ) : selectedOverlayClip ? (
          <OverlayInspector
            clip={selectedOverlayClip}
            patchClip={patchUpperClip}
            removeOverlay={removeOverlay}
            inspTab={inspTab}
            hslChannel={hslChannel}
            setHslChannel={setHslChannel}
          />
        ) : selectedText ? (
          <TextInspector
            text={selectedText}
            removeText={removeText}
            patchText={patchText}
            totalDur={totalDur}
            inspTab={inspTab}
          />
        ) : (
          <div className="glass rounded-[var(--radius-md)] p-5">
            <ol className="space-y-4">
              {[
                {
                  icon: <Plus size={14} aria-hidden />,
                  title: 'Добавь клипы',
                  text: 'Кликни по видео слева — оно встанет на дорожку.',
                },
                {
                  icon: <Scissors size={14} aria-hidden />,
                  title: 'Смонтируй',
                  text: 'Плейхед, обрезка ручками, скорость, фильтры, переходы и титры.',
                },
                {
                  icon: <Film size={14} aria-hidden />,
                  title: 'Экспортируй MP4',
                  text: 'Готовый ролик появится в архиве — для VK и Telegram.',
                },
              ].map((s, i) => (
                <li key={s.title} className="flex items-start gap-3">
                  <span className="relative mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-[var(--radius-sm)] bg-[rgba(var(--accent-rgb),0.14)] text-[color:var(--color-accent)] ring-1 ring-inset ring-[rgba(var(--accent-rgb),0.25)]">
                    {s.icon}
                    <span className="absolute -right-1 -top-1 grid h-3.5 w-3.5 place-items-center rounded-[var(--radius-xs)] bg-[color:var(--color-bg)] font-mono text-[11px] text-[color:var(--color-faint)] ring-1 ring-inset ring-[color:var(--color-line)]/20">
                      {i + 1}
                    </span>
                  </span>
                  <span>
                    <span className="block text-[13px] font-semibold text-[color:var(--color-fg)]">
                      {s.title}
                    </span>
                    <span className="mt-0.5 block text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
                      {s.text}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          </div>
        )}
      </aside>

      {/* ── Right inspector rail (CapCut): persistent 56px icon column, ALWAYS
        mounted so the layout never collapses on deselect. Click an icon →
        that inspector section; disabled with a hint until a clip is picked. ── */}
      <nav
        aria-label="Инспектор"
        data-testid="inspector-tabs"
        className="flex min-h-0 flex-col items-center gap-1 overflow-y-auto rounded-[var(--radius-md)] bg-[color:var(--color-surface)] py-3 shadow-[var(--offset-sm)] ring-1 ring-inset ring-[color:var(--color-line)]/10"
        style={{ gridArea: 'rightrail' }}
      >
        {(() => {
          // Text gets its OWN tab set (Пресеты · Основное); an overlay exposes
          // the worker-renderable subset of the clip tabs; a base clip gets the
          // full set; with nothing picked the full set shows disabled.
          const tabs = selectedText ? TEXT_TABS : INSPECTOR_TABS;
          const enabled = !!selectedClip || !!selectedOverlayClip || !!selectedText;
          const allowed = selectedOverlayClip ? OVERLAY_TABS : null;
          return tabs.map((t) => {
            const Icon = t.icon;
            const usable = enabled && (!allowed || allowed.includes(t.id));
            const on = usable && inspTab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                data-testid={`insp-tab-${t.id}`}
                disabled={!usable}
                aria-pressed={on}
                title={
                  usable
                    ? t.label
                    : allowed
                      ? `${t.label} — недоступно для наложения`
                      : `${t.label} — выбери клип`
                }
                onClick={() => usable && setInspTab(t.id)}
                aria-label={t.label}
                className={
                  'press-inset grid h-[44px] w-[44px] place-items-center rounded-[var(--radius-sm)] transition-colors ' +
                  (on
                    ? 'selected-neutral text-[color:var(--color-fg)]'
                    : usable
                      ? 'text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)]'
                      : 'text-[color:var(--color-faint)] opacity-40 disabled:cursor-not-allowed')
                }
              >
                <Icon size={18} />
              </button>
            );
          });
        })()}
      </nav>
    </>
  );
}

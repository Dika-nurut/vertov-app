// Unified overlay (PiP) inspector — III.1 (G1). CapCut web gives an overlay the
// SAME structured drill-in panel as a base clip, not a reduced flat list. We do
// the same within our rail: an overlay edits the CANONICAL upper-track `TClip`
// (rich), so it gets transform (size/pos/rotate/opacity/crop), the full colour
// grade, flips and in/out animation — exactly the instruments the worker bakes
// into the alpha layer (preview == export). Mask, blend and keyframes are shown
// GATED-disabled with a hint, because the layer compositing path can't honour
// them yet (gated in buildNormalizeArgs); honest, not hidden.
import { FlipHorizontal, FlipVertical, Lock, Trash2 } from '../_icons';
import { Row, Seg, Section, TripleInput } from '../_kit/controls';
import { ColorPanel } from './ColorPanel';
import { AudioPanel } from './AudioPanel';
import { SmartPanel } from './SmartPanel';
import {
  ANIM_LABEL,
  DEFAULT_COLOR,
  DEFAULT_TRANSFORM,
  isNeutralColor,
  isIdentityTransform,
} from '../_model';
import type { AnimKind, HslChannel, InspectorTab, TClip, TTransform } from '../_model';

/** The rail tabs an overlay exposes — the worker-renderable subset (no Background
 *  [composition-level], no Speed [not preview-synced for overlays], no Animation
 *  gallery [keyframes gated on upper tracks; in/out anim lives in Основное]). */
export const OVERLAY_TABS: InspectorTab[] = ['main', 'audio', 'smart'];

export function OverlayInspector({
  clip,
  patchClip,
  removeOverlay,
  inspTab,
  hslChannel,
  setHslChannel,
}: {
  clip: TClip;
  patchClip: (uid: string, patch: Partial<TClip>) => void;
  removeOverlay: (uid: string) => void;
  inspTab: InspectorTab;
  hslChannel: HslChannel;
  setHslChannel: (value: HslChannel) => void;
}) {
  return (
    <div className="glass space-y-4 rounded-[var(--radius-md)] p-4" data-testid="overlay-inspector">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-semibold text-[color:var(--color-fg)]">
          PiP-наложение
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            title="Отразить по горизонтали"
            data-testid="ov-flip-h"
            aria-pressed={Boolean(clip.flipH)}
            onClick={() => patchClip(clip.uid, { flipH: !clip.flipH })}
            className={
              'grid h-8 w-8 place-items-center rounded-[var(--radius-sm)] press-inset hover:bg-[color:var(--color-surface2)] ' +
              (clip.flipH
                ? 'text-[color:var(--color-accent)]'
                : 'text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)]')
            }
          >
            <FlipHorizontal size={14} />
          </button>
          <button
            type="button"
            title="Отразить по вертикали"
            data-testid="ov-flip-v"
            aria-pressed={Boolean(clip.flipV)}
            onClick={() => patchClip(clip.uid, { flipV: !clip.flipV })}
            className={
              'grid h-8 w-8 place-items-center rounded-[var(--radius-sm)] press-inset hover:bg-[color:var(--color-surface2)] ' +
              (clip.flipV
                ? 'text-[color:var(--color-accent)]'
                : 'text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)]')
            }
          >
            <FlipVertical size={14} />
          </button>
          <button
            type="button"
            title="Удалить наложение"
            data-testid="overlay-delete"
            onClick={() => removeOverlay(clip.uid)}
            className="grid h-8 w-8 place-items-center rounded-[var(--radius-sm)] text-[color:var(--color-faint)] press-inset hover:bg-[color:var(--color-surface2)] hover:text-destructive"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      <p className="label-eyebrow" data-testid="insp-section">
        {inspTab === 'audio' ? 'Звук' : inspTab === 'smart' ? 'Смарт' : 'Основное'}
      </p>

      {inspTab === 'main' && (
        <OverlayMainPanel
          clip={clip}
          patchClip={patchClip}
          hslChannel={hslChannel}
          setHslChannel={setHslChannel}
        />
      )}
      {inspTab === 'audio' && <AudioPanel clip={clip} patchClip={patchClip} />}
      {inspTab === 'smart' && <SmartPanel clip={clip} patchClip={patchClip} />}
    </div>
  );
}

/** Основное for an overlay: transform + colour + in/out animation, with mask &
 *  blend gated-disabled. Mirrors the base-clip MainPanel grammar (Section +
 *  TripleInput) but without keyframe diamonds (keyframes are gated on upper tracks). */
function OverlayMainPanel({
  clip,
  patchClip,
  hslChannel,
  setHslChannel,
}: {
  clip: TClip;
  patchClip: (uid: string, patch: Partial<TClip>) => void;
  hslChannel: HslChannel;
  setHslChannel: (value: HslChannel) => void;
}) {
  const tr = clip.transform ?? DEFAULT_TRANSFORM;
  const setTr = (p: Partial<TTransform>) => patchClip(clip.uid, { transform: { ...tr, ...p } });
  return (
    <div className="space-y-3" data-testid="insp-pane-main">
      <Section
        title="Трансформация"
        testid="insp-sec-transform"
        canReset={!isIdentityTransform(clip.transform)}
        onReset={() => patchClip(clip.uid, { transform: { ...DEFAULT_TRANSFORM } })}
      >
        <TripleInput
          label="Размер"
          value={Math.round(tr.scale * 100)}
          min={10}
          max={100}
          step={1}
          def={35}
          unit="%"
          testid="insp-scale"
          onChange={(v) => setTr({ scale: v / 100 })}
        />
        <div className="grid grid-cols-2 gap-2">
          <TripleInput
            label="Позиция X"
            value={tr.posX}
            min={-100}
            max={100}
            step={1}
            def={0}
            unit="%"
            testid="insp-pos-x"
            onChange={(v) => setTr({ posX: v })}
          />
          <TripleInput
            label="Позиция Y"
            value={tr.posY}
            min={-100}
            max={100}
            step={1}
            def={0}
            unit="%"
            testid="insp-pos-y"
            onChange={(v) => setTr({ posY: v })}
          />
        </div>
        <TripleInput
          label="Поворот"
          value={tr.rotate}
          min={-180}
          max={180}
          step={1}
          def={0}
          unit="°"
          testid="insp-rotate"
          onChange={(v) => setTr({ rotate: v })}
        />
        <TripleInput
          label="Непрозрачность"
          value={Math.round((clip.opacity ?? 1) * 100)}
          min={0}
          max={100}
          step={1}
          def={100}
          unit="%"
          testid="insp-opacity"
          onChange={(v) => patchClip(clip.uid, { opacity: v / 100 })}
        />
        <div className="space-y-2">
          <span className="text-[11px] font-medium text-[color:var(--color-faint)]">Обрезка</span>
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                ['left', 'Слева'],
                ['right', 'Справа'],
                ['top', 'Сверху'],
                ['bottom', 'Снизу'],
              ] as const
            ).map(([side, label]) => (
              <TripleInput
                key={side}
                label={label}
                value={Math.round(tr.crop[side] * 100)}
                min={0}
                max={45}
                step={1}
                def={0}
                unit="%"
                testid={`insp-crop-${side}`}
                onChange={(v) => setTr({ crop: { ...tr.crop, [side]: v / 100 } })}
              />
            ))}
          </div>
        </div>
      </Section>

      {/* Colour grade — folded in (same as a base clip). */}
      <Section
        title="Цвет"
        testid="insp-sec-color"
        collapsible
        defaultOpen={false}
        canReset={!isNeutralColor(clip.color)}
        onReset={() => patchClip(clip.uid, { color: { ...DEFAULT_COLOR } })}
      >
        <ColorPanel
          clip={clip}
          patchClip={patchClip}
          hslChannel={hslChannel}
          setHslChannel={setHslChannel}
        />
      </Section>

      {/* In/Out animation — the renderable overlay animation (animChain bakes into
          the alpha layer). The keyframe gallery is gated on upper tracks. */}
      <Section title="Анимация" testid="insp-sec-anim" collapsible defaultOpen={false}>
        {(
          [
            ['animIn', 'Вход'],
            ['animOut', 'Выход'],
          ] as const
        ).map(([key, label]) => {
          const cur = clip[key];
          return (
            <div key={key} className="space-y-2">
              <Row label={label}>
                <Seg
                  value={(cur?.kind ?? 'none') as AnimKind | 'none'}
                  onChange={(v) =>
                    patchClip(clip.uid, {
                      [key]:
                        v === 'none'
                          ? undefined
                          : { kind: v as AnimKind, durSec: cur?.durSec ?? 0.5 },
                    } as Partial<TClip>)
                  }
                  options={(['none', 'fade', 'slide', 'zoom'] as const).map((id) => ({
                    id,
                    label: ANIM_LABEL[id],
                  }))}
                />
              </Row>
              {cur && (
                <TripleInput
                  label="Длительность"
                  value={cur.durSec}
                  min={0.2}
                  max={2}
                  step={0.1}
                  def={0.5}
                  unit="с"
                  testid={`insp-${key}-dur`}
                  onChange={(v) =>
                    patchClip(clip.uid, { [key]: { ...cur, durSec: v } } as Partial<TClip>)
                  }
                />
              )}
            </div>
          );
        })}
      </Section>

      {/* Mask + Blend are gated on upper tracks — surfaced with an honest hint so
          the capability reads as "coming", not missing (preview == export honesty). */}
      <Section title="Маска · Смешивание" testid="insp-sec-gated">
        <div className="flex items-start gap-2 rounded-[var(--radius-sm)] bg-[color:var(--color-surface2)]/50 px-3 py-2 ring-1 ring-inset ring-[color:var(--color-line)]/10">
          <Lock size={13} className="mt-0.5 shrink-0 text-[color:var(--color-faint)]" />
          <p className="text-[11px] leading-relaxed text-[color:var(--color-faint)]">
            Маска и режимы смешивания пока доступны только на основной дорожке — слой компонуется
            поверх кадра, рендер их ещё не сводит.
          </p>
        </div>
      </Section>
    </div>
  );
}

// Inspector «Основное» (Basic) panel — grouped, calm, CapCut-order sections.
// Section order mirrors CapCut web's Basic tab (Transform · Mask · Color · Blend):
// CapCut folds Color adjustment INSIDE Basic (no separate rail icon), so the «Цвет»
// section lives here too. Animation is single-homed on the rail's Animation tab (no
// duplicate accordion here). Keyframe diamonds are INLINE on each animatable
// property row (via the TripleInput `right` slot), not a separate chip cluster.
import { Diamond } from '../_icons';
import { Row, Seg, TripleInput, Toggle, Section } from '../_kit/controls';
import { ColorPanel } from './ColorPanel';
import {
  fmt,
  clipOutDur,
  kfValueAt,
  MASK_LABEL,
  BLEND_LABELS,
  DEFAULT_TRANSFORM,
  DEFAULT_COLOR,
  isIdentityTransform,
  isNeutralColor,
} from '../_model';
import type { TClip, MaskShape, BlendMode, TTransform, KfProp, HslChannel } from '../_model';

export function MainPanel({
  clip,
  patchClip,
  playhead,
  clipWindow,
  selectedIdx,
  hslChannel,
  setHslChannel,
}: {
  clip: TClip;
  patchClip: (uid: string, patch: Partial<TClip>) => void;
  playhead: number;
  clipWindow: (i: number) => { start: number; end: number };
  selectedIdx: number;
  hslChannel: HslChannel;
  setHslChannel: (value: HslChannel) => void;
}) {
  const tr = clip.transform ?? DEFAULT_TRANSFORM;
  const setTr = (p: Partial<TTransform>) => patchClip(clip.uid, { transform: { ...tr, ...p } });

  // Keyframe diamonds: a key is placed at the playhead, measured from the clip's
  // start. The diamond shows the key count so the row reads at a glance.
  const tIn = Math.round(Math.max(0, playhead - clipWindow(selectedIdx).start) * 10) / 10;
  const current: Record<KfProp, number> = {
    opacity: 1,
    posX: tr.posX,
    posY: tr.posY,
    scale: Math.max(1, tr.scale),
    rotate: tr.rotate,
  };
  const toggleKf = (prop: KfProp) => {
    const list = clip.keyframes?.[prop] ?? [];
    const near = list.findIndex((k) => Math.abs(k.t - tIn) < 0.15);
    const next =
      near >= 0
        ? list.filter((_, j) => j !== near)
        : [...list, { t: tIn, v: kfValueAt(list, tIn) ?? current[prop] }].sort((a, b) => a.t - b.t);
    patchClip(clip.uid, { keyframes: { ...clip.keyframes, [prop]: next } });
  };
  /** Inline keyframe diamond for the TripleInput `right` slot. Filled when a key
   *  sits on the playhead; outline-bold when the prop has keys elsewhere; faint
   *  when none. The key count rides alongside (the floor asserts it as text). */
  const KfDiamond = ({ prop }: { prop: KfProp }) => {
    const list = clip.keyframes?.[prop] ?? [];
    const atHere = list.some((k) => Math.abs(k.t - tIn) < 0.15);
    return (
      <button
        type="button"
        data-testid={`kf-${prop}`}
        aria-pressed={atHere}
        title={atHere ? 'Убрать ключ на плейхеде' : 'Поставить ключ на плейхеде'}
        onClick={() => toggleKf(prop)}
        className={
          'press-inset inline-flex items-center gap-0.5 rounded-[var(--radius-xs)] px-1 py-0.5 text-[11px] font-semibold tabular-nums transition-colors ' +
          (atHere
            ? 'text-[color:var(--color-accent)]'
            : list.length
              ? 'text-[color:var(--color-fg)] hover:text-[color:var(--color-accent)]'
              : 'text-[color:var(--color-faint)] hover:text-[color:var(--color-fg)]')
        }
      >
        <Diamond size={11} weight={atHere || list.length ? 'fill' : 'bold'} />
        {list.length > 0 ? list.length : ''}
      </button>
    );
  };

  return (
    <div className="space-y-3" data-testid="insp-pane-main">
      {/* E2: transform FIRST — the everyday controls (size/position/rotate/opacity
          + crop). Advanced sections (mask/blend) sit below, collapsed by default,
          so selecting a clip isn't a wall of controls. */}
      <Section
        title="Трансформация"
        testid="insp-sec-transform"
        canReset={!isIdentityTransform(clip.transform)}
        onReset={() => patchClip(clip.uid, { transform: { ...DEFAULT_TRANSFORM } })}
      >
        <p className="-mt-0.5 text-[11px] leading-relaxed text-[color:var(--color-faint)]">
          Ромб ставит ключ на плейхеде ({tIn.toFixed(1)}с). Обрезку тяни сиреневыми ручками на
          клипе. Длина: {fmt(clipOutDur(clip))}
        </p>
        <TripleInput
          label="Масштаб"
          value={tr.scale}
          min={0.2}
          max={3}
          step={0.05}
          def={1}
          unit="×"
          testid="insp-scale"
          right={<KfDiamond prop="scale" />}
          onChange={(v) => setTr({ scale: v })}
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
            right={<KfDiamond prop="posX" />}
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
            right={<KfDiamond prop="posY" />}
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
          right={<KfDiamond prop="rotate" />}
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
          right={<KfDiamond prop="opacity" />}
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

      {/* S3 C: Mask — advanced, collapsed by default. */}
      <Section title="Маска" testid="insp-mask" collapsible defaultOpen={false}>
        <Row label="Форма">
          <Seg
            value={clip.mask?.shape ?? 'none'}
            onChange={(v) =>
              patchClip(clip.uid, {
                mask:
                  v === 'none'
                    ? undefined
                    : {
                        shape: v,
                        feather: clip.mask?.feather ?? 0,
                        ...(clip.mask?.invert ? { invert: true } : {}),
                      },
              })
            }
            options={(
              [
                'none',
                'circle',
                'rect',
                'linear',
                'diamond',
                'star',
                'heart',
                'cinematic-bars',
                'freeform',
              ] as MaskShape[]
            ).map((id) => ({
              id,
              label: MASK_LABEL[id],
            }))}
          />
        </Row>
        {clip.mask && clip.mask.shape !== 'none' && (
          <>
            {clip.mask.shape !== 'cinematic-bars' && (
              <TripleInput
                label="Растушёвка"
                value={clip.mask.feather ?? 0}
                min={0}
                max={100}
                step={1}
                def={0}
                unit="%"
                testid="mask-feather"
                onChange={(v) => patchClip(clip.uid, { mask: { ...clip.mask!, feather: v } })}
              />
            )}
            <Toggle
              label="Инвертировать"
              on={!!clip.mask.invert}
              onToggle={() =>
                patchClip(clip.uid, { mask: { ...clip.mask!, invert: !clip.mask!.invert } })
              }
            />
          </>
        )}
      </Section>

      {/* CapCut folds Color adjustment inside Basic — «Цвет» rides here as a
          collapsible section (preset · curves · 8 sliders · HSL), no longer a
          separate rail icon. The ColorPanel body + all its testids are reused. */}
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

      {/* S3 D (Blend): mode — advanced, collapsed by default. */}
      <Section title="Смешивание" collapsible defaultOpen={false}>
        <Row label="Режим">
          <Seg
            cols={2}
            value={clip.blendMode ?? 'normal'}
            onChange={(v) =>
              patchClip(clip.uid, { blendMode: v === 'normal' ? undefined : (v as BlendMode) })
            }
            options={(['normal', 'multiply', 'screen', 'overlay'] as BlendMode[]).map((mo) => ({
              id: mo,
              label: BLEND_LABELS[mo],
            }))}
          />
        </Row>
      </Section>
    </div>
  );
}

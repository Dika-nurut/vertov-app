// Inspector color panel (extracted from StudioClient.tsx, split 5c/N).
import { Row, Seg, TripleInput } from '../_kit/controls';
import { DEFAULT_COLOR, PRESET_COLOR, FILTER_LABEL, CURVE_LABELS, HSL_SWATCHES } from '../_model';
import type { TClip, TColor, Filter, CurvePreset, THslAdjust, HslChannel } from '../_model';

export function ColorPanel({
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
  return (
    <div className="space-y-4" data-testid="insp-pane-color">
      {/* presets are quick-apply sugar over the grade sliders (E3) */}
      <Row label="Пресет">
        <Seg
          value={clip.filter}
          onChange={(v) =>
            patchClip(clip.uid, {
              filter: 'none',
              color:
                v === 'none'
                  ? { ...DEFAULT_COLOR } // neutral — stripped on export
                  : {
                      ...DEFAULT_COLOR,
                      ...PRESET_COLOR[v as Exclude<Filter, 'none'>],
                    },
            })
          }
          options={(['none', 'warm', 'cool', 'mono', 'punch'] as Filter[]).map((f) => ({
            id: f,
            label: FILTER_LABEL[f],
          }))}
        />
      </Row>
      {/* S3 subsystem D: tone-curve presets (extend buildColorChain). */}
      <Row label="Кривые">
        <div className="grid grid-cols-4 gap-1" data-testid="insp-curves">
          <button
            type="button"
            data-testid="curve-none"
            aria-pressed={!clip.color?.curve}
            onClick={() => {
              const { curve: _drop, ...rest } = clip.color ?? DEFAULT_COLOR;
              patchClip(clip.uid, { color: rest });
            }}
            className={
              'chip px-1 py-1.5 text-[11px] font-semibold ' +
              (!clip.color?.curve
                ? 'text-[color:var(--color-fg)]'
                : 'text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)]')
            }
          >
            Нет
          </button>
          {(Object.keys(CURVE_LABELS) as CurvePreset[]).map((cu) => (
            <button
              key={cu}
              type="button"
              data-testid={`curve-${cu}`}
              aria-pressed={clip.color?.curve === cu}
              onClick={() =>
                patchClip(clip.uid, {
                  color: { ...(clip.color ?? DEFAULT_COLOR), curve: cu },
                })
              }
              className={
                'chip px-1 py-1.5 text-[11px] font-semibold ' +
                (clip.color?.curve === cu
                  ? 'text-[color:var(--color-fg)]'
                  : 'text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)]')
              }
            >
              {CURVE_LABELS[cu]}
            </button>
          ))}
        </div>
      </Row>
      {(() => {
        const col = clip.color ?? DEFAULT_COLOR;
        const setCol = (p: Partial<TColor>) => patchClip(clip.uid, { color: { ...col, ...p } });
        const SLIDERS: {
          key: Exclude<keyof TColor, 'curve' | 'hsl'>;
          label: string;
          min: number;
        }[] = [
          { key: 'brightness', label: 'Яркость', min: -100 },
          { key: 'contrast', label: 'Контраст', min: -100 },
          { key: 'saturation', label: 'Насыщенность', min: -100 },
          { key: 'temperature', label: 'Температура', min: -100 },
          { key: 'highlight', label: 'Света', min: -100 },
          { key: 'shadow', label: 'Тени', min: -100 },
          { key: 'vignette', label: 'Виньетка', min: 0 },
          { key: 'grain', label: 'Зерно', min: 0 },
        ];
        return (
          <div className="space-y-3">
            {SLIDERS.map((s) => (
              <TripleInput
                key={s.key}
                label={s.label}
                value={col[s.key]}
                min={s.min}
                max={100}
                step={1}
                def={0}
                testid={`insp-color-${s.key}`}
                onChange={(v) => setCol({ [s.key]: v } as Partial<TColor>)}
              />
            ))}
          </div>
        );
      })()}
      {/* S3 D: HSL — per-colour-range hue/sat/lum (ffmpeg huesaturation). */}
      {(() => {
        const col = clip.color ?? DEFAULT_COLOR;
        const cur = col.hsl?.[hslChannel] ?? {};
        const setHsl = (p: Partial<THslAdjust>) =>
          patchClip(clip.uid, {
            color: { ...col, hsl: { ...col.hsl, [hslChannel]: { ...cur, ...p } } },
          });
        return (
          <div
            className="space-y-2 border-t-[1.5px] border-[color:var(--color-line)] pt-3"
            data-testid="insp-hsl"
          >
            <span className="label-eyebrow text-[color:var(--color-faint)]">HSL</span>
            <div className="flex gap-1.5">
              {HSL_SWATCHES.map((sw) => (
                <button
                  key={sw.ch}
                  type="button"
                  data-testid={`hsl-${sw.ch}`}
                  aria-pressed={hslChannel === sw.ch}
                  title={sw.label}
                  onClick={() => setHslChannel(sw.ch)}
                  className={
                    'h-7 w-7 rounded-[var(--radius-sm)] transition-shadow ' +
                    (hslChannel === sw.ch
                      ? 'ring-2 ring-[color:var(--color-accent)]'
                      : 'ring-1 ring-inset ring-[color:var(--color-line)]/15 hover:ring-[color:var(--color-line)]/40')
                  }
                  style={{ background: sw.color }}
                />
              ))}
            </div>
            <TripleInput
              label="Оттенок"
              value={cur.h ?? 0}
              min={-180}
              max={180}
              step={1}
              def={0}
              unit="°"
              testid="hsl-h"
              onChange={(v) => setHsl({ h: v })}
            />
            <TripleInput
              label="Насыщенность"
              value={cur.s ?? 0}
              min={-100}
              max={100}
              step={1}
              def={0}
              testid="hsl-s"
              onChange={(v) => setHsl({ s: v })}
            />
            <TripleInput
              label="Яркость"
              value={cur.l ?? 0}
              min={-100}
              max={100}
              step={1}
              def={0}
              testid="hsl-l"
              onChange={(v) => setHsl({ l: v })}
            />
          </div>
        );
      })()}
    </div>
  );
}

// Inspector animation panel (extracted from StudioClient.tsx, split 5c/N).
import type React from 'react';
import { Zap } from '../_icons';
import { Row, Seg, rangePct } from '../_kit/controls';
import { ANIM_PRESETS } from '../_model';
import type { TClip, AnimPreset } from '../_model';
import { EASING_LABEL } from '../../../lib/studio-easing';
import type { EasingId } from '../../../lib/studio-easing';

const EASING_OPTIONS: { id: EasingId; label: string }[] = (
  ['linear', 'smooth', 'in', 'out', 'spring'] as const
).map((id) => ({ id, label: EASING_LABEL[id] }));

export function AnimationPanel({
  clip,
  animGroup,
  setAnimGroup,
  animApplied,
  applyAnim,
  animDur,
  setAnimDur,
  animEasing,
  setAnimEasing,
}: {
  clip: TClip;
  animGroup: 'in' | 'out' | 'combo';
  setAnimGroup: (value: 'in' | 'out' | 'combo') => void;
  animApplied: Record<string, string>;
  applyAnim: (
    uid: string,
    preset: AnimPreset | null,
    durSec: number,
    easingOverride?: EasingId,
  ) => void;
  animDur: number;
  setAnimDur: (value: number) => void;
  animEasing: EasingId;
  setAnimEasing: (value: EasingId) => void;
}) {
  return (
    <div className="space-y-3" data-testid="insp-pane-animation">
      <Seg
        value={animGroup}
        onChange={(v) => setAnimGroup(v as 'in' | 'out' | 'combo')}
        options={[
          { id: 'in', label: 'Вход' },
          { id: 'out', label: 'Выход' },
          { id: 'combo', label: 'Комбо' },
        ]}
      />
      <div className="grid grid-cols-2 gap-2">
        {ANIM_PRESETS.filter((p) => p.group === animGroup).map((p) => {
          const on = animApplied[clip.uid] === p.id;
          return (
            <button
              key={p.id}
              type="button"
              data-testid={`anim-${p.id}`}
              aria-pressed={on}
              onClick={() => applyAnim(clip.uid, p, animDur)}
              className={
                'press-inset overflow-hidden rounded-[var(--radius-sm)] ring-1 ring-inset transition-shadow ' +
                (on
                  ? 'ring-2 ring-[color:var(--color-accent)]'
                  : 'ring-[color:var(--color-line)]/15 hover:ring-[color:var(--color-line)]/40')
              }
            >
              <span className="studio-swatch grid h-11 w-full place-items-center">
                <Zap size={15} className="text-white/90" />
              </span>
              <span className="block py-1 text-[11px] font-medium text-[color:var(--color-muted-foreground)]">
                {p.label}
              </span>
            </button>
          );
        })}
      </div>
      <Seg
        value={animEasing}
        onChange={(v) => {
          const easing = v as EasingId;
          setAnimEasing(easing);
          const ap = ANIM_PRESETS.find((x) => x.id === animApplied[clip.uid]);
          if (ap) applyAnim(clip.uid, ap, animDur, easing);
        }}
        options={EASING_OPTIONS}
      />
      <Row label={`Длительность ${animDur.toFixed(1)}с`}>
        <input
          type="range"
          min={0.2}
          max={2}
          step={0.1}
          value={animDur}
          data-testid="anim-dur"
          aria-label="Длительность анимации"
          onChange={(e) => {
            const v = Number(e.target.value);
            setAnimDur(v);
            const ap = ANIM_PRESETS.find((x) => x.id === animApplied[clip.uid]);
            if (ap) applyAnim(clip.uid, ap, v);
          }}
          style={{ ['--pct']: rangePct(animDur, 0.2, 2) } as React.CSSProperties}
          className="seed-range w-full"
        />
      </Row>
      <button
        type="button"
        data-testid="anim-none"
        onClick={() => applyAnim(clip.uid, null, animDur)}
        className="press-inset w-full rounded-[var(--radius-sm)] bg-[color:var(--color-surface2)] py-2 text-[13px] font-semibold text-[color:var(--color-muted-foreground)] ring-1 ring-inset ring-[color:var(--color-line)]/15 hover:text-[color:var(--color-fg)]"
      >
        Без анимации
      </button>
      <p className="text-[11px] leading-relaxed text-[color:var(--color-faint)]">
        Пресет пишет ключевые кадры — они видны на клипе и впечатываются в экспорт.
      </p>
    </div>
  );
}

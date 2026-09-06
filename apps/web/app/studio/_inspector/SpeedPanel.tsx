// Inspector speed panel (extracted from StudioClient.tsx, split 5b/N).
import { Row, Seg, TripleInput } from '../_kit/controls';
import { CURVE_LABEL } from '../_model';
import type { SpeedCurve, TClip } from '../_model';

export function SpeedPanel({
  clip,
  patchClip,
}: {
  clip: TClip;
  patchClip: (uid: string, patch: Partial<TClip>) => void;
}) {
  return (
    <div className="space-y-4" data-testid="insp-pane-speed">
      <TripleInput
        label={clip.speedCurve ? 'Скорость (кривая активна)' : 'Скорость'}
        value={clip.speed}
        min={0.25}
        max={4}
        step={0.05}
        def={1}
        unit="×"
        disabled={Boolean(clip.speedCurve)}
        testid="insp-speed"
        onChange={(v) => patchClip(clip.uid, { speed: v })}
      />
      {/* E5: ramp presets — piecewise speed over the clip */}
      <Row label="Кривая скорости">
        <Seg
          value={(clip.speedCurve ?? 'none') as SpeedCurve | 'none'}
          onChange={(v) =>
            patchClip(clip.uid, {
              speedCurve: v === 'none' ? undefined : (v as SpeedCurve),
            })
          }
          options={(['none', 'montage', 'hero', 'flash'] as const).map((id) => ({
            id,
            label: CURVE_LABEL[id],
          }))}
        />
      </Row>
      {clip.speedCurve && (
        <p className="text-[11px] leading-snug text-[color:var(--color-faint)]">
          Звук на кривой идёт средним темпом (рендер сводит дорожки точно).
        </p>
      )}
    </div>
  );
}

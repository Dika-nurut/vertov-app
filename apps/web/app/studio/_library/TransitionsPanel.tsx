// Library transitions panel (extracted from StudioClient.tsx, split 5e/N).
// G4: transitions are applied ON THE TIMELINE — drag a tile onto a clip junction
// (or click to apply to the selected clip). The categorized grid is shared with
// the timeline junction via TransitionGrid so both speak one catalog. The
// «Длина перехода» control lives here now (it left the inspector with the grid).
import { TransitionGrid } from '../_kit/TransitionGrid';
import { TripleInput } from '../_kit/controls';
import type { TClip, Transition } from '../_model';

export function TransitionsPanel({
  clip,
  patchClip,
  onTilePointerDown,
}: {
  clip: TClip | null;
  patchClip: (uid: string, patch: Partial<TClip>) => void;
  /** G4: start a drag from a tile → drop on a timeline junction. */
  onTilePointerDown?: (t: Transition, e: React.PointerEvent) => void;
}) {
  return (
    <section data-testid="lib-transitions">
      <p className="label-eyebrow mb-3">Переходы</p>
      <p className="mb-3 text-[13px] leading-relaxed text-[color:var(--color-faint)]">
        {clip
          ? 'Перетащи переход на стык клипов на таймлайне — или кликни, чтобы применить к выбранному клипу.'
          : 'Каталог переходов — перетащи на стык клипов на таймлайне, или выбери клип и кликни.'}
      </p>
      <TransitionGrid
        value={clip?.transition}
        disabled={!clip}
        onPick={(t) => clip && patchClip(clip.uid, { transition: t })}
        onTilePointerDown={onTilePointerDown}
      />
      {clip && clip.transition !== 'cut' && (
        <div className="mt-3">
          <TripleInput
            label="Длина перехода"
            value={clip.transitionSec}
            min={0.2}
            max={1.5}
            step={0.1}
            def={0.5}
            unit="с"
            testid="lib-transition-sec"
            onChange={(v) => patchClip(clip.uid, { transitionSec: v })}
          />
        </div>
      )}
    </section>
  );
}

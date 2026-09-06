// Inspector audio panel (extracted from StudioClient.tsx, split 5b/N).
import { Volume2, VolumeX } from '../_icons';
import { TripleInput } from '../_kit/controls';
import type { TClip } from '../_model';

export function AudioPanel({
  clip,
  patchClip,
}: {
  clip: TClip;
  patchClip: (uid: string, patch: Partial<TClip>) => void;
}) {
  return (
    <div className="space-y-4" data-testid="insp-pane-audio">
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label={clip.muted ? 'Включить звук' : 'Выключить звук'}
          data-testid="insp-mute"
          onClick={() => patchClip(clip.uid, { muted: !clip.muted })}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-[var(--radius-sm)] text-[color:var(--color-muted-foreground)] press-inset hover:bg-[color:var(--color-surface2)] hover:text-[color:var(--color-fg)]"
        >
          {clip.muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
        </button>
        <div className="flex-1">
          <TripleInput
            label={clip.muted ? 'Звук клипа: выкл' : 'Громкость'}
            value={clip.volumeDb}
            min={-30}
            max={10}
            step={1}
            def={0}
            unit="dB"
            disabled={clip.muted}
            testid="insp-volume"
            onChange={(v) => patchClip(clip.uid, { volumeDb: v })}
          />
        </div>
      </div>
    </div>
  );
}

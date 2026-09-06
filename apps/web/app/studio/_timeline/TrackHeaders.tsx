// Timeline track-headers gutter — per-lane label · lock · mute (extracted
// from StudioClient.tsx, split 5o/N).
import type React from 'react';
import { Volume2, VolumeX } from '../_icons';
import { LaneLockBtn } from '../_components/timeline-clips';
import type { TAudio, TClip } from '../_model';

export function TrackHeaders({
  upperClips,
  music,
  voiceover,
  isLocked,
  toggleLock,
  allMuted,
  setTimeline,
}: {
  /** PiP/overlay clips on upper tracks — only the count drives the lane header. */
  upperClips: TClip[];
  music: TAudio | null;
  voiceover: TAudio | null;
  isLocked: (id: string) => boolean;
  toggleLock: (id: string) => void;
  allMuted: boolean;
  setTimeline: React.Dispatch<React.SetStateAction<TClip[]>>;
}) {
  return (
    <div className="w-[92px] shrink-0 select-none" data-testid="track-headers">
      <div className="h-5" /> {/* ruler spacer */}
      {upperClips.length > 0 && (
        <div className="mb-1 flex h-[48px] items-center justify-between rounded-[var(--radius-sm)] bg-[color:var(--color-surface2)] px-2 ring-1 ring-inset ring-[color:var(--color-line)]/15">
          <span className="label-eyebrow text-[color:var(--color-faint)]">PiP</span>
          <LaneLockBtn id="overlay" locked={isLocked('overlay')} onToggle={toggleLock} />
        </div>
      )}
      <div className="flex h-[64px] flex-col justify-between rounded-[var(--radius-sm)] bg-[color:var(--color-surface2)] px-2 py-1.5 ring-1 ring-inset ring-[color:var(--color-line)]/15">
        <span className="label-eyebrow text-[color:var(--color-muted-foreground)]">Видео</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            title={allMuted ? 'Включить звук дорожки' : 'Заглушить дорожку'}
            data-testid="video-mute"
            onClick={() => setTimeline((ts) => ts.map((c) => ({ ...c, muted: !allMuted })))}
            className="grid h-6 w-6 place-items-center rounded-[var(--radius-xs)] text-[color:var(--color-faint)] press-inset hover:text-[color:var(--color-fg)]"
          >
            {allMuted ? <VolumeX size={13} /> : <Volume2 size={13} />}
          </button>
          <LaneLockBtn id="video" locked={isLocked('video')} onToggle={toggleLock} />
        </div>
      </div>
      <div className="mt-1 flex h-7 items-center justify-between rounded-[var(--radius-sm)] bg-[color:var(--color-surface2)] px-2 ring-1 ring-inset ring-[color:var(--color-line)]/15">
        <span className="label-eyebrow text-[color:var(--color-faint)]">Текст</span>
        <LaneLockBtn id="text" locked={isLocked('text')} onToggle={toggleLock} />
      </div>
      {music && (
        <div className="mt-1 flex h-9 items-center justify-between rounded-[var(--radius-sm)] bg-[color:var(--color-surface2)] px-2 ring-1 ring-inset ring-[color:var(--color-line)]/15">
          <span className="label-eyebrow text-[color:var(--color-faint)]">Музыка</span>
          <LaneLockBtn id="music" locked={isLocked('music')} onToggle={toggleLock} />
        </div>
      )}
      {voiceover && (
        <div className="mt-1 flex h-9 items-center justify-between rounded-[var(--radius-sm)] bg-[color:var(--color-surface2)] px-2 ring-1 ring-inset ring-[color:var(--color-line)]/15">
          <span className="label-eyebrow text-[color:var(--color-faint)]">Озвучка</span>
          <LaneLockBtn id="voiceover" locked={isLocked('voiceover')} onToggle={toggleLock} />
        </div>
      )}
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { Volume2, VolumeX } from '@/components/ui/icons';
import { isSoundMuted, toggleSoundMuted, onSoundMuteChange } from '@/lib/sound';

/**
 * Global sound mute — a compact header toggle. Sound is ON by default (a subtle
 * CC0 cue on generate submit / complete / error); this lets anyone silence it in
 * one tap. The preference persists (localStorage) and `prefers-reduced-motion`
 * silences playback regardless. Hydration-safe: renders the default (unmuted)
 * icon on the server and reconciles to the stored pref after mount.
 */
export function SoundToggle() {
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    setMuted(isSoundMuted());
    return onSoundMuteChange(setMuted);
  }, []);

  return (
    <button
      type="button"
      data-testid="sound-toggle"
      onClick={() => setMuted(toggleSoundMuted())}
      aria-pressed={muted}
      aria-label={muted ? 'Включить звук' : 'Выключить звук'}
      title={muted ? 'Звук выключен' : 'Звук включён'}
      className="press grid h-9 w-9 shrink-0 place-items-center rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] text-[color:var(--color-muted-foreground)] shadow-[3px_3px_0_0_var(--color-shadow)] transition-colors hover:text-[color:var(--color-fg)]"
    >
      {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
    </button>
  );
}

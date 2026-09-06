// Dependency-free UI sound — tiny CC0 (Kenney) SFX for the generate flow.
// Global mute is persisted (default ON); prefers-reduced-motion silences it;
// browsers that block autoplay or lack <audio> simply no-op. No new dependency,
// SSR-safe (every entry point guards on `window`/`Audio`).
type SoundName = 'submit' | 'complete' | 'error';

const FILES: Record<SoundName, string> = {
  submit: '/sounds/ui-submit.mp3',
  complete: '/sounds/ui-complete.mp3',
  error: '/sounds/ui-error.mp3',
};
// Kept low — a UI cue, never a notification klaxon.
const VOLUME: Record<SoundName, number> = {
  submit: 0.3,
  complete: 0.5,
  error: 0.45,
};

const STORAGE_KEY = 'seed-sound-muted';
const listeners = new Set<(muted: boolean) => void>();
const cache: Partial<Record<SoundName, HTMLAudioElement>> = {};

function browser(): boolean {
  return typeof window !== 'undefined' && typeof Audio !== 'undefined';
}

/** Muted? Defaults to OFF-mute (i.e. sound ON) until the user opts out. */
export function isSoundMuted(): boolean {
  if (!browser()) return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setSoundMuted(muted: boolean): void {
  if (!browser()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, muted ? '1' : '0');
  } catch {
    /* private mode — ignore */
  }
  listeners.forEach((l) => l(muted));
}

export function toggleSoundMuted(): boolean {
  const next = !isSoundMuted();
  setSoundMuted(next);
  return next;
}

/** Subscribe to mute changes (drives the toggle UI). Returns an unsubscribe. */
export function onSoundMuteChange(fn: (muted: boolean) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function reducedMotion(): boolean {
  if (!browser() || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function play(name: SoundName): void {
  if (!browser() || isSoundMuted() || reducedMotion()) return;
  try {
    let el = cache[name];
    if (!el) {
      el = new Audio(FILES[name]);
      el.preload = 'auto';
      el.volume = VOLUME[name];
      cache[name] = el;
    }
    el.currentTime = 0;
    void el.play().catch(() => {
      /* autoplay policy / not yet interacted — ignore */
    });
  } catch {
    /* decode error / unsupported — ignore */
  }
}

export const sound = {
  /** Soft click — a generation was submitted. */
  submit: () => play('submit'),
  /** Confirmation chime — a render landed. */
  complete: () => play('complete'),
  /** Low error tone — a render failed. */
  error: () => play('error'),
};

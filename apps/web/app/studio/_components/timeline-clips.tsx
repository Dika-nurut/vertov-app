// Studio timeline-track chrome (extracted from StudioClient.tsx, split 3/N):
// per-lane lock toggle, the audio-lane waveform clip, and the video-clip
// filmstrip. Pure presentational leaf components — no editor state.
import { useMemo } from 'react';
import { assetSrc } from '@/lib/asset-src';
import { Lock, Unlock } from '../_icons';
import { Waveform } from '../_kit/controls';
import { useAudioPeaks } from '../_kit/useAudioPeaks';
import { useFilmstrip } from '../_kit/useFilmstrip';

/** Per-lane lock toggle in the timeline track header (S2). */
export function LaneLockBtn({
  id,
  locked,
  onToggle,
}: {
  id: string;
  locked: boolean;
  onToggle: (id: string) => void;
}) {
  return (
    <button
      type="button"
      title={locked ? 'Разблокировать дорожку' : 'Заблокировать дорожку'}
      data-testid={`lane-lock-${id}`}
      aria-pressed={locked}
      onClick={() => onToggle(id)}
      className={
        'grid h-6 w-6 place-items-center rounded-[var(--radius-xs)] press-inset ' +
        (locked
          ? 'text-[color:var(--color-accent)]'
          : 'text-[color:var(--color-faint)] hover:text-[color:var(--color-fg)]')
      }
    >
      {locked ? <Lock size={12} /> : <Unlock size={12} />}
    </button>
  );
}

/** A music/voiceover timeline lane with a real browser-decoded waveform (S2).
 * Falls back to a flat bar if decode/CORS fails — the waveform is an affordance,
 * never a gate. */
export function AudioLaneClip({
  url,
  name,
  left,
  width,
  accent,
  apiUrl,
}: {
  url: string;
  name: string;
  left: number;
  width: number;
  accent: boolean;
  apiUrl: string;
}) {
  const peaks = useAudioPeaks(url, 320, apiUrl);
  return (
    <div
      className={
        'absolute bottom-0.5 top-0.5 overflow-hidden rounded-[var(--radius-xs)] ring-1 ring-inset ' +
        (accent
          ? 'bg-[rgba(var(--accent-rgb),0.12)] text-[rgba(var(--accent-rgb),0.7)] ring-[rgba(var(--accent-rgb),0.3)]'
          : 'bg-[color:var(--color-surface)] text-[color:var(--color-muted-foreground)] ring-[color:var(--color-line)]/20')
      }
      style={{ left, width }}
      title={name}
    >
      {peaks ? (
        <Waveform peaks={peaks} className="h-full w-full" />
      ) : (
        <span className="absolute inset-x-1 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-current opacity-50" />
      )}
      <span className="absolute left-1.5 top-0.5 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-faint)]">
        {name}
      </span>
    </div>
  );
}

/** A video clip's timeline body (CapCut spec §6): a FILMSTRIP — a row of frames
 * seeked across the trimmed range, not a single thumbnail — with the clip's OWN
 * audio waveform riding the lower band. Frames are seeked <video> tags (zero
 * backend, the same path as the old single thumb); the waveform reuses the
 * browser-decode peaks sliced to the clip's [inSec,outSec] window. Muted clips
 * show no waveform (matches CapCut). Pure timeline chrome — no render impact, so
 * preview==export is untouched. */
export function ClipFilmstrip({
  url,
  inSec,
  outSec,
  dur,
  width,
  filter,
  muted,
  apiUrl,
}: {
  url: string;
  inSec: number;
  outSec: number;
  dur: number;
  width: number;
  filter: string;
  muted: boolean;
  apiUrl: string;
}) {
  const span = Math.max(0.05, outSec - inSec);
  // Frame count tracks the clip's on-screen width (~1 frame / 72px), capped so a
  // long clip doesn't open dozens of video streams at once. Always ≥1.
  const frames = Math.max(1, Math.min(8, Math.round(width / 72)));
  const peaks = useAudioPeaks(muted ? undefined : url, 256, apiUrl);
  // Server-rendered sprite (one cached image) replaces the per-frame <video>
  // elements when available; null → fall back to the seeked-<video> frames.
  const strip = useFilmstrip(url, apiUrl);
  const clipPeaks = useMemo(() => {
    if (!peaks || dur <= 0) return null;
    const a = Math.max(0, Math.floor((inSec / dur) * peaks.length));
    const b = Math.min(peaks.length, Math.ceil((outSec / dur) * peaks.length));
    const slice = peaks.slice(a, Math.max(a + 1, b));
    return slice.length ? slice : null;
  }, [peaks, inSec, outSec, dur]);
  return (
    <>
      <div data-testid="clip-filmstrip" className="absolute inset-0 flex" aria-hidden="true">
        {strip
          ? Array.from({ length: frames }, (_, i) => {
              // Map this display cell's time to the nearest sprite frame, then to
              // its (col,row) in the grid — a CSS-sprite background slice, no
              // pixel math (percentage positioning is grid-size agnostic).
              const t = inSec + ((i + 0.5) / frames) * span;
              const idx = Math.max(
                0,
                Math.min(
                  strip.count - 1,
                  Math.round((t / Math.max(0.001, dur)) * strip.count - 0.5),
                ),
              );
              const col = idx % strip.cols;
              const row = Math.floor(idx / strip.cols);
              return (
                <div
                  key={i}
                  className="pointer-events-none h-full min-w-0 flex-1 bg-no-repeat"
                  style={{
                    backgroundImage: `url(${assetSrc(strip.sprite)})`,
                    backgroundSize: `${strip.cols * 100}% ${strip.rows * 100}%`,
                    backgroundPosition: `${strip.cols > 1 ? (col * 100) / (strip.cols - 1) : 0}% ${
                      strip.rows > 1 ? (row * 100) / (strip.rows - 1) : 0
                    }%`,
                    filter,
                    boxShadow: i < frames - 1 ? 'inset -1px 0 0 rgba(0,0,0,0.3)' : undefined,
                  }}
                />
              );
            })
          : Array.from({ length: frames }, (_, i) => (
              <video
                key={i}
                src={`${assetSrc(url)}#t=${(inSec + ((i + 0.5) / frames) * span).toFixed(2)}`}
                muted
                preload="metadata"
                tabIndex={-1}
                className="pointer-events-none h-full min-w-0 flex-1 object-cover"
                style={{
                  filter,
                  boxShadow: i < frames - 1 ? 'inset -1px 0 0 rgba(0,0,0,0.3)' : undefined,
                }}
              />
            ))}
      </div>
      {clipPeaks && (
        <div
          data-testid="clip-waveform"
          className="pointer-events-none absolute inset-x-0 bottom-0 h-[18px] bg-gradient-to-t from-black/65 to-transparent text-white/75"
        >
          <Waveform peaks={clipPeaks} className="h-full w-full" />
        </div>
      )}
    </>
  );
}

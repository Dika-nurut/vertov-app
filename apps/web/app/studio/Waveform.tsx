'use client';

import { useEffect, useRef, useState } from 'react';
import { computePeaks } from '../../lib/waveform';

/**
 * B-2a: render a static waveform for an audio source. Fetches + decodes the
 * audio client-side (Web Audio API), downsamples to peaks (see lib/waveform),
 * and draws them as SVG bars. Renders nothing until decoded, or if the source
 * can't be decoded (e.g. silent / unsupported), so it never blocks the editor.
 */
export function Waveform({ url, bars = 56 }: { url: string; bars?: number }) {
  const [peaks, setPeaks] = useState<number[] | null>(null);
  // Avoid re-decoding the same URL across re-renders.
  const decodedFor = useRef<string | null>(null);

  useEffect(() => {
    if (decodedFor.current === url) return;
    let cancelled = false;
    const AudioCtx =
      typeof window !== 'undefined'
        ? (window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
        : undefined;
    if (!AudioCtx) return;

    void (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) return;
        const buf = await res.arrayBuffer();
        const ctx = new AudioCtx();
        const audio = await ctx.decodeAudioData(buf);
        const data = audio.getChannelData(0);
        if (!cancelled) {
          setPeaks(computePeaks(data, bars));
          decodedFor.current = url;
        }
        void ctx.close();
      } catch {
        if (!cancelled) setPeaks(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [url, bars]);

  if (!peaks || peaks.every((p) => p === 0)) return null;

  return (
    <svg
      data-testid="waveform"
      viewBox={`0 0 ${peaks.length} 100`}
      preserveAspectRatio="none"
      role="img"
      aria-label="Форма волны аудио"
      className="h-8 w-full"
    >
      {peaks.map((p, i) => {
        const h = Math.max(2, p * 92);
        return (
          <rect
            key={i}
            x={i + 0.15}
            y={(100 - h) / 2}
            width={0.7}
            height={h}
            rx={0.3}
            className="fill-[color:var(--color-accent)]"
            opacity={0.55}
          />
        );
      })}
    </svg>
  );
}

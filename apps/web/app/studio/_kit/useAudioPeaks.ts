'use client';
import { useEffect, useState } from 'react';

// Module cache so a track's peaks survive re-selection AND reload (the decode
// re-runs on a fresh page but the result is identical → waveforms "persist").
const cache = new Map<string, number[]>();

/**
 * Resolve normalized 0–1 peaks for a timeline waveform.
 *
 * Primary path (review #1): ask the API for a server-decoded peaks sidecar
 * (`GET /v1/studio/peaks`). When it succeeds the browser does NOT download whole
 * media to draw the waveform — a 4-min 1080p clip is hundreds of MB, and a real
 * project has many. The API decodes once and caches the peaks JSON, so it's an
 * O(1) fetch after the first load.
 *
 * Fallback path: in-browser Web Audio decode, kept as a safety net for assets
 * the endpoint can't serve (dev statics, blob: URLs, or the API being down).
 * This path DOES fetch + decode the whole media, so it's only acceptable for the
 * small/same-origin clips that hit it in practice. Returns null while resolving
 * or if both paths fail, so callers gracefully show a flat bar — a waveform is an
 * affordance, not a gate.
 */
export function useAudioPeaks(
  url: string | undefined,
  buckets = 320,
  apiBase = '',
): number[] | null {
  const [peaks, setPeaks] = useState<number[] | null>(() =>
    url ? (cache.get(url) ?? null) : null,
  );

  useEffect(() => {
    if (!url) {
      setPeaks(null);
      return;
    }
    const cached = cache.get(url);
    if (cached) {
      setPeaks(cached);
      return;
    }
    let cancelled = false;
    (async () => {
      // 1) Server peaks sidecar — only our own MinIO assets qualify; everything
      //    else 4xx's fast (no ffmpeg) and we fall through to the decode below.
      try {
        const res = await fetch(`${apiBase}/v1/studio/peaks?url=${encodeURIComponent(url)}`, {
          credentials: 'include',
        });
        if (res.ok) {
          const json = (await res.json()) as { peaks?: number[] };
          if (Array.isArray(json.peaks)) {
            if (!cancelled) {
              cache.set(url, json.peaks);
              setPeaks(json.peaks);
            }
            return;
          }
        }
      } catch {
        /* fall through to in-browser decode */
      }
      if (cancelled) return;
      // 2) Fallback — in-browser Web Audio decode (legacy path; bounded to small
      //    same-origin clips in practice).
      try {
        const res = await fetch(url);
        const raw = await res.arrayBuffer();
        const AC: typeof AudioContext =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ctx = new AC();
        const audio = await ctx.decodeAudioData(raw);
        const data = audio.getChannelData(0);
        const block = Math.max(1, Math.floor(data.length / buckets));
        const out: number[] = [];
        let max = 0;
        for (let i = 0; i < buckets; i++) {
          let peak = 0;
          const start = i * block;
          for (let j = 0; j < block; j++) {
            const v = Math.abs(data[start + j] ?? 0);
            if (v > peak) peak = v;
          }
          out.push(peak);
          if (peak > max) max = peak;
        }
        const norm = max > 0 ? out.map((v) => v / max) : out;
        void ctx.close?.();
        if (!cancelled) {
          cache.set(url, norm);
          setPeaks(norm);
        }
      } catch {
        if (!cancelled) setPeaks(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url, buckets, apiBase]);

  return peaks;
}

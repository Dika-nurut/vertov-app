'use client';
import { useEffect, useState } from 'react';

export interface FilmstripSprite {
  /** Public URL of the tiled JPEG sprite. */
  sprite: string;
  cols: number;
  rows: number;
  /** Total frames in the sprite (cols × rows). */
  count: number;
}

// Module cache so a source's sprite survives re-selection AND reload (the meta
// is tiny; the image itself is browser-cached by URL).
const cache = new Map<string, FilmstripSprite>();

/**
 * Resolve a server-rendered filmstrip sprite for a video asset (review #1: a
 * clip used to open up to 8 <video> elements, so a real timeline spawned
 * hundreds). The API tiles ~20 frames into ONE cached JPEG; the client renders
 * frame cells as background slices of it.
 *
 * Returns null while loading or for anything the endpoint can't serve (non-asset
 * URLs, images, or the API being down), so `ClipFilmstrip` falls back to its
 * legacy seeked-<video> frames — a filmstrip is chrome, never a gate.
 */
export function useFilmstrip(url: string | undefined, apiBase = ''): FilmstripSprite | null {
  const [strip, setStrip] = useState<FilmstripSprite | null>(() =>
    url ? (cache.get(url) ?? null) : null,
  );

  useEffect(() => {
    if (!url) {
      setStrip(null);
      return;
    }
    const cached = cache.get(url);
    if (cached) {
      setStrip(cached);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${apiBase}/v1/studio/filmstrip?url=${encodeURIComponent(url)}`, {
          credentials: 'include',
        });
        if (res.ok) {
          const j = (await res.json()) as Partial<FilmstripSprite>;
          if (j && typeof j.sprite === 'string' && j.cols && j.rows && j.count) {
            const sprite = { sprite: j.sprite, cols: j.cols, rows: j.rows, count: j.count };
            if (!cancelled) {
              cache.set(url, sprite);
              setStrip(sprite);
            }
            return;
          }
        }
      } catch {
        /* fall back to in-browser seeked frames */
      }
      if (!cancelled) setStrip(null);
    })();
    return () => {
      cancelled = true;
    };
  }, [url, apiBase]);

  return strip;
}

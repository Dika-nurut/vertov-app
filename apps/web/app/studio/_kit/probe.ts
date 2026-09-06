// Probe a media URL's duration client-side via a throwaway <video> (metadata
// only). Resolves 5s on error/non-finite so callers always get a usable
// number. Extracted from StudioClient.tsx (split 3/N) so timeline/source
// components can share it.
import { assetSrc } from '@/lib/asset-src';

export function probeDuration(url: string): Promise<number> {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    // Same-origin rewrite: the raw stored URL is the bare-IP MinIO host
    // (http://<ip>/seed-assets/…) which an HTTPS page blocks as mixed content —
    // metadata never loads and every clip falls back to 5s. assetSrc maps it to
    // the same-origin /seed-assets path Caddy proxies. (No-op for other URLs.)
    v.src = assetSrc(url);
    v.onloadedmetadata = () => resolve(Number.isFinite(v.duration) ? v.duration : 5);
    v.onerror = () => resolve(5);
  });
}

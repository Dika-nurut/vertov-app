/**
 * Cross-surface asset handoff (B-1). Generate stashes selected variant URLs;
 * Studio reads them on mount and appends them as timeline clips, Board reads
 * them and drops them as media nodes. Uses sessionStorage (per-tab, cleared on
 * read) so a navigation carries the selection without a backend round-trip.
 *
 * The serialize/parse core is pure (no DOM) so it's unit-tested; the stash/take
 * wrappers are thin sessionStorage guards around it.
 */

export type HandoffTarget = 'studio' | 'board';

export interface HandoffAsset {
  url: string;
  assetId?: string;
}

const KEYS: Record<HandoffTarget, string> = {
  studio: 'seed.handoff.studio',
  board: 'seed.handoff.board',
};

const isNonEmptyString = (u: unknown): u is string => typeof u === 'string' && u.length > 0;

/** Serialize a clean URL list to the stash payload. */
export function serializeHandoff(urls: string[]): string {
  return JSON.stringify({ urls: urls.filter(isNonEmptyString) });
}

/** Parse a stash payload defensively into a URL list (pure; unit-tested). */
export function parseHandoff(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const data = JSON.parse(raw) as unknown;
    const urls = (data as { urls?: unknown })?.urls;
    return Array.isArray(urls) ? urls.filter(isNonEmptyString) : [];
  } catch {
    return [];
  }
}

/** Serialize a media selection while retaining its stable gallery identity. */
export function serializeAssetHandoff(assets: HandoffAsset[]): string {
  return JSON.stringify({
    assets: assets
      .filter((asset) => isNonEmptyString(asset.url))
      .map((asset) => ({
        url: asset.url,
        ...(isNonEmptyString(asset.assetId) ? { assetId: asset.assetId } : {}),
      })),
  });
}

/** Read the current asset payload and the older URL-only payload. */
export function parseAssetHandoff(raw: string | null): HandoffAsset[] {
  if (!raw) return [];
  try {
    const data = JSON.parse(raw) as { assets?: unknown; urls?: unknown };
    if (Array.isArray(data.assets)) {
      return data.assets.flatMap((value) => {
        if (!value || typeof value !== 'object') return [];
        const asset = value as { url?: unknown; assetId?: unknown };
        if (!isNonEmptyString(asset.url)) return [];
        return [
          {
            url: asset.url,
            ...(isNonEmptyString(asset.assetId) ? { assetId: asset.assetId } : {}),
          },
        ];
      });
    }
    return Array.isArray(data.urls)
      ? data.urls.filter(isNonEmptyString).map((url) => ({ url }))
      : [];
  } catch {
    return [];
  }
}

/** Stash a selection for a target surface (no-op outside the browser / empty). */
export function stashHandoff(target: HandoffTarget, urls: string[]): boolean {
  const clean = urls.filter(isNonEmptyString);
  if (typeof window === 'undefined' || clean.length === 0) return false;
  window.sessionStorage.setItem(KEYS[target], serializeHandoff(clean));
  return true;
}

/** Stash a selection with ownership identity for the Studio resolver. */
export function stashAssetHandoff(target: HandoffTarget, assets: HandoffAsset[]): boolean {
  const clean = assets.filter((asset) => isNonEmptyString(asset.url));
  if (typeof window === 'undefined' || clean.length === 0) return false;
  window.sessionStorage.setItem(KEYS[target], serializeAssetHandoff(clean));
  return true;
}

/** Read without clearing so React Strict Mode can initialize deterministically. */
export function peekHandoff(target: HandoffTarget): string[] {
  if (typeof window === 'undefined') return [];
  return parseHandoff(window.sessionStorage.getItem(KEYS[target]));
}

export function peekAssetHandoff(target: HandoffTarget): HandoffAsset[] {
  if (typeof window === 'undefined') return [];
  return parseAssetHandoff(window.sessionStorage.getItem(KEYS[target]));
}

export function clearHandoff(target: HandoffTarget): void {
  if (typeof window === 'undefined') return;
  window.sessionStorage.removeItem(KEYS[target]);
}

/** Read + CLEAR a target's stash (one-shot, so a refresh doesn't re-ingest). */
export function takeHandoff(target: HandoffTarget): string[] {
  const urls = peekHandoff(target);
  clearHandoff(target);
  return urls;
}

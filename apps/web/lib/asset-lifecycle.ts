'use client';

import { useEffect, useMemo, useState } from 'react';

export type ResolvedAsset =
  | {
      id: string;
      available: false;
    }
  | {
      id: string;
      available: true;
      assetUrl: string;
      thumbnailUrl: string | null;
      kind: 'image' | 'video' | 'audio';
      title: string | null;
      expiresAt: string | null;
    };

export function useResolvedAssets(apiUrl: string, assetIds: readonly string[]) {
  const key = useMemo(() => [...new Set(assetIds)].sort().join('\n'), [assetIds]);
  const [assets, setAssets] = useState<ReadonlyMap<string, ResolvedAsset>>(new Map());

  useEffect(() => {
    const ids = key ? key.split('\n') : [];
    if (ids.length === 0) {
      setAssets(new Map());
      return;
    }
    const controller = new AbortController();
    void fetch(`${apiUrl}/v1/assets/resolve`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assetIds: ids }),
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        return (await response.json()) as { assets?: ResolvedAsset[] };
      })
      .then((body) => {
        if (!controller.signal.aborted) {
          setAssets(new Map((body.assets ?? []).map((asset) => [asset.id, asset])));
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          // Failure is intentionally fail-closed: identified media must never
          // fall back to a stale URL snapshot while identity is unresolved.
          setAssets(new Map(ids.map((id) => [id, { id, available: false } as const])));
        }
      });
    return () => controller.abort();
  }, [apiUrl, key]);

  return assets;
}

export function formatAssetExpiry(expiresAt: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(expiresAt));
}

export function assetLifecyclePresentation(asset: ResolvedAsset | undefined) {
  if (!asset || !asset.available) return { kind: 'unavailable' as const };
  if (asset.expiresAt) return { kind: 'finite' as const, expiresAt: asset.expiresAt };
  return { kind: 'permanent' as const };
}

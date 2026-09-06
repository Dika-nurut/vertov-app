import Link from 'next/link';
import { FREE_MEDIA_RETENTION_COPY } from '@seed/shared/media-retention';
import { formatAssetExpiry } from '@/lib/asset-lifecycle';
import { assetSrc } from '@/lib/asset-src';

export function AssetLifecycleNotice({
  expiresAt,
  unavailable = false,
  compact = false,
  assetUrl,
}: {
  expiresAt?: string | null;
  unavailable?: boolean;
  compact?: boolean;
  assetUrl?: string;
}) {
  if (unavailable) {
    return (
      <div
        data-testid="asset-unavailable"
        className="rounded-[var(--radius-xs)] border border-red-400/40 bg-red-500/10 px-2 py-1.5 text-[10px] font-semibold text-red-200"
      >
        Материал недоступен
      </div>
    );
  }
  if (!expiresAt) return null;
  const [storage, download, permanent] = FREE_MEDIA_RETENTION_COPY.split(' · ');
  return (
    <div
      data-testid="asset-expiry-warning"
      className={`rounded-[var(--radius-xs)] border border-amber-400/40 bg-amber-400/10 px-2 py-1.5 text-amber-100 ${
        compact ? 'text-[9px]' : 'text-[11px]'
      }`}
    >
      <span>
        До {formatAssetExpiry(expiresAt)} · {storage}
      </span>
      {' · '}
      {assetUrl ? (
        <a
          href={assetSrc(assetUrl)}
          download
          className="font-semibold underline underline-offset-2"
        >
          {download}
        </a>
      ) : (
        <span>{download}</span>
      )}
      {' · '}
      <Link href="/pricing" className="font-semibold underline underline-offset-2">
        {permanent}
      </Link>
    </div>
  );
}

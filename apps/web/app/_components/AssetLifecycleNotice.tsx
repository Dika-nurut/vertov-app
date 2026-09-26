import Link from 'next/link';
import { FREE_MEDIA_RETENTION_COPY_PARTS } from '@seed/shared/media-retention';
import { formatAssetExpiry } from '@/lib/asset-lifecycle';
import { assetSrc } from '@/lib/asset-src';

export function AssetLifecycleNotice({
  expiresAt,
  unavailable = false,
  expired = false,
  compact = false,
  assetUrl,
}: {
  expiresAt?: string | null;
  unavailable?: boolean;
  expired?: boolean;
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
  if (expired) {
    return (
      <div
        data-testid="asset-expired"
        className="rounded-[var(--radius-xs)] border border-amber-400/40 bg-amber-400/10 px-2 py-1.5 text-amber-100"
      >
        Срок хранения истёк ·{' '}
        <Link href="/pricing" className="font-semibold underline underline-offset-2">
          {FREE_MEDIA_RETENTION_COPY_PARTS.permanent}
        </Link>
      </div>
    );
  }
  if (!expiresAt) return null;
  return (
    <div
      data-testid="asset-expiry-warning"
      className={`rounded-[var(--radius-xs)] border border-amber-400/40 bg-amber-400/10 px-2 py-1.5 text-amber-100 ${
        compact ? 'text-[9px]' : 'text-[11px]'
      }`}
    >
      <span>
        До {formatAssetExpiry(expiresAt)} · {FREE_MEDIA_RETENTION_COPY_PARTS.storage}
      </span>
      {' · '}
      {assetUrl ? (
        <a
          href={assetSrc(assetUrl)}
          download
          className="font-semibold underline underline-offset-2"
        >
          {FREE_MEDIA_RETENTION_COPY_PARTS.download}
        </a>
      ) : (
        <span>{FREE_MEDIA_RETENTION_COPY_PARTS.download}</span>
      )}
      {' · '}
      <Link href="/pricing" className="font-semibold underline underline-offset-2">
        {FREE_MEDIA_RETENTION_COPY_PARTS.permanent}
      </Link>
    </div>
  );
}

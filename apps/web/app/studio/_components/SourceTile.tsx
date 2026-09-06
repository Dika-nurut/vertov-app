// Source-bin tile (extracted from StudioClient.tsx, split 3/N).
import { useEffect, useState } from 'react';
import { assetSrc } from '@/lib/asset-src';
import { Check, Plus } from '../_icons';
import { mmss } from '../_model';
import { probeDuration } from '../_kit/probe';

/** A source-bin tile (CapCut Media §3.1): thumbnail + duration badge + an
 * "Added" badge once that source is on the timeline, with hover quick-actions
 * (add to main track on click / add as PiP overlay). Probes its own duration
 * client-side (no backend) and caches it for the tile's lifetime. */
export function SourceTile({
  assetUrl,
  added,
  onAdd,
  onPip,
}: {
  assetUrl: string;
  added: boolean;
  onAdd: () => void;
  onPip: () => void;
}) {
  const [dur, setDur] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    void probeDuration(assetUrl).then((d) => {
      if (alive) setDur(d);
    });
    return () => {
      alive = false;
    };
  }, [assetUrl]);
  return (
    // Non-interactive container holding the visual + TWO SIBLING real buttons
    // (add / PiP). No nested or focusable container — clean SR + focus order.
    <div className="group relative aspect-video overflow-hidden rounded-[var(--radius-sm)] border-[1.5px] border-[color:var(--color-line)] bg-black transition-colors hover:border-[color:var(--color-accent)] focus-within:border-[color:var(--color-accent)]">
      <video
        src={`${assetSrc(assetUrl)}#t=0.1`}
        muted
        preload="metadata"
        className="pointer-events-none h-full w-full object-cover"
      />
      {/* Primary action — covers the tile; the hover/focus Plus is its only ink. */}
      <button
        type="button"
        data-testid="source-clip"
        aria-label="Добавить на дорожку"
        onClick={onAdd}
        className="absolute inset-0 z-[1] grid place-items-center bg-black/40 text-white opacity-0 transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none"
      >
        <Plus size={20} />
      </button>
      {/* Badges paint above the primary button (pointer-events-none) so they
          stay legible and never intercept the click. */}
      {dur != null && (
        <span className="tnum pointer-events-none absolute bottom-1 left-1 z-[2] rounded-[4px] bg-black/70 px-1 font-mono text-[11px] text-white/85">
          {mmss(dur)}
        </span>
      )}
      {added && (
        <span
          data-testid="added-badge"
          className="pointer-events-none absolute left-1 top-1 z-[2] inline-flex items-center gap-0.5 rounded-[4px] bg-[rgba(var(--accent-rgb),0.92)] px-1 py-0.5 text-[11px] font-bold uppercase tracking-wide text-black"
        >
          <Check size={8} /> На дорожке
        </span>
      )}
      {/* PiP — a sibling real button, on top, in the corner. */}
      <button
        type="button"
        data-testid="source-pip"
        title="Добавить как PiP-наложение"
        onClick={onPip}
        className="absolute right-1 top-1 z-[3] rounded-[var(--radius-sm)] bg-black/70 px-1.5 py-0.5 text-[11px] font-bold text-white/85 opacity-0 transition-opacity hover:text-white focus-visible:opacity-100 group-hover:opacity-100"
      >
        PiP
      </button>
    </div>
  );
}

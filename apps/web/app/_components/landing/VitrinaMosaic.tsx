'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { assetSrc } from '@/lib/asset-src';
import { modelDisplayName, modelDisplayNameFromId } from '@/lib/models';
import type { PresetRow } from '../../generate/GenerateClient';
import { PlausibleEvent, trackEvent, type VitrinaShelfPayload } from '../PlausibleEvents';
import { VitrinaPopover } from './VitrinaPopover';
import {
  CARD_SLUGS,
  hasEnoughSeededCells,
  interleave,
  MIN_SHELF_CELLS,
  packRows,
  SHELVES,
  type VitrinaCard,
  visibleShelves,
} from './vitrina-layout';

/** Витрина is a gapless justified-row wall. Cards retain their native ratios,
 * rows sum those ratios, and CSS makes each row exactly containerWidth / ratioSum.
 * The resulting geometry reserves every tile before media loads, while mobile
 * resets to one native-ratio card per row. */

function modelChip(pack: PresetRow): string {
  return pack.model ? modelDisplayName(pack.model) : modelDisplayNameFromId(pack.modelId);
}

function metaChip(pack: PresetRow): string {
  if (pack.modality === 'video') {
    const s = Number(pack.paramsJson?.duration_seconds ?? 5);
    const res = String(pack.paramsJson?.resolution ?? '720p');
    return `0:${String(s).padStart(2, '0')} · ${res}`;
  }
  // Show the real render resolution when the pack carries one (4K / 2K /
  // 1536×1024…); the curated 2048² stills seed no resolution → fall back.
  const res = pack.paramsJson?.resolution;
  return typeof res === 'string' && res ? res.replace(/x/i, '×').toUpperCase() : '2048p';
}

const VITRINA_BADGES: Record<string, string> = {
  'demo-seedance-2-0-food-jutsu-1080p': 'новое',
  'demo-seedream-5-0-pro-flag-banner': 'новое',
  'demo-gemini-omni-golden-hour-car': 'новое',
  'demo-seedream-5-lite-bubbles-editorial': 'новое',
};

function MosaicCell({
  pack,
  card,
  firstRow,
  onOpen,
}: {
  pack: PresetRow;
  card: VitrinaCard;
  firstRow: boolean;
  onOpen: (pack: PresetRow, trigger: HTMLButtonElement) => void;
}) {
  const [hovering, setHovering] = useState(false);
  const [onScreen, setOnScreen] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [motionPreferenceKnown, setMotionPreferenceKnown] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const isVideo = card.kind === 'video';
  const poster = assetSrc(pack.samplePreviewUrl.replace(/\.mp4$/, '.png'));

  // Autoplay is scoped to what the visitor can actually see. Reading the media
  // preference happens here rather than during render so SSR stays deterministic.
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const update = () => {
      setReducedMotion(query?.matches ?? false);
      setMotionPreferenceKnown(true);
    };
    update();
    query?.addEventListener?.('change', update);
    return () => query?.removeEventListener?.('change', update);
  }, []);

  useEffect(() => {
    if (!isVideo || videoFailed || reducedMotion) return;
    const element = ref.current;
    if (!element || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => setOnScreen(!!entry?.isIntersecting), {
      threshold: 0.4,
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [isVideo, reducedMotion, videoFailed]);

  const mountVideo =
    isVideo && !videoFailed && (hovering || (motionPreferenceKnown && !reducedMotion && onScreen));

  return (
    <div
      ref={ref}
      data-testid="vitrina-cell"
      style={
        { '--card-ratio': String(card.ratio), '--cell-flex': `${card.ratio} 1 0` } as CSSProperties
      }
      className="group relative w-full flex-none overflow-hidden bg-[color:var(--color-tile)] aspect-[var(--card-ratio)] md:flex-[var(--cell-flex)] md:aspect-auto"
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={poster}
        alt={pack.title}
        width={pack.previewWidth ?? undefined}
        height={pack.previewHeight ?? undefined}
        loading={firstRow ? undefined : 'lazy'}
        decoding="async"
        onError={() => setImgFailed(true)}
        style={imgFailed ? { display: 'none' } : undefined}
        className="absolute inset-0 h-full w-full object-cover"
      />
      {mountVideo && (
        <video
          // React sets `muted` as a PROPERTY and omits the attribute, which is
          // fine only while the file is silent — a soundless track autoplays
          // under any policy. The moment a loop carries audio (2026-07-27, when
          // the regenerated effect clips kept theirs), the attribute is what
          // Safari/iOS reads to allow muted autoplay, and without it the clip
          // just sits on its poster. Set it on the element itself.
          ref={(el) => {
            if (!el) return;
            el.muted = true;
            el.setAttribute('muted', '');
          }}
          src={assetSrc(pack.samplePreviewUrl)}
          poster={poster}
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
          disablePictureInPicture
          onError={() => setVideoFailed(true)}
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}
      {card.badge && (
        <span className="absolute right-2 top-2 z-[2] rotate-6 bg-[color:var(--color-accent2)] px-[7px] py-[2px] font-mono text-[11px] font-extrabold tracking-[0.06em] text-[color:var(--color-accent2-foreground)] group-hover:hidden">
          {card.badge}
        </span>
      )}
      <span className="pointer-events-none absolute inset-0 z-[3] hidden group-hover:block group-focus-within:block">
        <span className="absolute inset-x-0 bottom-0 top-[55%] bg-gradient-to-b from-transparent to-[rgba(12,14,18,.88)]" />
        <span className="absolute inset-[7px]">
          <i className="absolute left-0 top-0 h-[14px] w-[14px] border-l-2 border-t-2 border-[color:var(--color-fg)]" />
          <i className="absolute right-0 top-0 h-[14px] w-[14px] border-r-2 border-t-2 border-[color:var(--color-fg)]" />
          <i className="absolute bottom-0 left-0 h-[14px] w-[14px] border-b-2 border-l-2 border-[color:var(--color-fg)]" />
          <i className="absolute bottom-0 right-0 h-[14px] w-[14px] border-b-2 border-r-2 border-[color:var(--color-fg)]" />
        </span>
        <span className="absolute left-[14px] right-[14px] top-[13px] flex items-center justify-between font-mono text-[11px] font-extrabold tracking-[0.08em]">
          <span className="bg-[color:var(--color-fg)] px-[7px] py-[2px] text-[color:var(--color-primary-foreground)]">
            {modelChip(pack)}
          </span>
          <span className="bg-[color:var(--color-fg)] px-[7px] py-[2px] text-[color:var(--color-primary-foreground)]">
            {metaChip(pack)}
          </span>
        </span>
      </span>
      <button
        type="button"
        aria-label={pack.title}
        className="absolute inset-0 z-[4] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--color-accent)] focus-visible:outline-offset-[-4px]"
        onClick={(event) => onOpen(pack, event.currentTarget)}
      />
      <Link
        href={`/generate?preset=${encodeURIComponent(pack.slug)}`}
        data-testid="vitrina-cell-cta"
        onClick={() => trackEvent(PlausibleEvent.landingCta, { cta: 'preset' })}
        className="absolute bottom-[13px] right-[14px] z-[5] hidden border-2 border-[color:var(--color-fg)] bg-[color:var(--color-accent)] px-[13px] py-[7px] font-mono text-[11px] font-extrabold tracking-[0.04em] text-[color:var(--color-primary-foreground)] shadow-[3px_3px_0_0_var(--color-primary-foreground)] group-hover:block group-focus-within:block group-active:translate-x-[2px] group-active:translate-y-[2px] group-active:shadow-[1px_1px_0_0_var(--color-primary-foreground)]"
      >
        Снять так же
      </Link>
    </div>
  );
}

export function VitrinaMosaic({ packs }: { packs: PresetRow[] }) {
  const [selected, setSelected] = useState<PresetRow | null>(null);
  const [shelf, setShelf] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const bySlug = useMemo(() => new Map(packs.map((pack) => [pack.slug, pack])), [packs]);
  const renderable = useMemo(
    () =>
      new Set(
        packs.flatMap((pack) => {
          const w = pack.previewWidth;
          const h = pack.previewHeight;
          return w && h && w > 0 && h > 0 ? [pack.slug] : [];
        }),
      ),
    [packs],
  );
  const visibleShelfTabs = useMemo(() => visibleShelves(SHELVES, renderable), [renderable]);
  const activeShelf = shelf === null ? null : SHELVES.find((item) => item.key === shelf);
  const activeSlugs = activeShelf?.slugs ?? CARD_SLUGS;
  const cards = useMemo(
    () =>
      activeSlugs.flatMap((slug) => {
        const pack = bySlug.get(slug);
        // Both dimensions must be POSITIVE, not merely present: a negative one
        // would give the card a negative ratio, and packRows' running sum would
        // then never reach its threshold — swallowing that card and every card
        // after it. Bound to locals so the narrowing survives into the ratio.
        const w = pack?.previewWidth;
        const h = pack?.previewHeight;
        if (!pack || !w || !h || w <= 0 || h <= 0) return [];
        const badge = VITRINA_BADGES[slug];
        return [
          {
            slug,
            ratio: w / h,
            kind: pack.modality === 'video' ? 'video' : 'image',
            ...(badge ? { badge } : {}),
          } satisfies VitrinaCard,
        ];
      }),
    [activeSlugs, bySlug],
  );
  const rows = useMemo(() => packRows(interleave(cards)), [cards]);

  useEffect(() => {
    if (!selected && triggerRef.current?.isConnected) triggerRef.current.focus();
  }, [selected]);

  const activeShelfCount =
    shelf === null
      ? 0
      : (visibleShelfTabs.find(({ shelf: item }) => item.key === shelf)?.count ?? 0);
  if (
    (shelf === null ? !hasEnoughSeededCells(renderable) : activeShelfCount < MIN_SHELF_CELLS) ||
    rows.length === 0
  )
    return null;

  return (
    <section id="vitrina" className="w-full">
      <div className="px-6 pb-10 pt-16 md:px-11 md:pb-12 md:pt-24">
        <div className="mx-auto w-full max-w-[1320px]">
          <div className="inline-flex items-center gap-2 font-mono text-[11px] font-bold uppercase tracking-[0.2em] text-[color:var(--color-accent)]">
            <span className="h-[2px] w-7 bg-[color:var(--color-accent)]" />
            Витрина
          </div>
          <h2 className="mt-2 max-w-[640px] font-display text-[clamp(26px,3.6vw,44px)] font-black uppercase leading-[0.95] tracking-[-0.02em] text-[color:var(--color-fg)]">
            Снято на Вертове
          </h2>
          <div className="mt-7 flex items-center justify-between gap-6">
            <div
              role="tablist"
              aria-label="Полки витрины"
              data-testid="vitrina-shelf-rail"
              className="inline-flex min-w-0 max-w-full flex-nowrap overflow-x-auto border-2 border-[color:var(--color-fg)] [&::-webkit-scrollbar]:hidden"
              style={{ scrollbarWidth: 'none' }}
            >
              <button
                type="button"
                role="tab"
                aria-selected={shelf === null}
                data-testid="vitrina-shelf-tab"
                data-shelf="all"
                onClick={() => setShelf(null)}
                className={`appearance-none border-0 border-r-2 border-r-[color:var(--color-fg)] last:border-r-0 px-[18px] py-[10px] whitespace-nowrap cursor-pointer font-display text-[11px] font-black uppercase tracking-[0.02em] transition-colors ${
                  // The active bg must live in the SAME conditional arm as the
                  // base class: two bg-* utilities in one class list resolve by
                  // stylesheet order, not string order, and the rail's dark
                  // active state silently lost to bg-transparent (2026-08-31).
                  shelf === null
                    ? 'bg-[color:var(--color-fg)] text-[color:var(--color-bg)]'
                    : 'bg-transparent text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)]'
                }`}
              >
                Все
              </button>
              {visibleShelfTabs.map(({ shelf: item, count }) => {
                const active = shelf === item.key;
                return (
                  <button
                    key={item.key}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    data-testid="vitrina-shelf-tab"
                    data-shelf={item.key}
                    onClick={() => {
                      setShelf(item.key);
                      trackEvent(PlausibleEvent.vitrinaShelf, {
                        shelf: item.key,
                      } satisfies VitrinaShelfPayload);
                    }}
                    className={`appearance-none border-0 border-r-2 border-r-[color:var(--color-fg)] last:border-r-0 px-[18px] py-[10px] whitespace-nowrap cursor-pointer font-display text-[11px] font-black uppercase tracking-[0.02em] transition-colors ${
                      // Same class-order trap as the Все tab above.
                      active
                        ? 'bg-[color:var(--color-fg)] text-[color:var(--color-bg)]'
                        : 'bg-transparent text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)]'
                    }`}
                  >
                    {item.trend && (
                      <span className="mr-[7px] inline-block h-[7px] w-[7px] rounded-full bg-[color:var(--color-accent2)] align-[1px]" />
                    )}
                    {item.label}
                    <sup className="ml-1 align-super font-mono text-[11px] font-bold opacity-55">
                      {count}
                    </sup>
                  </button>
                );
              })}
            </div>
            <span className="hidden shrink-0 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-[color:var(--color-faint)] lg:block">
              Обновляется каждую неделю
            </span>
          </div>
        </div>
      </div>
      <div className="flex w-full flex-col">
        {rows.map((row, rowIndex) => (
          <div
            key={row.cards.map((card) => card.slug).join('-')}
            style={{ '--row-ratio': String(row.ratioSum) } as CSSProperties}
            className="flex w-full flex-col aspect-auto md:flex-row md:self-start md:aspect-[var(--row-ratio)]"
          >
            {row.cards.map((card) => (
              <MosaicCell
                key={card.slug}
                pack={bySlug.get(card.slug)!}
                card={card}
                firstRow={rowIndex === 0}
                onOpen={(pack, trigger) => {
                  triggerRef.current = trigger;
                  setSelected(pack);
                }}
              />
            ))}
          </div>
        ))}
      </div>
      {selected && (
        <VitrinaPopover
          pack={selected}
          modelLabel={modelChip(selected)}
          onClose={() => setSelected(null)}
        />
      )}
    </section>
  );
}

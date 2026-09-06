'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { assetSrc } from '@/lib/asset-src';
import { cardVisual } from '@/lib/visual-hash';
import { plural } from '@/lib/home-utils';

/**
 * «Доска пользователя» — the authenticated home's upper half (owner-approved
 * 2026-07-08, design/homepage-launchpad-mockup). A neobrutalist Metro mosaic
 * of different-sized live tiles over the starfield: a wide GENERATIONS strip
 * + a wide PROJECTS strip (the big block, split horizontally), MEDIUM trending
 * effect/preset carousels, and a cluster of SMALL feature tiles that open a
 * tool in one tap. Tiles that carry a list of frames auto-rotate (hard cut,
 * reduced-motion → static). Every grid cell is filled (see .home-mosaic).
 */

export interface GenFrame {
  mediaUrl: string;
  kind: 'image' | 'video';
}
export interface TrendFrame {
  slug: string;
  title: string;
  eyebrow: string;
  mediaUrl: string;
  isVideo: boolean;
}
export interface ProjFrame {
  title: string;
  eyebrow: string;
  href: string;
  hashKey: string;
  surface: 'board' | 'script' | 'studio';
  /** kept only for server-side sort; unused by the tile. */
  updatedAt?: string;
}

const ROTATE_MS = 5000;

/** Hard-cut auto-rotation through `length` frames; paused under reduced motion. */
function useAutoRotate(length: number, offset = 0): number {
  const [i, setI] = useState(offset % Math.max(1, length));
  useEffect(() => {
    if (length <= 1) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const id = setInterval(
      () => setI((p) => (p + 1) % length),
      // stagger so the tiles don't all flip on the same frame
      ROTATE_MS + offset * 700,
    );
    return () => clearInterval(id);
  }, [length, offset]);
  return length ? i % length : 0;
}

function TileLabel({ eyebrow, title, big }: { eyebrow: string; title: string; big?: boolean }) {
  return (
    <span className="relative z-[3] p-3">
      <span className="block truncate font-mono text-[8.5px] font-bold uppercase tracking-[0.14em] text-[color:var(--color-accent-tint)]">
        {eyebrow}
      </span>
      <span
        className={
          'mt-1.5 block font-display font-black uppercase leading-[0.98] tracking-[-0.02em] text-white ' +
          (big ? 'text-[clamp(18px,2vw,26px)]' : 'text-[15px]')
        }
      >
        {title}
      </span>
    </span>
  );
}

const scrim =
  'pointer-events-none absolute inset-0 z-[1] bg-gradient-to-t from-[rgba(0,0,0,0.82)] via-[rgba(0,0,0,0.05)] to-transparent';
const tileBase =
  'relative flex items-end overflow-hidden border-2 border-[color:var(--color-line)] bg-[color:var(--color-tile)] shadow-[3px_3px_0_0_var(--color-shadow)] outline-none transition-transform duration-75 ease-out hover:-translate-x-px hover:-translate-y-px';

/** Wide GENERATIONS strip — fixed label, rotating media background. */
function GenerationsTile({ frames }: { frames: GenFrame[] }) {
  const i = useAutoRotate(frames.length);
  const f = frames[i];
  return (
    <Link href="/gallery" data-testid="home-generations" className={`${tileBase} home-t-gen`}>
      {f &&
        (f.kind === 'video' ? (
          <video
            src={assetSrc(f.mediaUrl)}
            autoPlay
            muted
            loop
            playsInline
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={assetSrc(f.mediaUrl)}
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
          />
        ))}
      <span className={scrim} />
      <TileLabel eyebrow="Твоя лента · авто" title="Твои кадры" big />
    </Link>
  );
}

/** Wide PROJECTS strip — rotating recent boards/scripts/montages (gradient or
 *  paper texture, no external asset). Whole tile links to the current item. */
function ProjectsTile({ frames }: { frames: ProjFrame[] }) {
  const i = useAutoRotate(frames.length);
  const f = frames[i];
  if (!f) return null;
  const paper = f.surface === 'script';
  return (
    <Link href={f.href} data-testid="home-projects" className={`${tileBase} home-t-proj`}>
      <span className="absolute inset-0" style={{ background: cardVisual(f.hashKey).background }} />
      {f.surface === 'studio' && (
        <span
          className="absolute inset-0 opacity-[0.16]"
          style={{
            backgroundImage:
              'repeating-linear-gradient(90deg, rgba(255,255,255,0.6) 0 2px, transparent 2px 16px)',
          }}
        />
      )}
      {paper && <span className="absolute inset-0 bg-[color:var(--color-paper)]" />}
      <span className={scrim} />
      <TileLabel eyebrow={f.eyebrow} title={f.title} big />
    </Link>
  );
}

/** Medium trending effect/preset carousel — rotates the trending pool. */
function TrendTile({
  frames,
  offset,
  area,
}: {
  frames: TrendFrame[];
  offset: number;
  area: string;
}) {
  const i = useAutoRotate(frames.length, offset);
  const f = frames[i];
  if (!f) return null;
  return (
    <Link
      href={`/generate?preset=${encodeURIComponent(f.slug)}`}
      data-testid="home-trend"
      className={`${tileBase} ${area}`}
    >
      {f.isVideo ? (
        <video
          src={assetSrc(f.mediaUrl)}
          autoPlay
          muted
          loop
          playsInline
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={assetSrc(f.mediaUrl)}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}
      <span className={scrim} />
      <TileLabel eyebrow={f.eyebrow} title={f.title} />
    </Link>
  );
}

/** Small solid feature tile — one tap into a tool. */
function FeatureTile({
  href,
  label,
  area,
  primary,
}: {
  href: string;
  label: string;
  area: string;
  primary?: boolean;
}) {
  return (
    <Link
      href={href}
      data-testid="home-feature"
      className={
        'press relative flex items-end overflow-hidden border-2 border-[color:var(--color-line)] shadow-[3px_3px_0_0_var(--color-shadow)] ' +
        area +
        ' ' +
        (primary ? 'bg-[color:var(--color-accent)]' : 'bg-[color:var(--color-surface)]')
      }
    >
      <span
        className={
          'w-full min-w-0 break-words p-2.5 font-display text-[12px] font-black uppercase leading-[0.92] tracking-[-0.02em] sm:p-3 sm:text-[13px] ' +
          (primary
            ? 'text-[color:var(--color-primary-foreground)]'
            : 'text-[color:var(--color-fg)]')
        }
      >
        {label}
      </span>
    </Link>
  );
}

export function HomeBoard({
  displayName,
  worksCount,
  credits,
  generations,
  projects,
  trending,
}: {
  displayName: string;
  worksCount: number;
  credits: number;
  generations: GenFrame[];
  projects: ProjFrame[];
  trending: TrendFrame[];
}) {
  const trendAreas = ['home-t-a', 'home-t-b', 'home-t-c', 'home-t-d', 'home-t-e'];

  return (
    <div className="home-sky px-4 pb-6 pt-4 sm:px-6">
      {/* greeting */}
      <div className="mb-4 flex items-end justify-between gap-5 px-1">
        <div>
          <span className="font-mono text-[10px] font-bold uppercase tracking-[0.22em] text-[color:var(--color-accent-tint)]">
            Твоя студия
          </span>
          <h1 className="mt-2 font-display text-[clamp(22px,2.6vw,32px)] font-black uppercase leading-[0.92] tracking-[-0.03em] text-[color:var(--color-fg)]">
            С возвращением,{' '}
            <span className="relative text-[color:var(--color-accent)]">
              {displayName}
              <span className="absolute -bottom-1.5 left-0 right-0 h-[3px] bg-[color:var(--color-accent)]" />
            </span>
          </h1>
        </div>
        <div className="whitespace-nowrap text-right font-mono text-[10px] font-bold uppercase leading-[1.7] tracking-[0.12em] text-[color:var(--color-faint)]">
          <span className="text-[color:var(--color-fg)]">{worksCount}</span>{' '}
          {plural(worksCount, ['кадр', 'кадра', 'кадров'])}
          <br />
          <span className="text-[color:var(--color-fg)]">{credits}</span>{' '}
          {plural(credits, ['токен', 'токена', 'токенов'])}
        </div>
      </div>

      {/* Metro mosaic */}
      <div className="home-mosaic">
        {generations.length > 0 ? (
          <GenerationsTile frames={generations} />
        ) : (
          <FeatureTile href="/generate" label="Снять первый кадр" area="home-t-gen" primary />
        )}
        {projects.length > 0 ? (
          <ProjectsTile frames={projects} />
        ) : (
          <FeatureTile href="/scenario" label="Начать проект" area="home-t-proj" />
        )}
        {trendAreas.map((area, idx) =>
          trending.length > 0 ? (
            <TrendTile key={area} frames={trending} offset={idx} area={area} />
          ) : null,
        )}
        <FeatureTile href="/generate" label="Генерация" area="home-t-f1" primary />
        <FeatureTile href="/scenario" label="Сценарий" area="home-t-f2" />
        <FeatureTile href="/boards" label="Борды" area="home-t-f3" />
        <FeatureTile href="/studio/projects" label="Студия" area="home-t-f4" />
      </div>
    </div>
  );
}

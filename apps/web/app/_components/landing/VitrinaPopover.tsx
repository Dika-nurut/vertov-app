'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { assetSrc } from '@/lib/asset-src';
import type { PresetRow } from '../../generate/GenerateClient';
import { trackEvent, PlausibleEvent } from '../PlausibleEvents';

const PANEL = 344;
const POP_MAX = 1140;

function greatestCommonDivisor(a: number, b: number): number {
  return b === 0 ? a : greatestCommonDivisor(b, a % b);
}

function formatRatio(width: number, height: number, params: Record<string, unknown>): string {
  const configured = params.aspect_ratio;
  if (typeof configured === 'string' && configured) return configured;
  const divisor = greatestCommonDivisor(width, height);
  return `${width / divisor}:${height / divisor}`;
}

function titleCase(value: string): string {
  return value
    .split(' ')
    .map((word) =>
      /^[A-Z0-9]{1,3}$/.test(word)
        ? word
        : word.toLowerCase().replace(/^\w/, (letter) => letter.toUpperCase()),
    )
    .join(' ');
}

export function VitrinaPopover({
  pack,
  modelLabel,
  onClose,
}: {
  pack: PresetRow;
  modelLabel: string;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [viewport, setViewport] = useState<{ width: number; height: number } | null>(null);
  const width = pack.previewWidth!;
  const height = pack.previewHeight!;

  useEffect(() => {
    const updateViewport = () =>
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    updateViewport();
    window.addEventListener('resize', updateViewport);
    return () => window.removeEventListener('resize', updateViewport);
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
      if (dialog.open) dialog.close();
    };
  }, []);

  const geometry = useMemo(() => {
    if (!viewport) return null;
    const mobile = viewport.width < 768;
    const boxWidth = mobile
      ? viewport.width - 28
      : Math.min(POP_MAX - PANEL, viewport.width * 0.92 - PANEL);
    const boxHeight = viewport.height * (mobile ? 0.48 : 0.74);
    const scale = Math.min(1, boxWidth / width, boxHeight / height);
    const mediaWidth = width * scale;
    const mediaHeight = height * scale;
    return {
      mobile,
      mediaWidth,
      mediaHeight,
      popoverWidth: mobile ? boxWidth : mediaWidth + PANEL,
      popoverHeight: mobile ? undefined : mediaHeight,
      mobilePanelMaxHeight: viewport.height * 0.32,
    };
  }, [height, viewport, width]);

  const poster = assetSrc(pack.samplePreviewUrl.replace(/\.mp4$/, '.png'));
  const isVideo = pack.modality === 'video';
  const params = pack.paramsJson ?? {};
  const duration = Number(params.duration_seconds ?? 5);
  const config = isVideo
    ? [
        ['Модель', titleCase(modelLabel)],
        ['Длит.', `${Number.isFinite(duration) ? duration : 5} сек`],
        ['Формат', formatRatio(width, height, params)],
      ]
    : [
        ['Модель', titleCase(modelLabel)],
        ['Качество', String(params.resolution ?? '—')],
        ['Формат', formatRatio(width, height, params)],
      ];

  return (
    <dialog
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={`vitrina-popover-title-${pack.slug}`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className="m-auto overflow-visible border-[2.5px] border-[color:var(--color-fg)] bg-[color:var(--color-surface)] p-0 text-[color:var(--color-fg)] shadow-[10px_10px_0_0_var(--color-accent)] backdrop:bg-[color:var(--color-overlay-strong)]"
      style={
        geometry
          ? { width: geometry.popoverWidth, height: geometry.popoverHeight }
          : { visibility: 'hidden' }
      }
    >
      <h3 id={`vitrina-popover-title-${pack.slug}`} className="sr-only">
        {pack.title}
      </h3>
      <button
        type="button"
        onClick={onClose}
        aria-label="Закрыть"
        className="absolute right-0 top-0 z-20 flex h-8 w-8 items-center justify-center border-[2.5px] border-[color:var(--color-fg)] bg-[color:var(--color-surface)] font-mono text-lg leading-none"
      >
        ✕
      </button>
      {geometry && (
        <div className="flex flex-col items-center md:flex-row md:items-stretch">
          <div
            className="relative shrink-0 overflow-hidden bg-[color:var(--color-tile)]"
            style={{ width: geometry.mediaWidth, height: geometry.mediaHeight }}
          >
            {isVideo ? (
              <video
                // Same attribute-vs-property trap as the wall — see VitrinaMosaic.
                // Here it also matters that `controls` lets the visitor unmute:
                // the clip must START muted to be allowed to autoplay at all.
                ref={(el) => {
                  if (!el) return;
                  el.muted = true;
                  el.setAttribute('muted', '');
                }}
                src={assetSrc(pack.samplePreviewUrl)}
                poster={poster}
                controls
                autoPlay
                muted
                loop
                playsInline
                className="h-full w-full object-cover"
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={poster}
                alt={pack.title}
                width={width}
                height={height}
                className="h-full w-full object-cover"
              />
            )}
          </div>
          <div
            className="flex w-full min-h-0 flex-col p-5 md:w-[344px]"
            style={
              geometry.mobile
                ? {
                    height: geometry.mobilePanelMaxHeight,
                    maxHeight: geometry.mobilePanelMaxHeight,
                  }
                : { height: geometry.mediaHeight }
            }
          >
            {/* pr-9 keeps the first line clear of the flush corner ✕ */}
            <p className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap pr-9 font-mono text-[11px] leading-[1.66]">
              {pack.promptTemplate}
            </p>
            <div className="mt-4 flex shrink-0">
              {config.map(([label, value], index) => (
                <div
                  key={label}
                  // The model name is the longest value and the one worth reading —
                  // give it half again the width of the two numeric cells.
                  style={{ flex: index === 0 ? '1.5 1 0' : '1 1 0' }}
                  className="-ml-[1.5px] min-w-0 border-[1.5px] border-[color:var(--color-line-soft)] p-2 first:ml-0"
                >
                  <div className="font-mono text-[11px] font-bold uppercase tracking-[0.08em]">
                    {label}
                  </div>
                  {/* wrap rather than truncate — a clipped model name is the one
                      value in this strip nobody can guess back */}
                  <div className="mt-1 break-words font-mono text-[11px] font-bold">{value}</div>
                </div>
              ))}
            </div>
            <Link
              href={`/generate?preset=${encodeURIComponent(pack.slug)}`}
              onClick={() => trackEvent(PlausibleEvent.landingCta, { cta: 'preset' })}
              className="btn btn-primary mt-4 w-full shrink-0"
            >
              Снять так же
            </Link>
          </div>
        </div>
      )}
    </dialog>
  );
}

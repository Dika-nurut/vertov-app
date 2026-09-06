'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import type { ModelRow } from '../../generate/GenerateClient';

/**
 * BoardSurface — the mobile/desktop split point for the board editor. It renders
 * the existing desktop canvas (BoardClient / GraphBoard.tsx) UNCHANGED on ≥ md.
 *
 * MOBILE: a separate, read-oriented canvas supports review and navigation while
 * graph construction stays desktop-only. Each tree is lazy-loaded, so phones do
 * not download the large desktop editor chunk.
 */
const MOBILE_QUERY = '(max-width: 767px)';

/**
 * The board's honest "not yet interactive" state: it covers the viewport from
 * SSR until the media query is measured AND the chosen editor chunk has loaded.
 * It was already `aria-busy`, but anonymous — nothing announced it and nothing
 * could address it, so a caller could not tell "still opening" from "opened and
 * empty". `role="status"` gives it a voice; the test id makes the contract
 * addressable so readiness is waited on rather than guessed at.
 */
function Loading() {
  return (
    <div
      className="min-h-0 flex-1 w-full bg-[color:var(--color-bg)]"
      role="status"
      aria-busy="true"
      aria-label="Открываем борд"
      data-testid="board-surface-loading"
    />
  );
}

const DesktopBoard = dynamic(() => import('./GraphBoard').then((m) => m.BoardClient), {
  ssr: false,
  loading: Loading,
});
const MobileBoard = dynamic(() => import('./_mobile/MobileBoard').then((m) => m.MobileBoard), {
  ssr: false,
  loading: Loading,
});

export interface BoardSurfaceProps {
  boardId: string;
  initialTitle: string;
  initialState: Record<string, unknown>;
  workspaceProjectId: string | null;
  models: ModelRow[];
  /** LIVE plan tier that gates the node model picker; null = nothing entitles
   *  the viewer today (no subscription, or an elapsed one). */
  planTier: string | null;
  /** Where a locked node's upsell points (W0/D6). */
  lockedCtaHref: string;
  apiUrl: string;
  devTools?: boolean;
  isAnonymous?: boolean;
}

export function BoardSurface(props: BoardSurfaceProps) {
  // null = not-yet-measured (SSR + first client render): render a neutral
  // loading state so we never mount (or even fetch) the wrong tree then swap.
  const [isMobile, setIsMobile] = useState<boolean | null>(null);

  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const apply = () => setIsMobile(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  if (isMobile === null) return <Loading />;
  return isMobile ? <MobileBoard {...props} /> : <DesktopBoard {...props} />;
}

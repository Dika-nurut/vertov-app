// usePenMask — the freeform (pen) mask draw tool for the preview stage.
//
// Owns draw-mode state and the in-progress polygon (normalized 0–1 vertices,
// the exact model the ffmpeg geq + CSS SVG mask both compile). Pointer→frame
// math reuses the SAME stage box (from useGizmo) the transform gizmo measures
// against, so a drawn point lands where it renders. Committing writes a
// `mask: { shape:'freeform', points }` patch — no upload, no new asset path.
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { TClip } from './_model';

/** Normalized hit radius to snap-close the path onto its first anchor. */
const CLOSE_HIT = 0.035;
/** Schema cap (packages/db StudioMask.points) — keep the geq tractable. */
const MAX_POINTS = 16;

/** Pure decision for the draw-cancel effect: cancel whenever the selection
 * stops being the clip the draw started on — cleared OR swapped to another
 * clip (not just cleared). `active===false` means nothing is being drawn, so
 * there's nothing to cancel. */
export function shouldCancelDraw(
  active: boolean,
  targetUid: string | null,
  currentSelectedUid: string | undefined | null,
): boolean {
  if (!active) return false;
  return currentSelectedUid !== targetUid;
}

export interface PenMask {
  active: boolean;
  points: { x: number; y: number }[];
  closed: boolean;
  /** Open path with enough points to close (drives the «Замкнуть» affordance). */
  canClose: boolean;
  /** Toggle the tool (starting fresh discards any in-progress path). */
  start: () => void;
  cancel: () => void;
  addPointAt: (clientX: number, clientY: number) => void;
  closePath: () => void;
  commit: () => void;
}

export function usePenMask({
  selectedClip,
  patchClip,
  stageBoxRef,
}: {
  selectedClip: TClip | null;
  patchClip: (uid: string, patch: Partial<TClip>) => void;
  stageBoxRef: React.RefObject<HTMLDivElement | null>;
}): PenMask {
  const [active, setActive] = useState(false);
  const [points, setPoints] = useState<{ x: number; y: number }[]>([]);
  const [closed, setClosed] = useState(false);
  // The clip drawing started on — captured once, so a mid-draw selection
  // change (clicking a different clip in the timeline) can't silently
  // redirect a commit onto the wrong clip.
  const targetUidRef = useRef<string | null>(null);

  const reset = useCallback(() => {
    setPoints([]);
    setClosed(false);
  }, []);

  const start = useCallback(() => {
    reset();
    setActive((a) => {
      const next = !a;
      targetUidRef.current = next ? (selectedClip?.uid ?? null) : null;
      return next;
    });
  }, [reset, selectedClip]);

  const cancel = useCallback(() => {
    reset();
    setActive(false);
    targetUidRef.current = null;
  }, [reset]);

  const closePath = useCallback(() => {
    setPoints((p) => {
      if (p.length >= 3) setClosed(true);
      return p;
    });
  }, []);

  const addPointAt = useCallback(
    (clientX: number, clientY: number) => {
      const box = stageBoxRef.current;
      if (!box || closed) return;
      const r = box.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      const x = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
      const y = Math.max(0, Math.min(1, (clientY - r.top) / r.height));
      setPoints((p) => {
        // A click back on the first anchor closes the path (mockup affordance).
        if (p.length >= 3) {
          const f = p[0]!;
          if (Math.hypot(x - f.x, y - f.y) < CLOSE_HIT) {
            setClosed(true);
            return p;
          }
        }
        if (p.length >= MAX_POINTS) return p;
        return [...p, { x, y }];
      });
    },
    [stageBoxRef, closed],
  );

  const commit = useCallback(() => {
    // Commit onto the clip drawing STARTED on, not whatever is selected now —
    // the cancel-on-selection-change effect below should already have torn
    // the draw down if selection moved to another clip, but this guard is the
    // last line of defense against patching the wrong clip.
    const uid = targetUidRef.current;
    if (!uid || !selectedClip || selectedClip.uid !== uid || points.length < 3) return;
    patchClip(uid, {
      mask: {
        shape: 'freeform',
        points,
        feather: selectedClip.mask?.feather ?? 0,
        invert: false,
      },
    });
    reset();
    setActive(false);
    targetUidRef.current = null;
  }, [selectedClip, points, patchClip, reset]);

  // Escape discards the in-progress path; Enter closes it (never touches the
  // committed mask). Only bound while drawing.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      } else if (e.key === 'Enter' && !closed) {
        e.preventDefault();
        closePath();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, closed, cancel, closePath]);

  // Losing the selection, OR the selection moving to a DIFFERENT clip than
  // the one drawing started on, abandons the draw — otherwise committing
  // would silently write A's polygon onto newly-selected clip B.
  useEffect(() => {
    if (shouldCancelDraw(active, targetUidRef.current, selectedClip?.uid ?? null)) cancel();
  }, [active, selectedClip, cancel]);

  return {
    active,
    points,
    closed,
    canClose: !closed && points.length >= 3,
    start,
    cancel,
    addPointAt,
    closePath,
    commit,
  };
}

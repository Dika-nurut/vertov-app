// useGizmo — the on-canvas transform gizmo (§C continuation state-lift).
//
// Owns the preview aspect-box ref (shared with PreviewStage for pointer math),
// the gizmo tooltip + centre snap-guides, and the drag handler. The gizmo edits
// the SAME `transform` model the inspector fields do (and that already renders
// end-to-end), so preview==export holds for free. Verbatim move from
// StudioClient — zero behaviour change.
'use client';

import { useCallback, useRef, useState } from 'react';
import { DEFAULT_TRANSFORM } from './_model';
import type { TClip, TTransform } from './_model';

export function useGizmo({
  selectedClip,
  patchClip,
  togglePlay,
}: {
  selectedClip: TClip | null;
  patchClip: (uid: string, patch: Partial<TClip>) => void;
  togglePlay: () => void;
}) {
  // The preview aspect box, measured for screen↔transform pointer math.
  const stageBoxRef = useRef<HTMLDivElement | null>(null);
  const [gizmoTip, setGizmoTip] = useState<string | null>(null);
  const [snapGuides, setSnapGuides] = useState<{ x: boolean; y: boolean }>({ x: false, y: false });
  const gizmoDrag = useRef<{
    mode: 'move' | 'scale' | 'rotate';
    sx: number; // pointer at drag start
    sy: number;
    moved: number; // total px travelled (click vs drag)
    start: TTransform; // transform at drag start
    cx: number; // layer centre in screen px
    cy: number;
    w: number; // stage box size
    h: number;
    startDist: number; // centre→pointer at start (for scale)
  } | null>(null);

  // Drag a gizmo handle. Window-listener pattern (same as the trim/overlay
  // drags) so move/up keep firing even as the pointer leaves the tiny handle.
  const onGizmoDown = useCallback(
    (mode: 'move' | 'scale' | 'rotate', e: React.PointerEvent) => {
      if (!selectedClip || !stageBoxRef.current) return;
      e.stopPropagation();
      e.preventDefault();
      const rect = stageBoxRef.current.getBoundingClientRect();
      const start = { ...DEFAULT_TRANSFORM, ...selectedClip.transform };
      const cx = rect.left + rect.width / 2 + (start.posX / 100) * rect.width;
      const cy = rect.top + rect.height / 2 + (start.posY / 100) * rect.height;
      const d = {
        mode,
        sx: e.clientX,
        sy: e.clientY,
        moved: 0,
        start,
        cx,
        cy,
        w: rect.width,
        h: rect.height,
        startDist: Math.hypot(e.clientX - cx, e.clientY - cy) || 1,
      };
      gizmoDrag.current = d;
      const uid = selectedClip.uid;
      const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
      const move = (ev: PointerEvent) => {
        d.moved += Math.abs(ev.clientX - d.sx) + Math.abs(ev.clientY - d.sy);
        const next = { ...d.start };
        if (d.mode === 'move') {
          let posX = d.start.posX + ((ev.clientX - d.sx) / d.w) * 100;
          let posY = d.start.posY + ((ev.clientY - d.sy) / d.h) * 100;
          const gx = Math.abs(posX) < 2.5; // snap to centre
          const gy = Math.abs(posY) < 2.5;
          if (gx) posX = 0;
          if (gy) posY = 0;
          setSnapGuides({ x: gx, y: gy });
          next.posX = clamp(Math.round(posX), -100, 100);
          next.posY = clamp(Math.round(posY), -100, 100);
          setGizmoTip(`${next.posX}%, ${next.posY}%`);
        } else if (d.mode === 'scale') {
          const dist = Math.hypot(ev.clientX - d.cx, ev.clientY - d.cy);
          next.scale = clamp(Math.round(d.start.scale * (dist / d.startDist) * 100) / 100, 0.2, 3);
          setGizmoTip(`${Math.round(next.scale * 100)}%`);
        } else {
          let deg = (Math.atan2(ev.clientY - d.cy, ev.clientX - d.cx) * 180) / Math.PI + 90;
          if (deg > 180) deg -= 360;
          const snap = Math.round(deg / 15) * 15;
          if (Math.abs(deg - snap) < 6) deg = snap; // soft 15° detents
          next.rotate = clamp(Math.round(deg), -180, 180);
          setGizmoTip(`${next.rotate}°`);
        }
        patchClip(uid, { transform: next });
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        setGizmoTip(null);
        setSnapGuides({ x: false, y: false });
        // A press that never really moved = play/pause, not a transform edit.
        if (d.mode === 'move' && d.moved < 4) togglePlay();
        gizmoDrag.current = null;
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [selectedClip],
  );

  return { stageBoxRef, gizmoTip, snapGuides, onGizmoDown };
}

/**
 * Where to drop a new node so it does NOT land on existing ones.
 *
 * Both Higgsfield Canvas and Runway Workflows spawn new nodes at the
 * viewport center and let them stack — their own automation docs flag it
 * as a hazard. We walk a small grid (right, then next row) from the
 * desired point until a cell is free.
 */

export interface Pt {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

// Sized to clear the largest node (the generate widget ≈ 300×240) plus a gap,
// so two freshly-spawned shots never overlap.
const CELL_W = 340;
const CELL_H = 296;
const COLS = 3;
const MAX_CELLS = 60;

export function findFreePosition(desired: Pt, taken: Pt[]): Pt {
  for (let i = 0; i < MAX_CELLS; i++) {
    const p = {
      x: desired.x + (i % COLS) * CELL_W,
      y: desired.y + Math.floor(i / COLS) * CELL_H,
    };
    const clash = taken.some(
      (t) => Math.abs(t.x - p.x) < CELL_W * 0.9 && Math.abs(t.y - p.y) < CELL_H * 0.9,
    );
    if (!clash) return p;
  }
  return desired;
}

/** Keep an entire node inside a visible canvas rectangle. */
export function clampNodePosition(point: Pt, size: Size, bounds: Bounds): Pt {
  const minX = Math.min(bounds.left, bounds.right);
  const minY = Math.min(bounds.top, bounds.bottom);
  const maxX = Math.max(minX, Math.max(bounds.left, bounds.right) - size.width);
  const maxY = Math.max(minY, Math.max(bounds.top, bounds.bottom) - size.height);
  return {
    x: Math.min(Math.max(point.x, minX), maxX),
    y: Math.min(Math.max(point.y, minY), maxY),
  };
}

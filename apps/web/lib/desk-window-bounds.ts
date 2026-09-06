/**
 * Folder windows are dragged by their title bar, and that bar carries the only
 * close control. Clamping just the left/top edges let a window be dragged past
 * the right/bottom of the viewport until neither the bar nor the close button
 * could be reached — Escape does not close windows, so a reload was the only
 * recovery. Both edges are clamped here, and the same function re-clamps open
 * windows when the viewport shrinks.
 */

/** The desk menubar occupies the top strip; windows never hide under it. */
export const DESK_WINDOW_MIN_TOP = 46;

/** How much of the window must stay above the bottom edge — a full title bar. */
export const DESK_WINDOW_KEEP_BOTTOM = 46;

export interface DeskWindowPosition {
  left: number;
  top: number;
}

export interface DeskWindowSize {
  width: number;
  height: number;
}

export interface DeskViewport {
  width: number;
  height: number;
}

export function clampDeskWindowPosition(
  position: DeskWindowPosition,
  size: DeskWindowSize,
  viewport: DeskViewport,
): DeskWindowPosition {
  // Horizontal: the whole window stays in, because the close control sits at
  // the window's RIGHT edge — keeping a left-hand sliver on screen would keep
  // the bar draggable but throw the close button away.
  const maxLeft = Math.max(0, viewport.width - size.width);
  const maxTop = Math.max(DESK_WINDOW_MIN_TOP, viewport.height - DESK_WINDOW_KEEP_BOTTOM);
  return {
    left: Math.min(Math.max(0, position.left), maxLeft),
    top: Math.min(Math.max(DESK_WINDOW_MIN_TOP, position.top), maxTop),
  };
}

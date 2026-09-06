import { describe, expect, it } from 'vitest';
import {
  clampDeskWindowPosition,
  DESK_WINDOW_KEEP_BOTTOM,
  DESK_WINDOW_MIN_TOP,
} from './desk-window-bounds';

const WINDOW = { width: 620, height: 420 };
const SMALL_DESKTOP = { width: 1280, height: 720 };
const LARGE_DESKTOP = { width: 1440, height: 900 };

describe('clampDeskWindowPosition', () => {
  it('leaves an ordinary drag inside the viewport untouched', () => {
    expect(clampDeskWindowPosition({ left: 440, top: 112 }, WINDOW, SMALL_DESKTOP)).toEqual({
      left: 440,
      top: 112,
    });
    expect(clampDeskWindowPosition({ left: 620, top: 300 }, WINDOW, LARGE_DESKTOP)).toEqual({
      left: 620,
      top: 300,
    });
  });

  it('keeps the existing left/top floors', () => {
    expect(clampDeskWindowPosition({ left: -400, top: -400 }, WINDOW, SMALL_DESKTOP)).toEqual({
      left: 0,
      top: DESK_WINDOW_MIN_TOP,
    });
  });

  it('keeps the close control on screen when dragged past the right edge at 1280x720', () => {
    const clamped = clampDeskWindowPosition({ left: 4_000, top: 200 }, WINDOW, SMALL_DESKTOP);
    expect(clamped.left).toBe(1280 - 620);
    expect(clamped.left + WINDOW.width).toBeLessThanOrEqual(1280);
  });

  it('keeps the close control on screen when dragged past the right edge at 1440x900', () => {
    const clamped = clampDeskWindowPosition({ left: 4_000, top: 200 }, WINDOW, LARGE_DESKTOP);
    expect(clamped.left).toBe(1440 - 620);
    expect(clamped.left + WINDOW.width).toBeLessThanOrEqual(1440);
  });

  it('keeps a grabbable title bar when dragged past the bottom edge', () => {
    for (const viewport of [SMALL_DESKTOP, LARGE_DESKTOP]) {
      const clamped = clampDeskWindowPosition({ left: 300, top: 9_000 }, WINDOW, viewport);
      expect(clamped.top).toBe(viewport.height - DESK_WINDOW_KEEP_BOTTOM);
      expect(viewport.height - clamped.top).toBeGreaterThanOrEqual(DESK_WINDOW_KEEP_BOTTOM);
    }
  });

  it('pulls an already-placed window back when the viewport shrinks under it', () => {
    const placed = clampDeskWindowPosition({ left: 800, top: 700 }, WINDOW, LARGE_DESKTOP);
    expect(placed).toEqual({ left: 800, top: 700 });
    const reclamped = clampDeskWindowPosition(placed, WINDOW, SMALL_DESKTOP);
    expect(reclamped).toEqual({ left: 660, top: 720 - DESK_WINDOW_KEEP_BOTTOM });
  });

  it('never produces a negative left when the window is wider than the viewport', () => {
    const clamped = clampDeskWindowPosition(
      { left: 900, top: 300 },
      { width: 900, height: 400 },
      {
        width: 800,
        height: 600,
      },
    );
    expect(clamped.left).toBe(0);
  });
});

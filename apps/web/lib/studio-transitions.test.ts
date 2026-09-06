// Crown-jewel guard for the geometric transitions (research/studio-transitions
// -goal-2026-06.md): the CSS preview `txPreview` MUST mirror the ffmpeg xfade
// modes frame-for-frame. The formulas below were derived from a red/green xfade
// frame-probe (boundary at (1−p)·W for slide+wipe; iris at √2/2≈71%); if these
// stay green the preview can't silently drift from the export.
import { describe, expect, it } from 'vitest';
import { txPreview, TRANSITIONS } from '../app/studio/_model';
import type { Transition } from '../app/studio/_model';

describe('txPreview — preview==export geometry', () => {
  it('crossfade/dip/flash stay byte-identical to the legacy opacity curves', () => {
    // crossfade: outgoing 1→0, incoming full (null)
    expect(txPreview('crossfade', 'out', 0.25)).toEqual({ opacity: 0.75 });
    expect(txPreview('crossfade', 'in', 0.25)).toBeNull();
    // dip/flash: outgoing max(0,1−2p), incoming max(0,2p−1)
    expect(txPreview('dip', 'out', 0.25)).toEqual({ opacity: 0.5 });
    expect(txPreview('dip', 'in', 0.75)).toEqual({ opacity: 0.5 });
    expect(txPreview('flash', 'out', 0.75)).toEqual({ opacity: 0 });
    expect(txPreview('flash', 'in', 0.25)).toEqual({ opacity: 0 });
  });

  it('cut is null on both sides', () => {
    expect(txPreview('cut', 'out', 0.5)).toBeNull();
    expect(txPreview('cut', 'in', 0.5)).toBeNull();
  });

  it('slide is a push: both clips translate and abut at the (1−p) edge', () => {
    // slideleft: outgoing exits left by p, incoming enters from right at (1−p)
    expect(txPreview('slideleft', 'out', 0.3)).toEqual({
      opacity: 1,
      transform: 'translateX(-30%)',
    });
    expect(txPreview('slideleft', 'in', 0.3)).toEqual({
      opacity: 1,
      transform: 'translateX(70%)',
    });
    // mirror direction
    expect(txPreview('slideright', 'out', 0.3)?.transform).toBe('translateX(30%)');
    expect(txPreview('slideright', 'in', 0.3)?.transform).toBe('translateX(-70%)');
    // vertical
    expect(txPreview('slideup', 'in', 0.3)?.transform).toBe('translateY(70%)');
    expect(txPreview('slidedown', 'in', 0.3)?.transform).toBe('translateY(-70%)');
  });

  it('the abut is exact: outgoing right edge meets incoming left edge', () => {
    const p = 0.4;
    // outgoing translated by -p → its right edge sits at (1−p) of the box
    // incoming translated by (1−p) → its left edge sits at (1−p) of the box
    const out = txPreview('slideleft', 'out', p)!.transform!;
    const inc = txPreview('slideleft', 'in', p)!.transform!;
    expect(out).toBe('translateX(-40%)');
    expect(inc).toBe('translateX(60%)'); // (1−0.4)=0.6 → 60%, meeting at 60% of box
  });

  it('wipe clips the OUTGOING with an inset sweep; incoming sits full underneath', () => {
    // wipeleft: B reveals on the right growing left → cut the outgoing from the right by p
    expect(txPreview('wipeleft', 'out', 0.3)).toEqual({
      opacity: 1,
      clipPath: 'inset(0 30% 0 0)',
    });
    expect(txPreview('wipeleft', 'in', 0.3)).toBeNull();
    expect(txPreview('wiperight', 'out', 0.3)?.clipPath).toBe('inset(0 0 0 30%)');
    expect(txPreview('wipeup', 'out', 0.3)?.clipPath).toBe('inset(0 0 30% 0)');
    expect(txPreview('wipedown', 'out', 0.3)?.clipPath).toBe('inset(30% 0 0 0)');
  });

  it('iris: circleopen grows on the lifted incoming, circleclose shrinks on the outgoing', () => {
    const open = txPreview('circleopen', 'in', 0.5)!;
    expect(open.lift).toBe(true);
    expect(open.clipPath).toBe('circle(36.0% at 50% 50%)'); // 0.5·72
    expect(txPreview('circleopen', 'out', 0.5)).toEqual({ opacity: 1 });
    // closes: radius shrinks as (1−p)·72 on the outgoing (no lift — already on top)
    expect(txPreview('circleclose', 'out', 0.25)?.clipPath).toBe('circle(54.0% at 50% 50%)');
    expect(txPreview('circleclose', 'in', 0.25)).toBeNull();
    // fully covers the frame by p=1 (≥ √2/2 ≈ 70.7%)
    const full = parseFloat(txPreview('circleopen', 'in', 1)!.clipPath!.match(/([\d.]+)%/)![1]!);
    expect(full).toBeGreaterThanOrEqual(70.7);
  });

  it('zoomin lifts the incoming, scales 1.6→1, late (p²) opacity', () => {
    const z = txPreview('zoomin', 'in', 0.5)!;
    expect(z.lift).toBe(true);
    expect(z.opacity).toBe(0.25); // 0.5²
    expect(z.transform).toBe('scale(1.300)'); // 1 + 0.5·0.6
    expect(txPreview('zoomin', 'in', 1)?.transform).toBe('scale(1.000)');
    expect(txPreview('zoomin', 'in', 0)?.opacity).toBe(0);
  });

  it('every catalog transition resolves a preview (no unhandled id)', () => {
    for (const t of TRANSITIONS) {
      // at least one role must yield a definition (cut is the only all-null id)
      const any =
        txPreview(t.id as Transition, 'out', 0.5) || txPreview(t.id as Transition, 'in', 0.5);
      if (t.id === 'cut') expect(any).toBeNull();
      else expect(any).not.toBeNull();
    }
  });
});

import { describe, expect, it } from 'vitest';
import { freeformMaskUri, maskStyle } from './_model';
import type { TClip } from './_model';

// A minimal base clip; only `mask` matters for these specs.
function clip(mask: TClip['mask']): TClip {
  return {
    uid: 'c1',
    url: 'a.mp4',
    dur: 5,
    inSec: 0,
    outSec: 5,
    speed: 1,
    muted: false,
    volumeDb: 0,
    transition: 'cut',
    transitionSec: 0.5,
    filter: 'none',
    mask,
  };
}

const TRI = [
  { x: 0.5, y: 0.2 },
  { x: 0.8, y: 0.8 },
  { x: 0.2, y: 0.8 },
];

describe('freeformMaskUri (CSS mirror of the freeform geq)', () => {
  it('embeds the polygon vertices (×100) in the SVG path', () => {
    const uri = freeformMaskUri(TRI, 0, false)!;
    expect(uri).toContain('data:image/svg+xml,');
    // Each vertex appears scaled into the 0–100 viewBox.
    expect(uri).toContain('50.00,20.00');
    expect(uri).toContain('80.00,80.00');
    expect(uri).toContain('20.00,80.00');
    // Non-inverted fill is even-odd (fill-rule='evenodd' after the data-uri
    // encoder single-quotes it), matching the worker's PNPOLY parity so a
    // SELF-INTERSECTING polygon fills the identical region in preview and export.
    // SVG's default `nonzero` would fill crossed-loop overlaps the geq leaves empty.
    expect(uri).toContain(`fill-rule='evenodd'`);
  });

  it('inverts by cutting the polygon as an evenodd hole in a full-frame rect', () => {
    const uri = freeformMaskUri(TRI, 0, true)!;
    expect(uri).toContain('evenodd');
    // Full-frame rect precedes the polygon (M0,0 H100 V100 H0 Z …).
    expect(uri).toContain('M0,0 H100 V100 H0 Z');
  });

  it('adds a gaussian blur only when feathered', () => {
    expect(freeformMaskUri(TRI, 0, false)!).not.toContain('feGaussianBlur');
    expect(freeformMaskUri(TRI, 40, false)!).toContain('feGaussianBlur');
  });

  it('confines the feathered blur to inside the hard edge via feComposite operator="in" (never bleeds outward, mirroring the worker geq\'s hard-zero-outside gating)', () => {
    const uri = freeformMaskUri(TRI, 40, false)!;
    expect(uri).toContain('feComposite');
    expect(uri).toContain(`operator='in'`); // quotes get single-quoted by the data-uri encoder
    // The blur is composited against the SAME unblurred fill (SourceGraphic), not
    // a loose blur applied directly to the output.
    expect(uri).toContain("in2='SourceGraphic'");
  });

  it('inverting a feathered mask flood-fills white and subtracts the confined ramp over the full canvas (operator="out"), not the polygon\'s own evenodd hole', () => {
    const uri = freeformMaskUri(TRI, 40, true)!;
    expect(uri).toContain('feFlood');
    expect(uri).toContain(`operator='out'`);
    // The invert lives in the filter (operator='out'), NOT the M0,0-rect evenodd
    // hole trick — that path only appears in the hard-edge invert branch.
    expect(uri).not.toContain('M0,0 H100 V100 H0 Z');
  });

  it('returns null for a degenerate (<3-point) polygon', () => {
    expect(freeformMaskUri([{ x: 0.1, y: 0.1 }], 0, false)).toBeNull();
    expect(freeformMaskUri([], 20, false)).toBeNull();
  });
});

describe('maskStyle — freeform branch', () => {
  it('sets a mask-image data URI for a valid freeform polygon', () => {
    const s = maskStyle(clip({ shape: 'freeform', points: TRI, feather: 0 }));
    expect(typeof s.maskImage).toBe('string');
    expect(String(s.maskImage)).toContain('data:image/svg+xml,');
    expect(s.WebkitMaskImage).toBe(s.maskImage);
  });

  it('renders nothing (no mask-image) when the freeform polygon has <3 points', () => {
    const s = maskStyle(clip({ shape: 'freeform', points: [{ x: 0.1, y: 0.1 }], feather: 0 }));
    expect(s.maskImage).toBeUndefined();
  });
});

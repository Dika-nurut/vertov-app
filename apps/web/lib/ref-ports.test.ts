import { describe, expect, it } from 'vitest';
import {
  REF_CAP,
  imageHandleIndex,
  normalizeRefEdges,
  referenceImageHandleIndex,
  refSlotCount,
} from './ref-ports';

describe('imageHandleIndex', () => {
  it('parses slot handles', () => {
    expect(imageHandleIndex('images[0]')).toBe(0);
    expect(imageHandleIndex('images[13]')).toBe(13);
  });
  it('treats the legacy handle as slot 0', () => {
    expect(imageHandleIndex('images')).toBe(0);
  });
  it('rejects other handles', () => {
    expect(imageHandleIndex('prompt')).toBeNull();
    expect(imageHandleIndex('out')).toBeNull();
    expect(imageHandleIndex(null)).toBeNull();
    expect(imageHandleIndex(undefined)).toBeNull();
    expect(imageHandleIndex('images[x]')).toBeNull();
  });
});

describe('referenceImageHandleIndex', () => {
  it('parses separate reference-image slots without treating frame handles as references', () => {
    expect(referenceImageHandleIndex('referenceImages[0]')).toBe(0);
    expect(referenceImageHandleIndex('referenceImages[8]')).toBe(8);
    expect(referenceImageHandleIndex('images[0]')).toBeNull();
  });
});

describe('refSlotCount', () => {
  it('shows one empty slot when nothing is wired', () => {
    expect(refSlotCount([], REF_CAP.video)).toBe(1);
    expect(refSlotCount([], REF_CAP.image)).toBe(1);
  });
  it('grows by one past the highest occupied slot', () => {
    expect(refSlotCount([0], REF_CAP.image)).toBe(2);
    expect(refSlotCount([0, 1], REF_CAP.image)).toBe(3);
  });
  it('never exceeds the cap (video = 2)', () => {
    expect(refSlotCount([0], REF_CAP.video)).toBe(2);
    expect(refSlotCount([0, 1], REF_CAP.video)).toBe(2);
  });
  it('keeps a freed lower slot visible while a higher one is wired', () => {
    // slot 0 freed, slot 2 still wired → render 0..3
    expect(refSlotCount([2], REF_CAP.image)).toBe(4);
  });
});

describe('normalizeRefEdges', () => {
  it('re-keys legacy edges to sequential slots per target', () => {
    const edges = [
      { id: 'a', target: 'g1', targetHandle: 'images' },
      { id: 'b', target: 'g1', targetHandle: 'images' },
      { id: 'c', target: 'g2', targetHandle: 'images' },
      { id: 'd', target: 'g1', targetHandle: 'prompt' },
    ];
    const out = normalizeRefEdges(edges);
    expect(out.map((e) => e.targetHandle)).toEqual([
      'images[0]',
      'images[1]',
      'images[0]',
      'prompt',
    ]);
  });
  it('leaves already-slotted edges alone', () => {
    const edges = [{ id: 'a', target: 'g1', targetHandle: 'images[1]' }];
    expect(normalizeRefEdges(edges)).toEqual(edges);
  });
});

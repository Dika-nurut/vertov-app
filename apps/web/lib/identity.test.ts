import { describe, expect, it } from 'vitest';
import { characterReferenceSupport, identityRefQuality, shotsUsingCharacter } from './identity';
import type { ShotEdgeLike, ShotNodeLike } from './shot-list';

describe('identityRefQuality', () => {
  it('flags no refs', () => {
    const q = identityRefQuality([]);
    expect(q.strength).toBe('none');
    expect(q.refCount).toBe(0);
    expect(q.warnings.length).toBeGreaterThan(0);
  });
  it('flags a single ref as weak', () => {
    expect(identityRefQuality(['a']).strength).toBe('weak');
  });
  it('treats 2–3 refs as ok (no warnings)', () => {
    const q = identityRefQuality(['a', 'b', 'c']);
    expect(q.strength).toBe('ok');
    expect(q.warnings).toEqual([]);
  });
  it('treats 4+ refs as strong', () => {
    expect(identityRefQuality(['a', 'b', 'c', 'd']).strength).toBe('strong');
  });
  it('ignores empty/non-string urls in the count', () => {
    expect(identityRefQuality(['a', '', undefined as unknown as string]).refCount).toBe(1);
  });
});

describe('characterReferenceSupport', () => {
  it('distinguishes no image input, ordinary guidance, and a dedicated reference route', () => {
    expect(characterReferenceSupport({ modelId: 'gpt-image-2', imageInputMax: 0 })).toBe(
      'unsupported',
    );
    expect(characterReferenceSupport({ modelId: 'seedream-4-5', imageInputMax: 4 })).toBe('guided');
    expect(
      characterReferenceSupport({
        modelId: 'seedance-2-0-reference-to-video',
        imageInputMax: 9,
      }),
    ).toBe('specialized');
  });

  // A board whose picker resolved nothing — catalog still loading, or a plan
  // that entitles no model for this mode — knows nothing about references.
  // Calling that 'unsupported' blamed the model for a gated picker (2026-07-27).
  it('reports an unresolved model as unknown, never as a missing capability', () => {
    expect(characterReferenceSupport({ modelId: undefined, imageInputMax: 0 })).toBe('unknown');
    expect(characterReferenceSupport({ modelId: undefined, imageInputMax: 4 })).toBe('unknown');
  });
});

describe('shotsUsingCharacter', () => {
  const nodes: ShotNodeLike[] = [
    { id: 'cast1', type: 'cast', position: { x: 0, y: 0 } },
    { id: 'g1', type: 'generate', position: { x: 0, y: 0 } },
    { id: 'g2', type: 'generate', position: { x: 0, y: 0 } },
    { id: 'note1', type: 'note', position: { x: 0, y: 0 } },
  ];
  it('lists generate nodes wired from the cast node', () => {
    const edges: ShotEdgeLike[] = [
      { source: 'cast1', target: 'g1' },
      { source: 'cast1', target: 'g2' },
    ];
    expect(shotsUsingCharacter('cast1', nodes, edges)).toEqual(['g1', 'g2']);
  });
  it('ignores edges to non-generate targets and de-dupes', () => {
    const edges: ShotEdgeLike[] = [
      { source: 'cast1', target: 'note1' },
      { source: 'cast1', target: 'g1' },
      { source: 'cast1', target: 'g1' },
    ];
    expect(shotsUsingCharacter('cast1', nodes, edges)).toEqual(['g1']);
  });
  it('returns [] when the character is unwired', () => {
    expect(shotsUsingCharacter('cast1', nodes, [])).toEqual([]);
  });
});

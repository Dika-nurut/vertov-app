import { describe, expect, it } from 'vitest';
import { buildStoryboard } from '../src/storyboard-model';

const cast = (id: string, name: string) => ({
  id,
  type: 'cast',
  position: { x: 0, y: 0 },
  data: { castKind: 'character', name, imageUrls: ['http://a/c.png'] },
});
const shot = (id: string, x: number, data: Record<string, unknown> = {}) => ({
  id,
  type: 'generate',
  position: { x, y: 100 },
  data: { mode: 'video', prompt: `кадр ${id}`, ...data },
});
const shotAt = (id: string, x: number, y: number, data: Record<string, unknown> = {}) => ({
  ...shot(id, x, data),
  position: { x, y },
});
const prompt = (id: string, text: string) => ({
  id,
  type: 'prompt',
  position: { x: 0, y: 0 },
  data: { text },
});
const edge = (source: string, target: string, targetHandle = 'images[0]') => ({
  source,
  target,
  targetHandle,
});

describe('buildStoryboard (previz S5)', () => {
  it('orders shots by canvas row, numbers them, reads grammar + duration', () => {
    const sb = buildStoryboard({
      nodes: [
        shotAt('g2', 500, 0, {
          shot: { size: 'cu', move: 'push', lens: '85' },
          durationSeconds: 8,
        }),
        shotAt('g1', 100, 100),
      ],
      edges: [],
    });
    expect(sb.cards.map((c) => c.prompt)).toEqual(['кадр g2', 'кадр g1']);
    expect(sb.cards[0]).toMatchObject({
      index: 1,
      grammar: 'Крупный · 85мм · Наезд',
      durationSeconds: 8,
    });
    expect(sb.cards[1]!.durationSeconds).toBe(5); // default
  });

  it('uses a wired prompt instead of the inline prompt', () => {
    const sb = buildStoryboard({
      nodes: [shot('g1', 0, { prompt: 'inline prompt' }), prompt('p1', 'wired prompt')],
      edges: [edge('p1', 'g1', 'prompt')],
    });

    expect(sb.cards[0]!.prompt).toBe('wired prompt');
  });

  it('keeps the inline prompt when there is no prompt edge', () => {
    const sb = buildStoryboard({
      nodes: [shot('g1', 0, { prompt: 'inline prompt' })],
      edges: [],
    });

    expect(sb.cards[0]!.prompt).toBe('inline prompt');
  });

  it('ignores a scene context edge', () => {
    const sb = buildStoryboard({
      nodes: [
        shot('g1', 0, { prompt: 'inline prompt' }),
        { id: 'scene', type: 'scene', position: { x: 0, y: 0 }, data: { title: 'Сцена' } },
      ],
      edges: [edge('scene', 'g1', 'scene')],
    });
    expect(sb.cards[0]!.prompt).toBe('inline prompt');
  });

  it('falls back to the inline prompt when wired text is whitespace-only', () => {
    const sb = buildStoryboard({
      nodes: [shot('g1', 0, { prompt: 'inline prompt' }), prompt('p1', '   ')],
      edges: [edge('p1', 'g1', 'prompt')],
    });

    expect(sb.cards[0]!.prompt).toBe('inline prompt');
  });

  it('uses ids to order shots at identical coordinates', () => {
    const sb = buildStoryboard({
      nodes: [shotAt('g2', 100, 100), shotAt('g1', 100, 100)],
      edges: [],
    });

    expect(sb.cards.map((c) => c.prompt)).toEqual(['кадр g1', 'кадр g2']);
    expect(sb.cards.map((c) => c.index)).toEqual([1, 2]);
  });

  it('frame: keyframe render wins over lastFrameUrl; cast names collect through the bridge', () => {
    const sb = buildStoryboard({
      nodes: [
        cast('c1', 'Алиса'),
        {
          id: 'kf',
          type: 'generate',
          position: { x: 50, y: 0 },
          data: { mode: 'image', resultUrl: 'http://a/kf.png' },
        },
        shot('g1', 100, { lastFrameUrl: 'http://a/last.jpg' }),
      ],
      edges: [edge('c1', 'kf'), edge('kf', 'g1')],
    });
    expect(sb.cards[0]!.frameUrl).toBe('http://a/kf.png');
    expect(sb.cards[0]!.castNames).toEqual(['Алиса']); // via the keyframe hop
    expect(sb.castNames).toEqual(['Алиса']);
  });

  it('falls back to lastFrameUrl, then null; ignores image shots and non-generate nodes', () => {
    const sb = buildStoryboard({
      nodes: [
        shot('g1', 0, { lastFrameUrl: 'http://a/last.jpg' }),
        shot('g2', 100),
        { id: 'img', type: 'generate', position: { x: 200, y: 0 }, data: { mode: 'image' } },
        { id: 'note', type: 'note', position: { x: 300, y: 0 }, data: { text: 'x' } },
      ],
      edges: [],
    });
    expect(sb.cards).toHaveLength(2);
    expect(sb.cards[0]!.frameUrl).toBe('http://a/last.jpg');
    expect(sb.cards[1]!.frameUrl).toBeNull();
  });

  it('direct cast wiring (no keyframe) also names the cast', () => {
    const sb = buildStoryboard({
      nodes: [cast('c1', 'Боб'), shot('g1', 0)],
      edges: [edge('c1', 'g1')],
    });
    expect(sb.cards[0]!.castNames).toEqual(['Боб']);
  });

  it('empty/garbage state yields an empty board', () => {
    expect(buildStoryboard({}).cards).toEqual([]);
    expect(buildStoryboard({ nodes: [], edges: [] }).castNames).toEqual([]);
  });
});

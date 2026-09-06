import { describe, expect, it } from 'vitest';
import { deriveShotList, type ShotEdgeLike, type ShotNodeLike } from './shot-list';

const gen = (
  id: string,
  x: number,
  y: number,
  data: Record<string, unknown> = {},
): ShotNodeLike => ({
  id,
  type: 'generate',
  position: { x, y },
  data: { mode: 'video', ...data },
});
const cast = (
  id: string,
  castKind: 'character' | 'location' | 'product',
  name: string,
): ShotNodeLike => ({
  id,
  type: 'cast',
  position: { x: 0, y: 0 },
  data: { castKind, name },
});
const prompt = (id: string, text: string): ShotNodeLike => ({
  id,
  type: 'prompt',
  position: { x: 0, y: 0 },
  data: { text },
});

describe('deriveShotList', () => {
  it('returns [] when there are no generate nodes', () => {
    expect(
      deriveShotList(
        [
          cast('c1', 'character', 'Аня'),
          { id: 'text', type: 'text', position: { x: 0, y: 0 }, data: { text: 'заметка' } },
          { id: 'frame', type: 'frame', position: { x: 0, y: 0 }, data: { title: 'Секция' } },
        ],
        [],
      ),
    ).toEqual([]);
  });

  it('keeps text and frame organizers out of the production shot list', () => {
    const rows = deriveShotList(
      [
        { id: 'frame', type: 'frame', position: { x: 0, y: 0 }, data: { title: 'Секция' } },
        { id: 'text', type: 'text', position: { x: 20, y: 20 }, data: { text: 'заметка' } },
        gen('shot', 100, 100),
      ],
      [],
    );
    expect(rows.map((row) => row.id)).toEqual(['shot']);
  });

  it('excludes cast-owned reference shots from the production list', () => {
    expect(
      deriveShotList(
        [
          gen('reference', 0, 0, { originCastNodeId: 'cast-1', status: 'done' }),
          gen('production', 1, 1),
        ],
        [],
      ),
    ).toMatchObject([{ id: 'production', shotNumber: 1 }]);
  });

  it('keeps a schema-valid shot with empty provenance in the production list', () => {
    expect(deriveShotList([gen('empty-origin', 0, 0, { originCastNodeId: '' })], [])).toMatchObject(
      [{ id: 'empty-origin', shotNumber: 1 }],
    );
  });

  it('numbers shots in reading order (top→bottom, then left→right)', () => {
    // `d` sits far right on the TOP row: under a column-major (x, then y) sort it
    // would land last instead of second, so this fixture fails if the order flips.
    const nodes = [gen('b', 100, 200), gen('a', 0, 0), gen('c', 0, 200), gen('d', 500, 0)];
    const rows = deriveShotList(nodes, []);
    expect(rows.map((r) => r.id)).toEqual(['a', 'd', 'c', 'b']);
    expect(rows.map((r) => r.shotNumber)).toEqual([1, 2, 3, 4]);
  });

  it('uses a wired prompt instead of the inline prompt', () => {
    const rows = deriveShotList(
      [gen('g1', 0, 0, { prompt: 'inline prompt' }), prompt('p1', 'wired prompt')],
      [{ source: 'p1', target: 'g1', targetHandle: 'prompt' }],
    );

    expect(rows[0]!.prompt).toBe('wired prompt');
  });

  it('keeps the inline prompt when there is no prompt edge', () => {
    const rows = deriveShotList([gen('g1', 0, 0, { prompt: 'inline prompt' })], []);

    expect(rows[0]!.prompt).toBe('inline prompt');
  });

  it('ignores a scene context edge when deriving shots', () => {
    const rows = deriveShotList(
      [
        gen('g1', 0, 0, { prompt: 'inline prompt' }),
        {
          id: 'scene',
          type: 'scene',
          position: { x: 0, y: 0 },
          data: { title: 'Сцена' },
        },
      ],
      [{ source: 'scene', target: 'g1', targetHandle: 'scene' }],
    );
    expect(rows[0]!.prompt).toBe('inline prompt');
  });

  it('falls back to the inline prompt when wired text is whitespace-only', () => {
    const rows = deriveShotList(
      [gen('g1', 0, 0, { prompt: 'inline prompt' }), prompt('p1', '   ')],
      [{ source: 'p1', target: 'g1', targetHandle: 'prompt' }],
    );

    expect(rows[0]!.prompt).toBe('inline prompt');
  });

  it('uses ids to order shots at identical coordinates', () => {
    const rows = deriveShotList([gen('b', 100, 100), gen('a', 100, 100)], []);

    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(rows.map((r) => r.shotNumber)).toEqual([1, 2]);
  });

  it('resolves connected cast + location names via edges', () => {
    const nodes = [
      gen('g1', 0, 0, { prompt: 'герой бежит' }),
      cast('ch', 'character', 'Аня'),
      cast('loc', 'location', 'Крыша'),
      cast('other', 'character', 'Не подключён'),
    ];
    const edges: ShotEdgeLike[] = [
      { source: 'ch', target: 'g1' },
      { source: 'loc', target: 'g1' },
    ];
    const [row] = deriveShotList(nodes, edges);
    expect(row!.cast).toEqual(['Аня']);
    expect(row!.locations).toEqual(['Крыша']);
  });

  it('places a wired product name in cast, not locations', () => {
    const nodes = [gen('g1', 0, 0), cast('product', 'product', 'Бутылка')];
    const [row] = deriveShotList(nodes, [{ source: 'product', target: 'g1' }]);

    expect(row!.cast).toEqual(['Бутылка']);
    expect(row!.locations).toEqual([]);
  });

  it('derives title from the prompt, falling back to «Кадр N»', () => {
    const rows = deriveShotList(
      [gen('a', 0, 0, { prompt: '  закат над городом  ' }), gen('b', 0, 100)],
      [],
    );
    expect(rows[0]!.title).toBe('закат над городом');
    expect(rows[1]!.title).toBe('Кадр 2');
  });

  it('carries mode/model/status/take through', () => {
    const [row] = deriveShotList(
      [
        gen('a', 0, 0, {
          mode: 'image',
          modelId: 'seedream-4-5',
          status: 'done',
          resultUrl: 'http://x/1.png',
          resultKind: 'image',
          count: 4,
        }),
      ],
      [],
    );
    expect(row).toMatchObject({
      mode: 'image',
      modelId: 'seedream-4-5',
      status: 'done',
      resultUrl: 'http://x/1.png',
      resultKind: 'image',
      count: 4,
    });
  });

  it('defaults an unknown status to idle', () => {
    const [row] = deriveShotList([gen('a', 0, 0, { status: 'bogus' })], []);
    expect(row!.status).toBe('idle');
  });

  it('carries the compact shot-grammar label (B-4)', () => {
    const [row] = deriveShotList([gen('a', 0, 0, { shot: { size: 'cu', moves: ['push'] } })], []);
    expect(row!.grammarLabel).toBe('Крупный · Наезд');
  });
});

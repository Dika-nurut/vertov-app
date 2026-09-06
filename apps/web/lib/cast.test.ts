import { describe, expect, it } from 'vitest';
import {
  assembleShotRefs,
  CAST_KIND_LABEL,
  CAST_KIND_LABEL_GENITIVE,
  CAST_NODE_LABEL,
  CAST_NODE_LABEL_GENITIVE_PLURAL,
  castIsReady,
  castPromptPrefix,
  planCastWiring,
  SCENE_OBJECT_KIND_LABEL,
  type RefSource,
} from './cast';
import { castReferencePrompt } from './cast-reference';

const alice = {
  castKind: 'character' as const,
  name: 'Алиса',
  imageUrls: ['http://a/alice1.png', 'http://a/alice2.png'],
};
const cafe = {
  castKind: 'location' as const,
  name: 'Кафе у моря',
  imageUrls: ['http://a/cafe.png'],
  videoUrl: 'http://a/cafe-motion.mp4',
};
const bottle = {
  castKind: 'product' as const,
  name: 'Бутылка',
  imageUrls: ['http://a/bottle.png'],
};

describe('assembleShotRefs', () => {
  it('subject leads: character and product stills before location stills before loose refs', () => {
    const sources: RefSource[] = [
      { kind: 'image', url: 'http://a/loose.png' },
      { kind: 'cast', cast: cafe },
      { kind: 'cast', cast: alice },
      { kind: 'cast', cast: bottle },
    ];
    expect(assembleShotRefs(sources).imageUrls).toEqual([
      'http://a/alice1.png',
      'http://a/alice2.png',
      'http://a/bottle.png',
      'http://a/cafe.png',
      'http://a/loose.png',
    ]);
  });

  it('collects location motion refs into videoUrls', () => {
    const { videoUrls } = assembleShotRefs([{ kind: 'cast', cast: cafe }]);
    expect(videoUrls).toEqual(['http://a/cafe-motion.mp4']);
  });

  it('dedupes and caps at 9 stills / 3 videos', () => {
    const many = {
      castKind: 'character' as const,
      name: 'X',
      imageUrls: Array.from({ length: 12 }, (_, i) => `http://a/${i}.png`),
    };
    const vids = Array.from({ length: 5 }, (_, i) => ({
      kind: 'cast' as const,
      cast: {
        castKind: 'location' as const,
        name: `L${i}`,
        imageUrls: [],
        videoUrl: `http://v/${i}.mp4`,
      },
    }));
    const out = assembleShotRefs([
      { kind: 'cast', cast: many },
      { kind: 'cast', cast: many },
      ...vids,
    ]);
    expect(out.imageUrls).toHaveLength(9);
    expect(out.videoUrls).toHaveLength(3);
  });

  it('skips empty urls', () => {
    const out = assembleShotRefs([
      { kind: 'image', url: '' },
      {
        kind: 'cast',
        cast: { castKind: 'character', name: 'Y', imageUrls: ['', 'http://a/y.png'] },
      },
    ]);
    expect(out.imageUrls).toEqual(['http://a/y.png']);
    expect(out.videoUrls).toEqual([]);
  });
});

describe('castPromptPrefix', () => {
  it('names character and location in Russian', () => {
    expect(castPromptPrefix([alice, cafe])).toBe(
      'Персонаж Алиса — как на референсных кадрах. Локация: Кафе у моря.',
    );
  });
  it('pluralizes for several characters', () => {
    const bob = { castKind: 'character' as const, name: 'Боб', imageUrls: ['http://a/b.png'] };
    expect(castPromptPrefix([alice, bob])).toBe(
      'Персонажи Алиса, Боб — как на референсных кадрах.',
    );
  });
  it('places a singular product clause after characters and before locations', () => {
    expect(castPromptPrefix([alice, bottle, cafe])).toBe(
      `Персонаж Алиса — как на референсных кадрах. ${CAST_KIND_LABEL.product} Бутылка — как на референсных кадрах. Локация: Кафе у моря.`,
    );
  });
  it('pluralizes several products', () => {
    const secondBottle = {
      castKind: 'product' as const,
      name: 'Коробка',
      imageUrls: ['http://a/box.png'],
    };
    expect(castPromptPrefix([bottle, secondBottle])).toBe(
      `${CAST_KIND_LABEL.product}ы Бутылка, Коробка — как на референсных кадрах.`,
    );
  });
  it('empty when no named cast', () => {
    expect(castPromptPrefix([])).toBe('');
    expect(castPromptPrefix([{ castKind: 'character', name: '  ', imageUrls: [] }])).toBe('');
  });
});

describe('assembleShotRefs — loose video sources (S3 motion refs)', () => {
  it('routes loose video refs into videoUrls, not imageUrls', () => {
    const out = assembleShotRefs([
      { kind: 'video', url: 'http://a/motion.mp4' },
      { kind: 'image', url: 'http://a/still.png' },
    ]);
    expect(out.imageUrls).toEqual(['http://a/still.png']);
    expect(out.videoUrls).toEqual(['http://a/motion.mp4']);
  });
});

describe('planCastWiring (Режиссёр auto-wire, S3)', () => {
  const ready = (id: string, castKind: 'character' | 'location' | 'product') => ({
    id,
    cast: { castKind, name: id, imageUrls: [`http://a/${id}.png`] },
  });

  it('wires every ready cast into every shot, characters in slot 0', () => {
    const edges = planCastWiring(
      [ready('loc', 'location'), ready('char', 'character')],
      ['g1', 'g2'],
      2,
    );
    expect(edges).toEqual([
      { source: 'char', target: 'g1', targetHandle: 'images[0]' },
      { source: 'loc', target: 'g1', targetHandle: 'images[1]' },
      { source: 'char', target: 'g2', targetHandle: 'images[0]' },
      { source: 'loc', target: 'g2', targetHandle: 'images[1]' },
    ]);
  });

  it('orders products with characters before locations', () => {
    const edges = planCastWiring(
      [ready('loc', 'location'), ready('char', 'character'), ready('product', 'product')],
      ['g1'],
      3,
    );
    expect(edges.map((edge) => edge.source)).toEqual(['char', 'product', 'loc']);
  });

  it('skips not-ready cast and respects the slot cap', () => {
    const empty = { id: 'e', cast: { castKind: 'character' as const, name: 'e', imageUrls: [] } };
    const edges = planCastWiring(
      [empty, ready('c1', 'character'), ready('c2', 'character'), ready('l1', 'location')],
      ['g1'],
      2,
    );
    expect(edges.map((e) => e.source)).toEqual(['c1', 'c2']);
  });

  it('no shots or no cast → no edges', () => {
    expect(planCastWiring([], ['g1'], 2)).toEqual([]);
    expect(planCastWiring([ready('c', 'character')], [], 2)).toEqual([]);
  });
});

describe('castIsReady', () => {
  it('requires at least one still', () => {
    expect(castIsReady(alice)).toBe(true);
    expect(castIsReady({ castKind: 'location', name: 'L', imageUrls: [] })).toBe(false);
  });
});

describe('cast display vocabulary', () => {
  // Russian inflects. These forms are spelled out rather than derived from the
  // nominative, because `${CAST_KIND_LABEL.character.toLowerCase()}` inside
  // «Имя …» produces «Имя человек», which is not a sentence. Locking the exact
  // phrases the cast card builds keeps a future edit from reintroducing that.
  it('builds grammatical card copy for every kind', () => {
    expect(`${CAST_NODE_LABEL} · ${CAST_KIND_LABEL.product}`).toBe('Объект · Товар');
    expect(`Имя ${CAST_KIND_LABEL_GENITIVE.character}…`).toBe('Имя человека…');
    expect(`Название ${CAST_KIND_LABEL_GENITIVE.product}…`).toBe('Название товара…');
    expect(`Название ${CAST_KIND_LABEL_GENITIVE.location}…`).toBe('Название места…');
    expect(`внешность ${CAST_KIND_LABEL_GENITIVE.character}`).toBe('внешность человека');
    expect(`вид ${CAST_KIND_LABEL_GENITIVE.product}`).toBe('вид товара');
    expect(`На борде пока нет ${CAST_NODE_LABEL_GENITIVE_PLURAL}.`).toBe(
      'На борде пока нет объектов.',
    );
  });

  it('locks the compact scene-object chip vocabulary', () => {
    expect(SCENE_OBJECT_KIND_LABEL).toEqual({ person: 'чел', place: 'место', thing: 'вещь' });
  });

  it.each([
    ['character', 'Человек', 'человека'],
    ['location', 'Место', 'места'],
    ['product', 'Товар', 'товара'],
  ] as const)('locks the %s reference sentence frame', (kind, label, genitive) => {
    expect(castReferencePrompt(kind, 'Анна')).toBe(
      `Объект: ${label} «Анна». Референс ${genitive} — нейтральный вид для дальнейшей генерации.`,
    );
  });
});

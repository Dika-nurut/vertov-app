import { describe, expect, it } from 'vitest';
import {
  SCENE_OBJECTS_MAX,
  SCENE_OBJECTS_CEILING_CREDITS,
  SCENE_OBJECTS_INPUT_MAX_BYTES,
  SCENE_OBJECTS_OUTPUT_MAX_TOKENS,
  SCENE_OBJECTS_SOURCE_MAX_CHARS,
  matchSceneObjects,
  sceneObjectSchema,
  sceneObjectsModelResultSchema,
  validateSceneObjects,
  type SceneObject,
} from './scene-objects';
import { llmPricingRecord } from './llm-pricing-workbook';

const object = (overrides: Partial<SceneObject> = {}): SceneObject => ({
  kind: 'person',
  name: 'Анна',
  description: 'Женщина в пальто.',
  quotes: ['Анна входит.'],
  ...overrides,
});

describe('scene object contract', () => {
  it('keeps the source/output bounds and rejects overlong fields', () => {
    expect(SCENE_OBJECTS_SOURCE_MAX_CHARS).toBe(32_000);
    expect(SCENE_OBJECTS_OUTPUT_MAX_TOKENS).toBe(800);
    expect(SCENE_OBJECTS_MAX).toBe(12);
    expect(SCENE_OBJECTS_INPUT_MAX_BYTES).toBe(68_000);
    expect(SCENE_OBJECTS_CEILING_CREDITS).toBe(3);
    expect(SCENE_OBJECTS_CEILING_CREDITS).toBe(
      llmPricingRecord('boards_scene_objects', 'default').credits,
    );
    expect(
      sceneObjectSchema.safeParse({
        ...object(),
        name: 'я'.repeat(81),
      }).success,
    ).toBe(false);
    expect(
      sceneObjectSchema.safeParse({
        ...object(),
        description: 'я'.repeat(201),
      }).success,
    ).toBe(false);
    expect(
      sceneObjectSchema.safeParse({
        ...object(),
        quotes: ['a', 'b', 'c', 'd'],
      }).success,
    ).toBe(false);
    expect(sceneObjectSchema.safeParse({ ...object(), name: '   ' }).success).toBe(false);
    expect(sceneObjectSchema.safeParse({ ...object(), description: '\t' }).success).toBe(false);
  });

  it('truncates the response to twelve objects instead of rejecting the batch', () => {
    const names = Array.from({ length: 13 }, (_, i) => `Гость ${i}`);
    const result = validateSceneObjects(
      sceneObjectsModelResultSchema.parse({
        objects: names.map((name) => object({ name, quotes: [`${name}.`] })),
      }),
      names.map((name) => `${name}.`).join(' '),
    );

    expect(result.objects).toHaveLength(SCENE_OBJECTS_MAX);
    expect(result.dropped).toBe(1);
  });

  it('drops a quote that is not a whitespace-equivalent source substring', () => {
    const result = validateSceneObjects(
      { objects: [object({ quotes: ['Анна\nвходит.', 'этого нет'] })] },
      'Анна  входит.',
    );

    expect(result.objects[0]?.quotes).toEqual(['Анна\nвходит.']);
    expect(result.dropped).toBe(1);
  });

  it('drops an object whose quotes all fail and counts every discarded item', () => {
    const result = validateSceneObjects(
      { objects: [object({ quotes: ['этого нет'] })] },
      'Анна входит.',
    );

    expect(result.objects).toEqual([]);
    expect(result.dropped).toBe(2); // the invented quote and the now-unanchored object
  });

  it('drops a hallucinated name even when it borrows an unrelated valid quote', () => {
    const result = validateSceneObjects(
      {
        objects: [object({ name: 'НЛО', quotes: ['Анна входит.'] })],
      },
      'Анна входит.',
    );

    expect(result.objects).toEqual([]);
    expect(result.dropped).toBe(1);
  });

  it('accepts a name in the source immediately around its own quote', () => {
    const result = validateSceneObjects(
      {
        objects: [object({ name: 'Камера', quotes: ['На столе лежит'] })],
      },
      'На столе лежит камера.',
    );

    expect(result.objects).toHaveLength(1);
  });

  it('drops whitespace-only fields even when called past the schema', () => {
    const result = validateSceneObjects(
      {
        objects: [
          object({ name: ' ', quotes: ['Анна входит.'] }),
          object({ description: '\t', quotes: ['Анна входит.'] }),
        ],
      } as never,
      'Анна входит.',
    );

    expect(result.objects).toEqual([]);
    expect(result.dropped).toBe(2);
  });

  it('reports quote, object, and overflow drops together', () => {
    const result = validateSceneObjects(
      {
        objects: [
          object({ quotes: ['Анна входит.', 'лишняя цитата'] }),
          object({ name: 'Призрак', quotes: ['этого нет'] }),
          ...Array.from({ length: 12 }, (_, i) =>
            object({ name: `Гость ${i}`, quotes: [`Гость ${i}.`] }),
          ),
        ],
      },
      `Анна входит. ${Array.from({ length: 12 }, (_, i) => `Гость ${i}.`).join(' ')}`,
    );

    expect(result.objects).toHaveLength(SCENE_OBJECTS_MAX);
    expect(result.dropped).toBe(4); // 1 quote + 1 unanchored object + 1 overflow object
  });
});

describe('matchSceneObjects', () => {
  it('returns the existing board node id for an exact normalized kind/name match', () => {
    expect(
      matchSceneObjects(
        [object({ name: '  АННА  ' })],
        [{ id: 'cast-1', castKind: 'character', name: 'Анна' }],
      ),
    ).toEqual([{ status: 'match', nodeId: 'cast-1' }]);
  });

  it('does not fuzzy-match a longer name', () => {
    expect(
      matchSceneObjects(
        [object({ name: 'АННА' })],
        [{ id: 'cast-1', castKind: 'character', name: 'Анна Сергеевна' }],
      ),
    ).toEqual([{ status: 'new' }]);
  });

  it('reports same-name candidates as ambiguous', () => {
    expect(
      matchSceneObjects(
        [object()],
        [
          { id: 'cast-1', castKind: 'character', name: 'Анна' },
          { id: 'cast-2', castKind: 'character', name: ' АННА ' },
        ],
      ),
    ).toEqual([{ status: 'ambiguous', candidateIds: ['cast-1', 'cast-2'] }]);
  });

  it('keeps a sole same-kind match reusable and carries cross-kind context without ids', () => {
    expect(
      matchSceneObjects(
        [object()],
        [
          { id: 'cast-1', castKind: 'character', name: 'Анна' },
          { id: 'cast-2', castKind: 'location', name: 'Анна' },
        ],
      ),
    ).toEqual([
      {
        status: 'match',
        nodeId: 'cast-1',
        crossKindCandidates: [{ castKind: 'location', name: 'Анна' }],
      },
    ]);
  });

  it('carries a cross-kind-only collision as explanatory context, never as a reusable id', () => {
    expect(
      matchSceneObjects([object()], [{ id: 'cast-2', castKind: 'location', name: 'Анна' }]),
    ).toEqual([
      {
        status: 'new',
        crossKindCandidates: [{ castKind: 'location', name: 'Анна' }],
      },
    ]);
  });

  it('offers only same-kind ids when same-kind matches are ambiguous', () => {
    expect(
      matchSceneObjects(
        [object()],
        [
          { id: 'cast-1', castKind: 'character', name: 'Анна' },
          { id: 'cast-2', castKind: 'character', name: ' АННА ' },
          { id: 'cast-3', castKind: 'location', name: 'Анна' },
        ],
      ),
    ).toEqual([
      {
        status: 'ambiguous',
        candidateIds: ['cast-1', 'cast-2'],
        crossKindCandidates: [{ castKind: 'location', name: 'Анна' }],
      },
    ]);
  });

  it('maps people, places, and things to exactly one same-kind card', () => {
    expect(
      matchSceneObjects(
        [
          object({ kind: 'person', name: 'Анна' }),
          object({ kind: 'place', name: 'Квартира' }),
          object({ kind: 'thing', name: 'Камера' }),
        ],
        [
          { id: 'character-1', castKind: 'character', name: 'Анна' },
          { id: 'location-1', castKind: 'location', name: 'Квартира' },
          { id: 'product-1', castKind: 'product', name: 'Камера' },
        ],
      ),
    ).toEqual([
      { status: 'match', nodeId: 'character-1' },
      { status: 'match', nodeId: 'location-1' },
      { status: 'match', nodeId: 'product-1' },
    ]);
  });

  it('reports a missing name as new', () => {
    expect(
      matchSceneObjects(
        [object({ name: 'Мать' })],
        [{ id: 'cast-1', castKind: 'character', name: 'Анна' }],
      ),
    ).toEqual([{ status: 'new' }]);
  });
});

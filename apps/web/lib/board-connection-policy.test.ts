import { describe, expect, it } from 'vitest';
import {
  createBoardConnectionPolicy,
  isBoardConnectionTargetOccupied,
  validateBoardConnectionCandidate,
  type BoardConnectionNodeLike,
} from './board-connection-policy';

const model = {
  id: 'edit',
  kind: 'image-edit' as const,
  capabilities: { maxRefs: 4 },
};
const media = (id: string): BoardConnectionNodeLike => ({
  id,
  type: 'media',
  data: { mediaKind: 'image', url: `${id}.png` },
});
const generate = (id: string): BoardConnectionNodeLike => ({
  id,
  type: 'generate',
  data: { mode: 'image', modelId: 'edit', prompt: id, count: 1, status: 'idle' },
});
const scene = (id: string): BoardConnectionNodeLike => ({
  id,
  type: 'scene',
  data: { title: 'Сцена', synopsis: '', sourceText: '' },
});
const aiprompt = (id: string): BoardConnectionNodeLike => ({
  id,
  type: 'aiprompt',
  data: { brief: '', model: 'claude', mode: 'video' },
});
const cast = (id: string): BoardConnectionNodeLike => ({
  id,
  type: 'cast',
  data: { castKind: 'character', name: 'Аня', imageUrls: ['a.png'] },
});

describe('validateBoardConnectionCandidate', () => {
  it('accepts a model-compatible image input', () => {
    expect(
      validateBoardConnectionCandidate({
        nodes: [media('m'), generate('g')],
        edges: [],
        connection: {
          source: 'm',
          sourceHandle: 'out',
          target: 'g',
          targetHandle: 'images[0]',
        },
        modelForNode: () => model,
      }),
    ).toEqual({ ok: true });
  });

  it('rejects an occupied target handle with its semantic reason', () => {
    const result = validateBoardConnectionCandidate({
      nodes: [media('m1'), media('m2'), generate('g')],
      edges: [
        {
          source: 'm1',
          sourceHandle: 'out',
          target: 'g',
          targetHandle: 'images[0]',
        },
      ],
      connection: {
        source: 'm2',
        sourceHandle: 'out',
        target: 'g',
        targetHandle: 'images[0]',
      },
      modelForNode: () => model,
    });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('уже занят') });
  });

  it('rejects a generate dependency that closes a cycle', () => {
    const result = validateBoardConnectionCandidate({
      nodes: [generate('a'), generate('b')],
      edges: [{ source: 'b', sourceHandle: 'out', target: 'a', targetHandle: 'images[0]' }],
      connection: {
        source: 'a',
        sourceHandle: 'out',
        target: 'b',
        targetHandle: 'images[0]',
      },
      modelForNode: () => model,
    });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('замкнёт цикл') });
  });

  it('compiles stable graph work once for repeated pointer samples', () => {
    let modelLookups = 0;
    const policy = createBoardConnectionPolicy({
      nodes: [media('m'), generate('g')],
      edges: [],
      modelForNode: () => {
        modelLookups += 1;
        return model;
      },
    });
    const candidate = {
      source: 'm',
      sourceHandle: 'out',
      target: 'g',
      targetHandle: 'images[0]',
    };

    expect(policy.validate(candidate)).toEqual({ ok: true });
    expect(policy.validate(candidate)).toEqual({ ok: true });
    expect(modelLookups).toBe(1);
  });

  it('accepts scene context and rejects a second connection at policy level', () => {
    const first = {
      source: 's1',
      sourceHandle: 'context',
      target: 'ai',
      targetHandle: 'scene',
    };
    expect(
      validateBoardConnectionCandidate({
        nodes: [scene('s1'), scene('s2'), aiprompt('ai')],
        edges: [],
        connection: first,
        modelForNode: () => undefined,
      }),
    ).toEqual({ ok: true });
    expect(
      validateBoardConnectionCandidate({
        nodes: [scene('s1'), scene('s2'), aiprompt('ai')],
        edges: [first],
        connection: { ...first, source: 's2' },
        modelForNode: () => undefined,
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('уже занят') });
  });

  it('accepts scene context into cast and rejects a second scene edge', () => {
    const first = {
      source: 's1',
      sourceHandle: 'context',
      target: 'cast',
      targetHandle: 'scene',
    };
    expect(
      validateBoardConnectionCandidate({
        nodes: [scene('s1'), scene('s2'), cast('cast')],
        edges: [],
        connection: first,
        modelForNode: () => undefined,
      }),
    ).toEqual({ ok: true });
    expect(
      validateBoardConnectionCandidate({
        nodes: [scene('s1'), scene('s2'), cast('cast')],
        edges: [first],
        connection: { ...first, source: 's2' },
        modelForNode: () => undefined,
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('уже занят') });
  });

  it('does not exempt another cast handle from the non-generate rejection', () => {
    expect(
      validateBoardConnectionCandidate({
        nodes: [scene('s'), cast('cast')],
        edges: [],
        connection: {
          source: 's',
          sourceHandle: 'context',
          target: 'cast',
          targetHandle: 'other',
        },
        modelForNode: () => undefined,
      }),
    ).toEqual({ ok: false, reason: 'Этот узел не принимает входящие связи.' });
  });

  it('applies the same scene occupancy rule to quick-connect offers', () => {
    expect(
      isBoardConnectionTargetOccupied(
        [{ targetHandle: 'scene' }, { targetHandle: 'prompt' }],
        'scene',
      ),
    ).toBe(true);
    expect(isBoardConnectionTargetOccupied([{ targetHandle: 'prompt' }], 'scene')).toBe(false);
  });

  it('keeps the existing rejection for a non-generate target', () => {
    expect(
      validateBoardConnectionCandidate({
        nodes: [generate('g'), { id: 'cast', type: 'cast', data: {} }],
        edges: [],
        connection: {
          source: 'g',
          sourceHandle: 'out',
          target: 'cast',
          targetHandle: 'in',
        },
        modelForNode: () => model,
      }),
    ).toEqual({ ok: false, reason: 'Этот узел не принимает входящие связи.' });
  });
});

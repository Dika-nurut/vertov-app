import { describe, expect, it } from 'vitest';
import {
  BOARD_NODE_VERSION,
  boardGenerateSettingIssues,
  boardGenerateSettingsPatch,
  compileBoardGenerationRequest,
  type BoardGenerateData,
  type BoardNode,
  type BoardNodeType,
} from './board-contract';
import {
  analyzeBoardModelChange,
  diagnoseBoardGraph,
  diagnoseBoardTarget,
  type BoardTargetInput,
} from './board-diagnostics';

const node = (id: string, type: BoardNodeType, data: Record<string, unknown>): BoardNode =>
  ({
    id,
    version: BOARD_NODE_VERSION,
    type,
    position: { x: 0, y: 0 },
    data,
  }) as BoardNode;

const veo = {
  id: 'veo',
  kind: 'video' as const,
  maxDurationSeconds: 8,
  capabilities: {
    frames: ['first', 'last'],
    audio: false,
    durations: [4, 6, 8],
    resolutions: ['720p', '1080p'],
    aspect_ratios: ['16:9', '9:16'],
  },
};

describe('Board setting diagnostics', () => {
  it('reports every explicit value a model would normalize or ignore', () => {
    const data: BoardGenerateData = {
      mode: 'video',
      modelId: 'veo',
      prompt: 'x',
      count: 1,
      status: 'idle',
      durationSeconds: 7,
      videoResolution: '480p',
      videoAspect: '21:9',
      generateAudio: true,
    };
    const issues = boardGenerateSettingIssues(data, veo);
    expect(issues.map((issue) => issue.field)).toEqual([
      'durationSeconds',
      'videoResolution',
      'videoAspect',
      'generateAudio',
    ]);
    expect(boardGenerateSettingsPatch(issues)).toEqual({
      durationSeconds: 6,
      videoResolution: '720p',
      videoAspect: '16:9',
      generateAudio: false,
    });
  });

  it('makes the request compiler fail before silently normalizing a saved setting', () => {
    const result = compileBoardGenerationRequest({
      data: {
        mode: 'video',
        modelId: 'veo',
        prompt: '',
        count: 1,
        status: 'idle',
        durationSeconds: 7,
      },
      model: veo,
      prompt: 'x',
    });
    expect(result).toMatchObject({ ok: false, field: 'durationSeconds' });
  });
});

describe('Board target diagnostics', () => {
  it('labels generic image sources as first/last-frame roles for the selected model', () => {
    const target = node('target', 'generate', {
      mode: 'video',
      modelId: 'veo',
      prompt: 'x',
      count: 1,
      status: 'idle',
    });
    const connections: BoardTargetInput[] = [0, 1].map((slot) => ({
      edgeId: `e${slot}`,
      sourceNodeId: `m${slot}`,
      source: node(`m${slot}`, 'media', { mediaKind: 'image', url: `${slot}.png` }),
      sourceHandle: 'out',
      targetHandle: `images[${slot}]`,
    }));
    const result = diagnoseBoardTarget({
      nodeId: 'target',
      target,
      targetModel: veo,
      connections,
      requireReady: true,
    });
    expect(result.executable).toBe(true);
    expect(result.roles).toMatchObject([
      { edgeId: 'e0', payload: 'image.frame.first', label: 'первый кадр' },
      { edgeId: 'e1', payload: 'image.frame.last', label: 'последний кадр' },
    ]);
  });

  it('points at the exact edge that exceeds an expanded reference limit', () => {
    const target = node('target', 'generate', {
      mode: 'image',
      modelId: 'edit-three',
      prompt: 'x',
      count: 1,
      status: 'idle',
    });
    const model = {
      id: 'edit-three',
      kind: 'image-edit' as const,
      capabilities: { maxRefs: 3 },
    };
    const connections: BoardTargetInput[] = ['a', 'b'].map((id, index) => ({
      edgeId: `edge-${id}`,
      sourceNodeId: id,
      source: node(id, 'cast', {
        castKind: 'character',
        name: id,
        imageUrls: [`${id}1`, `${id}2`],
      }),
      sourceHandle: 'out',
      targetHandle: `images[${index}]`,
    }));
    const result = diagnoseBoardTarget({
      nodeId: 'target',
      target,
      targetModel: model,
      connections,
    });
    expect(result.edgeIssues).toHaveLength(1);
    expect(result.edgeIssues[0]).toMatchObject({
      edgeId: 'edge-b',
      reason: expect.stringContaining('Подключено 4 изображения'),
    });
  });
});

describe('Board graph and model-change diagnostics', () => {
  it('marks exact cycle edges and execution-readiness failures', () => {
    const generateData = (id: string): Record<string, unknown> => ({
      mode: 'image',
      modelId: 'edit',
      prompt: id === 'a' ? 'x' : '',
      count: 1,
      status: 'idle',
    });
    const nodes = [
      { id: 'a', type: 'generate' as const, data: generateData('a') },
      { id: 'b', type: 'generate' as const, data: generateData('b') },
      { id: 'empty', type: 'media' as const, data: { mediaKind: 'image', url: '' } },
    ];
    const edges = [
      { id: 'ab', source: 'a', sourceHandle: 'out', target: 'b', targetHandle: 'images[0]' },
      { id: 'ba', source: 'b', sourceHandle: 'out', target: 'a', targetHandle: 'images[0]' },
      {
        id: 'empty-b',
        source: 'empty',
        sourceHandle: 'out',
        target: 'b',
        targetHandle: 'images[1]',
      },
    ];
    const result = diagnoseBoardGraph({
      nodes,
      edges,
      modelForNode: () => ({
        id: 'edit',
        kind: 'image-edit',
        capabilities: { maxRefs: 3 },
      }),
      requireReady: true,
    });
    expect(result.executable).toBe(false);
    expect(result.invalidEdgeIds.sort()).toEqual(['ab', 'ba', 'empty-b'].sort());
    expect(
      result.nodes.find((entry) => entry.nodeId === 'b')?.edgeIssues.map((issue) => issue.reason),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining('не содержит файл'),
        expect.stringContaining('замыкает цикл'),
      ]),
    );
  });

  it('returns affected edges and explicit setting replacements before a model switch', () => {
    const data: BoardGenerateData = {
      mode: 'video',
      modelId: 'reference',
      prompt: 'x',
      count: 1,
      status: 'idle',
      durationSeconds: 10,
      generateAudio: true,
    };
    const cast = node('cast', 'cast', {
      castKind: 'character',
      name: 'A',
      imageUrls: ['1', '2'],
    });
    const impact = analyzeBoardModelChange({
      nodeId: 'target',
      data,
      nextModel: veo,
      connections: [
        {
          edgeId: 'cast-edge',
          sourceNodeId: 'cast',
          source: cast,
          sourceHandle: 'out',
          targetHandle: 'images[0]',
        },
      ],
    });
    expect(impact.canApplyWithoutChanges).toBe(false);
    expect(impact.edgeIssues).toMatchObject([
      { edgeId: 'cast-edge', reason: expect.stringContaining('отдельный кадр') },
    ]);
    expect(impact.settingIssues.map((issue) => issue.field)).toEqual([
      'durationSeconds',
      'generateAudio',
    ]);
    expect(impact.settingsPatch).toEqual({ durationSeconds: 8, generateAudio: false });
  });
});

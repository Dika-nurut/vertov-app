import { describe, expect, it } from 'vitest';
import { seedModels } from '../../db/seed/models';
import boardDocumentFixture from './__fixtures__/board-document.v1.json';
import {
  BOARD_LIMITS,
  BOARD_NODE_REGISTRY,
  BOARD_NODE_VERSION,
  BOARD_SCHEMA_VERSION,
  boardGenerateDataSchema,
  boardGenerateCycleEdgeIndexes,
  boardGenerateGraphHasCycle,
  boardInputPort,
  boardModelMetadataIssues,
  boardReferenceInputCapacity,
  boardNodeDefaultData,
  boardOutputPort,
  compileBoardGenerationQuote,
  compileBoardGenerationRequest,
  isBoardModelCatalogComplete,
  migrateBoardDocument,
  parseBoardDocument,
  resolveBoardImageSettings,
  resolveBoardModelContract,
  resolveBoardVideoSettings,
  safeParseBoardDocument,
  validateBoardCompiledGenerationRequest,
  validateBoardConnectionShape,
  validateBoardConnection,
  validateBoardConnections,
  type BoardNode,
  type BoardNodeType,
  type BoardModelLike,
} from './board-contract';

const node = (
  id: string,
  type: BoardNodeType,
  data: Record<string, unknown> = boardNodeDefaultData(type),
): BoardNode =>
  ({
    id,
    type,
    version: BOARD_NODE_VERSION,
    position: { x: 0, y: 0 },
    data,
  }) as BoardNode;

describe('Board document v1 runtime contract', () => {
  it('accepts bounded video batch ids while keeping the field optional for old data', () => {
    expect(
      boardGenerateDataSchema.parse({
        mode: 'video',
        prompt: 'batch',
        count: 3,
        status: 'running',
        jobId: 'job-1',
        jobIds: ['job-1', 'job-2', 'job-3'],
      }),
    ).toMatchObject({ jobId: 'job-1', jobIds: ['job-1', 'job-2', 'job-3'] });
    expect(
      boardGenerateDataSchema.parse({ mode: 'video', prompt: 'legacy', status: 'idle' }),
    ).not.toHaveProperty('jobIds');
    expect(
      boardGenerateDataSchema.safeParse({
        mode: 'video',
        prompt: 'too many',
        status: 'running',
        jobIds: Array.from({ length: BOARD_LIMITS.takes + 1 }, (_, index) => `job-${index}`),
      }).success,
    ).toBe(false);
  });

  it('keeps the cast reference origin optional and absent when unset', () => {
    expect(
      boardGenerateDataSchema.parse({ mode: 'image', prompt: '', status: 'idle' }),
    ).not.toHaveProperty('originCastNodeId');
    expect(
      boardGenerateDataSchema.parse({
        mode: 'image',
        prompt: '',
        status: 'idle',
        originCastNodeId: 'cast-1',
      }),
    ).toHaveProperty('originCastNodeId', 'cast-1');
  });

  it('persists stable media and generated-result ids while loading legacy URL-only nodes', () => {
    const identified = parseBoardDocument({
      nodes: [
        node('identified', 'media', {
          url: 'https://assets.seed.local/snapshot.png',
          mediaKind: 'image',
          assetId: 'gallery-stable-id',
        }),
        node('generated', 'generate', {
          mode: 'video',
          prompt: 'project result',
          count: 1,
          status: 'done',
          resultUrl: 'https://assets.seed.local/result.mp4',
          resultKind: 'video',
          assetId: 'generated-stable-id',
        }),
      ],
    });
    expect(identified.nodes[0]?.data).toMatchObject({
      url: 'https://assets.seed.local/snapshot.png',
      assetId: 'gallery-stable-id',
    });
    expect(identified.nodes[1]?.data).toMatchObject({
      resultUrl: 'https://assets.seed.local/result.mp4',
      assetId: 'generated-stable-id',
    });

    const legacy = parseBoardDocument({
      nodes: [
        node('legacy', 'media', {
          url: 'https://external.example/legacy.png',
          mediaKind: 'image',
        }),
      ],
    });
    expect(legacy.nodes[0]?.data).toEqual({
      url: 'https://external.example/legacy.png',
      mediaKind: 'image',
    });
  });

  it('keeps versioned current, legacy, malformed, and limit fixtures executable', () => {
    expect(parseBoardDocument(boardDocumentFixture.current)).toMatchObject({ schemaVersion: 1 });
    expect(parseBoardDocument(boardDocumentFixture.legacy)).toMatchObject({
      schemaVersion: 1,
      edges: [{ sourceHandle: 'out', targetHandle: 'images[0]' }],
    });
    for (const fixture of boardDocumentFixture.malformed) {
      expect(safeParseBoardDocument(fixture.document).success, fixture.name).toBe(false);
    }
    expect(BOARD_LIMITS).toMatchObject(boardDocumentFixture.limits);
  });

  it('accepts bounded text and frame organizers and validates their parent graph', () => {
    const valid = parseBoardDocument({
      nodes: [
        {
          id: 'frame',
          type: 'frame',
          position: { x: 0, y: 0 },
          width: 480,
          height: 240,
          data: { title: 'Секция', tint: 'violet' },
        },
        {
          id: 'text',
          type: 'text',
          position: { x: 12, y: 20 },
          parentId: 'frame',
          extent: 'parent',
          data: { text: 'Аннотация', size: 'l' },
        },
      ],
      edges: [],
    });
    expect(valid.nodes[1]?.data).toEqual({ text: 'Аннотация', size: 'l' });
    expect(valid.nodes[0]?.data).toEqual({ title: 'Секция', tint: 'violet' });
    expect(
      safeParseBoardDocument({
        nodes: [
          { id: 'text', type: 'text', position: { x: 0, y: 0 }, data: { text: 'x'.repeat(2001) } },
        ],
        edges: [],
      }).success,
    ).toBe(false);

    for (const [field, value] of [
      ['width', BOARD_LIMITS.frameWidthMin - 1],
      ['height', BOARD_LIMITS.frameHeightMin - 1],
      ['width', BOARD_LIMITS.frameDimensionMax + 1],
      ['height', BOARD_LIMITS.frameDimensionMax + 1],
    ] as const) {
      expect(
        safeParseBoardDocument({
          nodes: [
            {
              id: 'frame',
              type: 'frame',
              position: { x: 0, y: 0 },
              [field]: value,
              data: {},
            },
          ],
          edges: [],
        }).success,
        `${field}=${value}`,
      ).toBe(false);
    }

    for (const [parentId, childType, expected] of [
      ['missing', 'text', 'parent node'],
      ['text', 'note', 'parentId must refer'],
      ['outer', 'frame', 'frames cannot be nested'],
    ] as const) {
      const result = safeParseBoardDocument({
        nodes: [
          ...(parentId === 'outer'
            ? [{ id: 'outer', type: 'frame', position: { x: 0, y: 0 }, data: {} }]
            : []),
          ...(parentId === 'text'
            ? [{ id: 'text', type: 'text', position: { x: 0, y: 0 }, data: {} }]
            : []),
          {
            id: 'child',
            type: childType,
            position: { x: 0, y: 0 },
            parentId,
            data: {},
          },
        ],
        edges: [],
      });
      expect(result.success).toBe(false);
      if (!result.success)
        expect(result.error.issues.map((issue) => issue.message).join('|')).toContain(expected);
    }
    expect(
      safeParseBoardDocument({
        nodes: [
          { id: 'frame', type: 'frame', position: { x: 0, y: 0 }, data: {} },
          { id: 'child', type: 'text', position: { x: 0, y: 0 }, parentId: 'frame', data: {} },
        ],
        edges: [],
      }).success,
    ).toBe(false);
    expect(
      safeParseBoardDocument({
        nodes: [
          { id: 'child', type: 'text', position: { x: 0, y: 0 }, extent: 'parent', data: {} },
        ],
        edges: [],
      }).success,
    ).toBe(false);
  });

  it('round-trips unknown node types without allowing them to invent edges', () => {
    const parsed = safeParseBoardDocument({
      nodes: [
        { id: 'future', type: 'future-widget', position: { x: 0, y: 0 }, data: { value: 1 } },
        { id: 'note', type: 'note', position: { x: 20, y: 0 }, data: {} },
      ],
      edges: [],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.nodes[0]?.type).toBe('future-widget');
  });

  it('parses a current document and fills safe data defaults', () => {
    const parsed = parseBoardDocument({
      schemaVersion: BOARD_SCHEMA_VERSION,
      nodes: [
        { id: 'p1', version: 1, type: 'prompt', position: { x: 1, y: 2 }, data: {} },
        {
          id: 'g1',
          version: 1,
          type: 'generate',
          position: { x: 3, y: 4 },
          data: { mode: 'image' },
        },
      ],
      edges: [
        {
          id: 'e1',
          source: 'p1',
          sourceHandle: 'text',
          target: 'g1',
          targetHandle: 'prompt',
        },
      ],
    });

    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.nodes[0]?.data).toEqual({ text: '' });
    expect(parsed.nodes[1]?.data).toMatchObject({
      mode: 'image',
      prompt: '',
      count: 1,
      status: 'idle',
    });
    expect(parsed.tray).toEqual([]);
  });

  it('normalizes current documents with frames before their children', () => {
    const parsed = safeParseBoardDocument({
      schemaVersion: BOARD_SCHEMA_VERSION,
      nodes: [
        {
          id: 'child',
          version: 1,
          type: 'text',
          position: { x: 20, y: 20 },
          parentId: 'frame',
          extent: 'parent',
          data: {},
        },
        {
          id: 'frame',
          version: 1,
          type: 'frame',
          position: { x: 0, y: 0 },
          width: 320,
          height: 220,
          data: {},
        },
      ],
      edges: [],
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.nodes.map((node) => node.id)).toEqual(['frame', 'child']);
  });

  it('migrates the legacy unversioned shape and sequential legacy image handles', () => {
    const legacy = {
      nodes: [
        {
          id: 'm1',
          type: 'media',
          position: { x: 0, y: 0 },
          data: { url: '', mediaKind: 'image' },
        },
        {
          id: 'm2',
          type: 'media',
          position: { x: 1, y: 0 },
          data: { url: '', mediaKind: 'image' },
        },
        { id: 'g1', type: 'generate', position: { x: 2, y: 0 }, data: { mode: 'video' } },
      ],
      edges: [
        { id: 'e1', source: 'm1', target: 'g1', targetHandle: 'images' },
        { id: 'e2', source: 'm2', target: 'g1', targetHandle: 'images' },
      ],
      viewport: { x: 0, y: 0, zoom: 1 },
    };

    const migrated = parseBoardDocument(legacy);
    expect(migrated.schemaVersion).toBe(1);
    expect(migrated.nodes.every((entry) => entry.version === 1)).toBe(true);
    expect(migrated.edges.map((edge) => edge.targetHandle)).toEqual(['images[0]', 'images[1]']);
    expect(migrated.edges.map((edge) => edge.sourceHandle)).toEqual(['out', 'out']);
    expect(legacy).not.toHaveProperty('schemaVersion');
  });

  it('treats an empty legacy state as an empty current document', () => {
    expect(parseBoardDocument({})).toEqual({
      schemaVersion: 1,
      nodes: [],
      edges: [],
      tray: [],
    });
  });

  it('fails closed on a future schema version', () => {
    const result = safeParseBoardDocument({ schemaVersion: 2, nodes: [], edges: [] });
    expect(result.success).toBe(false);
  });

  it('accepts only non-negative safe-integer document revisions', () => {
    expect(
      safeParseBoardDocument({ schemaVersion: 1, nodes: [], edges: [], __rev: 0 }).success,
    ).toBe(true);
    for (const __rev of [-1, 0.5, Number.MAX_SAFE_INTEGER]) {
      expect(
        safeParseBoardDocument({ schemaVersion: 1, nodes: [], edges: [], __rev }).success,
        String(__rev),
      ).toBe(false);
    }
  });

  it('rejects duplicate ids, dangling edges, and dangling tray entries', () => {
    const result = safeParseBoardDocument({
      schemaVersion: 1,
      nodes: [
        { id: 'same', version: 1, type: 'note', position: { x: 0, y: 0 }, data: {} },
        { id: 'same', version: 1, type: 'note', position: { x: 1, y: 1 }, data: {} },
      ],
      edges: [{ id: 'e1', source: 'missing', target: 'also-missing' }],
      tray: ['gone'],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.message).join(' | ');
      expect(messages).toContain('duplicate node id');
      expect(messages).toContain('edge source');
      expect(messages).toContain('edge target');
      expect(messages).toContain('tray node');
    }
  });

  it('rejects semantic type confusion, duplicate inputs, and generate cycles', () => {
    const baseNodes = [
      {
        id: 'p1',
        version: 1,
        type: 'prompt',
        position: { x: 0, y: 0 },
        data: { text: 'one' },
      },
      {
        id: 'p2',
        version: 1,
        type: 'prompt',
        position: { x: 0, y: 1 },
        data: { text: 'two' },
      },
      {
        id: 'image',
        version: 1,
        type: 'generate',
        position: { x: 1, y: 0 },
        data: { mode: 'image' },
      },
      {
        id: 'video',
        version: 1,
        type: 'generate',
        position: { x: 2, y: 0 },
        data: { mode: 'video' },
      },
    ];

    const duplicateAndWrongType = safeParseBoardDocument({
      schemaVersion: 1,
      nodes: baseNodes,
      edges: [
        {
          id: 'e1',
          source: 'p1',
          sourceHandle: 'text',
          target: 'image',
          targetHandle: 'prompt',
        },
        {
          id: 'e2',
          source: 'p2',
          sourceHandle: 'text',
          target: 'image',
          targetHandle: 'prompt',
        },
        {
          id: 'e3',
          source: 'video',
          sourceHandle: 'out',
          target: 'image',
          targetHandle: 'images[0]',
        },
      ],
    });
    expect(duplicateAndWrongType.success).toBe(false);
    if (!duplicateAndWrongType.success) {
      const messages = duplicateAndWrongType.error.issues.map((issue) => issue.message).join(' | ');
      expect(messages).toContain('already has a connection');
      expect(messages).toContain('несовместим');
    }

    const cycle = safeParseBoardDocument({
      schemaVersion: 1,
      nodes: baseNodes
        .filter((entry) => entry.id === 'image')
        .concat([
          {
            id: 'image-2',
            version: 1,
            type: 'generate',
            position: { x: 2, y: 0 },
            data: { mode: 'image' },
          },
        ]),
      edges: [
        {
          id: 'cycle-1',
          source: 'image',
          sourceHandle: 'out',
          target: 'image-2',
          targetHandle: 'images[0]',
        },
        {
          id: 'cycle-2',
          source: 'image-2',
          sourceHandle: 'out',
          target: 'image',
          targetHandle: 'images[0]',
        },
      ],
    });
    expect(cycle.success).toBe(false);
    if (!cycle.success) {
      expect(cycle.error.issues.map((issue) => issue.message)).toContain(
        'generate dependency graph contains a cycle',
      );
    }
  });

  it('enforces document and node-data limits', () => {
    const tooManyNodes = Array.from({ length: BOARD_LIMITS.nodes + 1 }, (_, index) => ({
      id: `n${index}`,
      version: 1,
      type: 'note',
      position: { x: index, y: 0 },
      data: { text: '' },
    }));
    expect(
      safeParseBoardDocument({ schemaVersion: 1, nodes: tooManyNodes, edges: [] }).success,
    ).toBe(false);

    expect(
      safeParseBoardDocument({
        schemaVersion: 1,
        nodes: [
          {
            id: 'cast',
            version: 1,
            type: 'cast',
            position: { x: 0, y: 0 },
            data: {
              castKind: 'character',
              name: '',
              imageUrls: Array.from({ length: BOARD_LIMITS.castImages + 1 }, () => 'x'),
            },
          },
        ],
        edges: [],
      }).success,
    ).toBe(false);

    expect(
      safeParseBoardDocument({
        schemaVersion: 1,
        nodes: [
          {
            id: 'prompt',
            version: 1,
            type: 'prompt',
            position: { x: 0, y: 0 },
            data: { text: 'x'.repeat(BOARD_LIMITS.text + 1) },
          },
        ],
        edges: [],
      }).success,
    ).toBe(false);
  });

  it('rejects a document with more than BOARD_LIMITS.edges edges', () => {
    const tooManyEdges = Array.from({ length: BOARD_LIMITS.edges + 1 }, (_, index) => ({
      id: `e${index}`,
      source: 'a',
      target: 'b',
    }));
    expect(
      safeParseBoardDocument({
        schemaVersion: 1,
        nodes: [
          { id: 'a', type: 'future-widget', position: { x: 0, y: 0 }, data: { value: 1 } },
          { id: 'b', type: 'future-widget', position: { x: 1, y: 0 }, data: { value: 2 } },
        ],
        edges: tooManyEdges,
      }).success,
    ).toBe(false);
  });

  it('keeps forty full object-only scenes under one fifth of the state budget', () => {
    const document = parseBoardDocument({
      nodes: Array.from({ length: 40 }, (_, index) =>
        node(`scene-${index}`, 'scene', {
          title: `Сцена ${index}`,
          synopsis: '',
          sourceText: '',
          objects: Array.from({ length: 12 }, (_, objectIndex) => ({
            kind: objectIndex % 3 === 0 ? 'person' : objectIndex % 3 === 1 ? 'place' : 'thing',
            name: 'я'.repeat(80),
          })),
        }),
      ),
      edges: [],
    });
    const bytes = new TextEncoder().encode(JSON.stringify(document)).byteLength;
    expect(bytes).toBeLessThan(BOARD_LIMITS.stateBytes / 5);
  });
});

describe('central Board node registry', () => {
  it('owns every current discriminant, version, schema, operation, and defaults', () => {
    expect(Object.keys(BOARD_NODE_REGISTRY).sort()).toEqual(
      ['aiprompt', 'cast', 'frame', 'generate', 'media', 'note', 'prompt', 'scene', 'text'].sort(),
    );
    for (const [type, spec] of Object.entries(BOARD_NODE_REGISTRY)) {
      expect(spec.type).toBe(type);
      expect(spec.version).toBe(1);
      expect(spec.operation).not.toBe('');
      expect(spec.dataSchema.safeParse(spec.defaultData).success, type).toBe(true);
      if (type === 'generate') {
        expect(spec.settingsSchema).not.toBeNull();
        expect(spec.modelPredicate).toBeTypeOf('function');
        expect(spec.requestCompiler).toBe(compileBoardGenerationRequest);
      } else {
        expect(spec.settingsSchema).toBeNull();
        expect(spec.modelPredicate).toBeNull();
        expect(spec.requestCompiler).toBeNull();
      }
    }
  });

  it('distinguishes semantic outputs that used to collapse to image/video', () => {
    expect(boardOutputPort(node('p', 'prompt'), 'text')?.payloads).toEqual(['text.prompt']);
    expect(boardOutputPort(node('ai', 'aiprompt'), 'text')?.payloads).toEqual(['text.prompt']);
    expect(boardOutputPort(node('n', 'note'), 'out')).toBeNull();
    expect(boardOutputPort(node('s', 'scene'), 'out')).toBeNull();
    expect(boardOutputPort(node('s', 'scene'), 'context')?.payloads).toEqual(['scene.context']);
    expect(boardInputPort(node('ai', 'aiprompt'), 'scene')?.payloads).toEqual(['scene.context']);
    expect(boardInputPort(node('cc', 'cast'), 'scene')?.payloads).toEqual(['scene.context']);
    expect(
      boardOutputPort(node('mi', 'media', { url: '', mediaKind: 'image' }), 'out')?.payloads,
    ).toEqual(['image.reference']);
    expect(
      boardOutputPort(node('mv', 'media', { url: '', mediaKind: 'video' }), 'out')?.payloads,
    ).toEqual(['video.motionReference']);
    expect(
      boardOutputPort(node('cc', 'cast', { castKind: 'character', name: '', imageUrls: [] }), 'out')
        ?.payloads,
    ).toEqual(['cast.identityPack']);
    expect(
      boardOutputPort(node('cl', 'cast', { castKind: 'location', name: '', imageUrls: [] }), 'out')
        ?.payloads,
    ).toEqual(['cast.locationPack']);
    expect(
      boardOutputPort(node('gi', 'generate', { mode: 'image', prompt: '' }), 'out')?.payloads,
    ).toEqual(['image.generated']);
    expect(
      boardOutputPort(node('gv', 'generate', { mode: 'video', prompt: '' }), 'out')?.payloads,
    ).toEqual(['video.generated']);
  });

  it('keeps Recraft Vector as an explicit SVG output contract', () => {
    const model = {
      id: 'recraft-v4-vector',
      kind: 'image' as const,
      capabilities: {
        reference: true,
        maxRefs: 1,
        vector: true,
        resolutions: [],
        aspect_ratios: [],
      },
    };
    expect(resolveBoardModelContract(model)).toMatchObject({
      output: 'image.generated',
      outputFormat: 'vector',
      imageInput: { role: 'reference', max: 1 },
    });
    expect(
      compileBoardGenerationRequest({
        data: { mode: 'image', modelId: model.id, prompt: '', count: 1, status: 'idle' },
        model,
        prompt: 'A clean vector emblem',
        imageUrls: ['https://assets.example/reference.png'],
      }),
    ).toMatchObject({ output: { payload: 'image.generated', format: 'vector' } });
  });

  it('parses product cast nodes as identity packs without changing legacy documents', () => {
    const product = parseBoardDocument({
      schemaVersion: BOARD_SCHEMA_VERSION,
      nodes: [
        node('product', 'cast', {
          castKind: 'product',
          name: 'Бутылка',
          imageUrls: ['https://assets.seed.local/bottle.png'],
        }),
      ],
      edges: [],
    });
    expect(product.nodes[0]?.data).toMatchObject({ castKind: 'product', name: 'Бутылка' });
    expect(boardOutputPort(product.nodes[0]!, 'out')?.payloads).toEqual(['cast.identityPack']);

    const legacy = parseBoardDocument({
      schemaVersion: BOARD_SCHEMA_VERSION,
      nodes: [
        node('legacy-character', 'cast', {
          castKind: 'character',
          name: 'Алиса',
          imageUrls: ['https://assets.seed.local/alice.png'],
        }),
      ],
      edges: [],
    });
    expect(legacy.nodes[0]?.data).toEqual({
      castKind: 'character',
      name: 'Алиса',
      imageUrls: ['https://assets.seed.local/alice.png'],
    });
  });

  it('accepts optional continuity metadata without materializing it on legacy Scene or Cast nodes', () => {
    const enriched = parseBoardDocument({
      schemaVersion: BOARD_SCHEMA_VERSION,
      nodes: [
        node('scene', 'scene', {
          title: 'ИНТ. КАФЕ — ВЕЧЕР',
          synopsis: '',
          sourceText: '',
          sourceHash: 'source-hash',
          objectsSourceHash: 'objects-hash',
          sourceStatus: 'current',
          collapsed: true,
          objects: [
            {
              kind: 'thing',
              name: 'Флакон',
              description: 'Маленький синий флакон.',
              castNodeId: 'cast',
              absentFromLatestExtraction: true,
            },
          ],
        }),
        node('cast', 'cast', {
          castKind: 'product',
          name: 'Флакон',
          description: 'Маленький синий флакон.',
          imageUrls: [],
        }),
      ],
      edges: [],
    });
    expect(enriched.nodes[0]?.data).toMatchObject({
      objectsSourceHash: 'objects-hash',
      objects: [
        {
          description: 'Маленький синий флакон.',
          castNodeId: 'cast',
          absentFromLatestExtraction: true,
        },
      ],
    });
    expect(enriched.nodes[1]?.data).toMatchObject({ description: 'Маленький синий флакон.' });

    const legacy = parseBoardDocument({
      schemaVersion: BOARD_SCHEMA_VERSION,
      nodes: [
        node('scene', 'scene', {
          title: 'Сцена',
          synopsis: '',
          sourceText: '',
          sourceStatus: 'current',
          collapsed: true,
          objects: [{ kind: 'person', name: 'Анна' }],
        }),
        node('cast', 'cast', { castKind: 'character', name: 'Анна', imageUrls: [] }),
      ],
      edges: [],
    });
    expect(legacy.nodes[0]?.data).not.toHaveProperty('objectsSourceHash');
    expect(
      (legacy.nodes[0]?.data as { objects?: Record<string, unknown>[] }).objects?.[0],
    ).not.toHaveProperty('description');
    expect(legacy.nodes[1]?.data).not.toHaveProperty('description');
  });

  it('recognizes dynamic legacy/current reference handles from one registry port', () => {
    const generate = node('g', 'generate', { mode: 'video', prompt: '' });
    expect(boardInputPort(generate, 'images')?.key).toBe('references');
    expect(boardInputPort(generate, 'images[17]')?.key).toBe('references');
    expect(boardInputPort(generate, 'referenceImages[0]')?.key).toBe('reference-images');
    expect(boardInputPort(generate, 'wat')?.key).toBeUndefined();
  });

  it('rejects broad type confusion before model-specific validation', () => {
    const image = node('image', 'generate', { mode: 'image', prompt: '' });
    const video = node('video', 'generate', { mode: 'video', prompt: '' });
    const prompt = node('prompt', 'prompt');
    const imageMedia = node('im', 'media', { url: 'x', mediaKind: 'image' });
    const videoMedia = node('vm', 'media', { url: 'x', mediaKind: 'video' });
    const scene = node('scene', 'scene');
    const aiPrompt = node('ai', 'aiprompt');

    expect(
      validateBoardConnectionShape({
        source: prompt,
        sourceHandle: 'text',
        target: video,
        targetHandle: 'prompt',
      }),
    ).toEqual({ ok: true, payload: 'text.prompt' });
    expect(
      validateBoardConnectionShape({
        source: imageMedia,
        sourceHandle: 'out',
        target: video,
        targetHandle: 'images[0]',
      }),
    ).toEqual({ ok: true, payload: 'image.reference' });
    expect(
      validateBoardConnectionShape({
        source: videoMedia,
        sourceHandle: 'out',
        target: image,
        targetHandle: 'images[0]',
      }).ok,
    ).toBe(false);
    expect(
      validateBoardConnectionShape({
        source: scene,
        sourceHandle: 'context',
        target: aiPrompt,
        targetHandle: 'scene',
      }),
    ).toEqual({ ok: true, payload: 'scene.context' });
    expect(
      validateBoardConnectionShape({
        source: video,
        sourceHandle: 'out',
        target: image,
        targetHandle: 'images[0]',
      }).ok,
    ).toBe(false);
    expect(
      validateBoardConnectionShape({
        source: video,
        sourceHandle: 'out',
        target: video,
        targetHandle: 'images[0]',
      }).ok,
    ).toBe(false);
  });

  it('creates validated defaults and rejects invalid overrides', () => {
    expect(boardNodeDefaultData('generate', { mode: 'image' })).toMatchObject({
      mode: 'image',
      prompt: '',
      count: 1,
      status: 'idle',
    });
    expect(() => boardNodeDefaultData('cast', { imageUrls: ['1', '2', '3', '4', '5'] })).toThrow();
    expect(
      boardNodeDefaultData('scene', {
        title: 'ИНТ. КУХНЯ — НОЧЬ',
        sourceScriptId: 'script-1',
        sourceScriptRevision: 3,
        sourceSceneId: 'scene-1',
        sourceSceneRevision: 3,
        sourceOrdinal: 1,
      }),
    ).toMatchObject({
      title: 'ИНТ. КУХНЯ — НОЧЬ',
      sourceStatus: 'current',
      collapsed: true,
    });
  });
});

describe('legacy migration is pure', () => {
  it('leaves malformed primitives and future versions for the parser to reject', () => {
    expect(migrateBoardDocument(null)).toBeNull();
    expect(migrateBoardDocument('bad')).toBe('bad');
    const future = { schemaVersion: 99, nodes: [] };
    expect(migrateBoardDocument(future)).toBe(future);
  });
});

describe('generate dependency cycle diagnostics', () => {
  it('ignores scene context edges entirely', () => {
    expect(
      boardGenerateGraphHasCycle(
        [
          { id: 'scene', type: 'scene' },
          { id: 'ai', type: 'aiprompt' },
        ],
        [{ source: 'scene', target: 'ai', targetHandle: 'scene' }],
      ),
    ).toBe(false);
  });
  it('keeps the cycle predicate hard-coded to generate endpoints', () => {
    expect(
      boardGenerateGraphHasCycle(
        [
          { id: 'g', type: 'generate' },
          { id: 'cast', type: 'cast' },
          { id: 'scene', type: 'scene' },
        ],
        [
          { source: 'scene', target: 'cast', targetHandle: 'scene' },
          { source: 'cast', target: 'g', targetHandle: 'images[0]' },
          { source: 'g', target: 'cast', targetHandle: 'scene' },
        ],
      ),
    ).toBe(false);
  });
  it('returns only edges inside a cycle, not downstream dependencies', () => {
    const nodes = [
      { id: 'a', type: 'generate' },
      { id: 'b', type: 'generate' },
      { id: 'c', type: 'generate' },
    ];
    const edges = [
      { source: 'a', target: 'b', targetHandle: 'images[0]' },
      { source: 'b', target: 'a', targetHandle: 'images[0]' },
      { source: 'b', target: 'c', targetHandle: 'images[0]' },
      { source: 'c', target: 'c', targetHandle: 'prompt' },
    ];
    expect(boardGenerateCycleEdgeIndexes(nodes, edges)).toEqual([0, 1]);
  });

  it('identifies a generate self-reference', () => {
    expect(
      boardGenerateCycleEdgeIndexes(
        [{ id: 'a', type: 'generate' }],
        [{ source: 'a', target: 'a', targetHandle: 'images[0]' }],
      ),
    ).toEqual([0]);
  });
});

describe('selected-model capability predicate', () => {
  it('normalizes every source-active image/video catalog row', () => {
    const active = seedModels.filter(
      (model) => model.isActive && ['image', 'image-edit', 'video'].includes(model.kind),
    );
    // 22: happyhorse-1-0 and Seedream 4.5 are inactive by owner ruling.
    expect(active).toHaveLength(22);
    for (const candidate of active) {
      const contract = resolveBoardModelContract(candidate as BoardModelLike);
      expect(contract, candidate.id).not.toBeNull();
      expect(contract?.id, candidate.id).toBe(candidate.id);
      expect(contract?.mode, candidate.id).toBe(candidate.kind === 'video' ? 'video' : 'image');
      expect(contract?.imageInput.max, candidate.id).toBeGreaterThanOrEqual(0);
      expect(contract?.videoReferenceMax, candidate.id).toBeGreaterThanOrEqual(0);
      expect(contract?.audioReferenceMax, candidate.id).toBeGreaterThanOrEqual(0);
      expect(contract?.output, candidate.id).toBe(
        candidate.kind === 'video' ? 'video.generated' : 'image.generated',
      );
    }
  });

  it('normalizes image reference caps and exposes legacy inference', () => {
    expect(
      resolveBoardModelContract({
        id: 'flux',
        kind: 'image',
        capabilities: { reference: true, edit: true, multi_image: true, maxRefs: 8 },
      }),
    ).toMatchObject({
      mode: 'image',
      imageInput: { role: 'reference', max: 8 },
      output: 'image.generated',
      inferred: [],
    });
    expect(
      resolveBoardModelContract({
        id: 'recraft',
        kind: 'image',
        capabilities: { reference: true },
      }),
    ).toMatchObject({
      imageInput: { role: 'reference', max: 1 },
      inferred: ['imageInput.max'],
    });
    expect(
      resolveBoardModelContract({
        id: 'seedream',
        kind: 'image',
        capabilities: { reference: true, multi_image: true },
      }),
    ).toMatchObject({ imageInput: { max: 14 } });
    expect(resolveBoardModelContract({ id: 'gpt-image', kind: 'image' })).toMatchObject({
      imageInput: { role: 'none', max: 0 },
    });
  });

  it('keeps frame slots and reference images separate when a model advertises both', () => {
    const mixed = resolveBoardModelContract({
      id: 'mixed-video',
      kind: 'video',
      capabilities: { reference: true, frames: ['first'], audio: true },
    });
    expect(mixed).toMatchObject({
      imageInput: { role: 'frame', max: 1, frameRoles: ['first'] },
      referenceImageMax: 9,
      videoReferenceMax: 3,
      audioReferenceMax: 3,
      generateAudio: true,
    });
    expect(
      validateBoardConnection({
        source: node('reference', 'media', { mediaKind: 'image', url: 'reference.png' }),
        sourceHandle: 'out',
        target: node('mixed', 'generate', {
          mode: 'video',
          modelId: 'mixed-video',
          prompt: '',
          count: 1,
          status: 'idle',
        }),
        targetHandle: 'referenceImages[0]',
        targetModel: {
          id: 'mixed-video',
          kind: 'video',
          capabilities: { reference: true, frames: ['first'], audio: true },
        },
      }),
    ).toMatchObject({ ok: true, payload: 'image.reference' });
    expect(
      compileBoardGenerationRequest({
        data: { mode: 'video', modelId: 'mixed-video', prompt: '', count: 1, status: 'idle' },
        model: {
          id: 'mixed-video',
          kind: 'video',
          capabilities: { reference: true, frames: ['first'], audio: true },
        },
        prompt: 'mixed conditioning',
        frameImages: [{ role: 'first', url: 'first.png' }],
        imageUrls: ['reference.png'],
      }),
    ).toMatchObject({
      ok: true,
      request: {
        params: {
          frameImages: [{ role: 'first', url: 'first.png' }],
          imageUrls: ['reference.png'],
        },
      },
    });

    const reference = resolveBoardModelContract({
      id: 'seedance-reference',
      kind: 'video',
      capabilities: { reference: true, audio: true },
    });
    expect(reference).toMatchObject({
      imageInput: { role: 'reference', max: 9, frameRoles: [] },
      videoReferenceMax: 3,
      audioReferenceMax: 3,
    });
    expect(boardReferenceInputCapacity(reference)).toBe(9);

    expect(
      resolveBoardModelContract({
        id: 'sora',
        kind: 'video',
        capabilities: { frames: [], audio: true },
      }),
    ).toMatchObject({ imageInput: { role: 'none', max: 0 } });
  });

  it('treats Gemini Omni as a pure reference model when it declares no frame roles', () => {
    expect(
      resolveBoardModelContract({
        id: 'gemini-omni-flash',
        kind: 'video',
        capabilities: {
          reference: true,
          audio: true,
          audioControl: false,
          maxVideoRefs: 0,
          maxAudioRefs: 0,
        },
      }),
    ).toMatchObject({
      imageInput: { role: 'reference', max: 9, frameRoles: [] },
      referenceImageMax: 0,
      videoReferenceMax: 0,
      audioReferenceMax: 0,
      generateAudio: false,
    });
  });

  it('keeps r2v still-image references while removing the video attach port', () => {
    for (const id of ['seedance-2-0-reference-to-video', 'seedance-2-0-fast-reference-to-video']) {
      const contract = resolveBoardModelContract({
        id,
        kind: 'video',
        capabilities: { reference: true, maxRefs: 9, maxVideoRefs: 0, maxAudioRefs: 3 },
      });
      expect(contract).toMatchObject({
        imageInput: { role: 'reference', max: 9, frameRoles: [] },
        videoReferenceMax: 0,
        audioReferenceMax: 3,
      });
      expect(boardReferenceInputCapacity(contract)).toBe(9);
    }
  });

  it('rejects model-incompatible payloads with a concrete reason', () => {
    const target = node('target', 'generate', { mode: 'video', prompt: '' });
    const image = node('image', 'media', { url: 'image.png', mediaKind: 'image' });
    const motion = node('motion', 'media', { url: 'motion.mp4', mediaKind: 'video' });
    const sora = { id: 'sora', kind: 'video' as const, capabilities: { frames: [] } };
    const reference = {
      id: 'seedance-reference',
      kind: 'video' as const,
      capabilities: { reference: true },
    };

    const noImage = validateBoardConnection({
      source: image,
      sourceHandle: 'out',
      target,
      targetHandle: 'images[0]',
      targetModel: sora,
    });
    expect(noImage.ok).toBe(false);
    if (!noImage.ok) expect(noImage.reason).toContain('не принимает изображения');

    const noMotion = validateBoardConnection({
      source: motion,
      sourceHandle: 'out',
      target,
      targetHandle: 'images[0]',
      targetModel: {
        id: 'veo',
        kind: 'video',
        capabilities: { frames: ['first', 'last'] },
      },
    });
    expect(noMotion.ok).toBe(false);
    if (!noMotion.ok) expect(noMotion.reason).toContain('не принимает видео-референсы');

    expect(
      validateBoardConnection({
        source: motion,
        sourceHandle: 'out',
        target,
        targetHandle: 'images[0]',
        targetModel: reference,
      }),
    ).toMatchObject({ ok: true, payload: 'video.motionReference' });
  });

  it('accounts for cast expansion and hidden location motion semantics', () => {
    const imageTarget = node('target', 'generate', { mode: 'image', prompt: '' });
    const cast = node('cast', 'cast', {
      castKind: 'character',
      name: 'A',
      imageUrls: ['1', '2', '3', '4'],
    });
    const tooSmall = validateBoardConnection({
      source: cast,
      sourceHandle: 'out',
      target: imageTarget,
      targetHandle: 'images[0]',
      targetModel: {
        id: 'nano',
        kind: 'image',
        capabilities: { reference: true, maxRefs: 3 },
      },
    });
    expect(tooSmall.ok).toBe(false);
    if (!tooSmall.ok) expect(tooSmall.reason).toContain('лимит');

    const location = node('location', 'cast', {
      castKind: 'location',
      name: 'L',
      imageUrls: ['1'],
      videoUrl: 'motion.mp4',
    });
    const hiddenMotion = validateBoardConnection({
      source: location,
      sourceHandle: 'out',
      target: imageTarget,
      targetHandle: 'images[0]',
      targetModel: {
        id: 'seedream',
        kind: 'image',
        capabilities: { reference: true, multi_image: true },
      },
    });
    expect(hiddenMotion.ok).toBe(false);
    if (!hiddenMotion.ok) expect(hiddenMotion.reason).toContain('видео движения');
  });
});

describe('registry-owned generation compiler', () => {
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

  it('compiles valid model settings and preserves semantic output metadata', () => {
    const result = compileBoardGenerationRequest({
      data: {
        mode: 'video',
        prompt: '',
        durationSeconds: 6,
        videoResolution: '720p',
        videoAspect: '16:9',
        generateAudio: false,
        count: 1,
        status: 'idle',
        shot: { size: 'cu', moves: ['push'] },
      },
      model: veo,
      prompt: 'Close-up portrait',
      imageUrls: ['first.png', 'last.png'],
    });

    expect(result).toMatchObject({
      ok: true,
      request: {
        modelId: 'veo',
        prompt: 'Close-up portrait',
        params: {
          duration_seconds: 6,
          resolution: '720p',
          aspect_ratio: '16:9',
          return_last_frame: true,
          frameImages: [
            { role: 'first', url: 'first.png' },
            { role: 'last', url: 'last.png' },
          ],
          shotGrammar: { size: 'cu', moves: ['push'] },
        },
      },
      output: { payload: 'video.generated', format: 'video' },
    });
    if (result.ok) expect(result.request.params).not.toHaveProperty('generate_audio');
  });

  it('never forwards a legacy adaptive aspect to a vendor request', () => {
    const legacyModel = {
      ...veo,
      id: 'legacy-video',
      capabilities: { ...veo.capabilities, aspect_ratios: undefined },
    };

    for (const model of [veo, legacyModel]) {
      const result = compileBoardGenerationRequest({
        data: {
          mode: 'video',
          prompt: '',
          durationSeconds: 6,
          videoResolution: '720p',
          videoAspect: 'adaptive',
          count: 1,
          status: 'idle',
        },
        model,
        prompt: 'Safe default aspect',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.request.params['aspect_ratio']).toBe('16:9');
        expect(result.request.params['aspect_ratio']).not.toBe('adaptive');
      }
    }
  });

  it('rejects excess references instead of silently truncating them', () => {
    const result = compileBoardGenerationRequest({
      data: { mode: 'video', prompt: '', count: 1, status: 'idle' },
      model: veo,
      prompt: 'x',
      imageUrls: ['1', '2', '3'],
    });
    expect(result).toMatchObject({ ok: false, field: 'imageUrls' });
    if (!result.ok) expect(result.reason).toContain('не больше 2');
  });

  it('fails closed when a persisted model id is no longer the resolved model', () => {
    const result = compileBoardGenerationRequest({
      data: {
        mode: 'video',
        modelId: 'removed-model',
        prompt: '',
        count: 1,
        status: 'idle',
      },
      model: veo,
      prompt: 'x',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('замена на veo не применена');
  });

  it('quotes the exact normalized request that the submit boundary accepts', () => {
    const model = { ...veo, minUnitCredits: 12 };
    const quote = compileBoardGenerationQuote({
      data: {
        mode: 'video',
        modelId: model.id,
        prompt: '',
        durationSeconds: 6,
        videoResolution: '720p',
        videoAspect: '16:9',
        generateAudio: false,
        count: 4,
        status: 'idle',
      },
      model,
      prompt: 'A precise shot',
      imageUrls: ['first.png', 'first.png', 'last.png'],
    });

    expect(quote).toMatchObject({
      ok: true,
      units: 6,
      cost: null,
      request: {
        modelId: 'veo',
        prompt: 'A precise shot',
        params: {
          duration_seconds: 6,
          resolution: '720p',
          aspect_ratio: '16:9',
          return_last_frame: true,
          frameImages: [
            { role: 'first', url: 'first.png' },
            { role: 'last', url: 'last.png' },
          ],
        },
      },
    });
    if (quote.ok) expect(quote.request.params).not.toHaveProperty('n');
  });

  it.each([
    ['duration', { duration_seconds: 5 }, 'durationSeconds'],
    ['resolution', { resolution: '480p' }, 'videoResolution'],
    ['reference count', { imageUrls: ['1', '2', '3'] }, 'imageUrls'],
    ['reference type', { videoUrls: ['motion.mp4'] }, 'videoUrls'],
    ['frame role', { lastFrameUrl: 'last.png' }, 'params'],
    ['audio', { generate_audio: true }, 'generateAudio'],
    ['negative prompt', { negative_prompt: 'blur' }, 'params'],
  ])('rejects unsupported %s before provider handoff', (_name, patch, field) => {
    const base = {
      duration_seconds: 6,
      resolution: '720p',
      aspect_ratio: '16:9',
      return_last_frame: true,
    };
    const result = validateBoardCompiledGenerationRequest(
      {
        modelId: veo.id,
        prompt: 'shot',
        params: { ...base, ...patch },
      },
      veo,
    );
    expect(result).toMatchObject({ ok: false, field });
  });

  // Phase 1.6 (pricing-correct-catalogue-build.md) — invariant 3 exempts only
  // three named classes from resolving a real price ("resolutionlessVideo" is
  // one, but only when the model declares NO resolutions — Gemini Omni). This
  // pins the OTHER half of that exemption's precondition: /boards itself never
  // lets a request through with an OMITTED resolution when the model declares
  // any — the omitted-resolution case pricing-resolver.ts is defending against
  // cannot reach the resolver from /boards at all for a model like `veo`.
  it('OMITTING resolution entirely is rejected for a model that declares a resolution menu', () => {
    const result = validateBoardCompiledGenerationRequest(
      {
        modelId: veo.id,
        prompt: 'shot',
        params: {
          duration_seconds: 6,
          aspect_ratio: '16:9',
          return_last_frame: true,
          // resolution deliberately absent — veo declares ['720p','1080p'].
        },
      },
      veo,
    );
    expect(result).toMatchObject({ ok: false, field: 'resolution' });
  });

  it('OMITTING resolution is fine for a model that declares NONE (the Gemini Omni exemption)', () => {
    const omni = {
      id: 'omni-like',
      kind: 'video' as const,
      maxDurationSeconds: 8,
      capabilities: {
        frames: ['first'],
        audio: true,
        audioControl: false,
        durations: [4, 6, 8],
        resolutions: [],
        aspect_ratios: ['16:9'],
      },
    };
    const result = validateBoardCompiledGenerationRequest(
      {
        modelId: omni.id,
        prompt: 'shot',
        params: {
          duration_seconds: 6,
          aspect_ratio: '16:9',
          return_last_frame: true,
        },
      },
      omni,
    );
    expect(result.ok).toBe(true);
  });

  it('compiles image controls into explicit provider-neutral fields', () => {
    const model = {
      id: 'image-configurable',
      kind: 'image' as const,
      capabilities: {
        maxRefs: 1,
        resolutions: ['1K', '2K'],
        aspect_ratios: ['1:1', '16:9'],
      },
    };
    expect(
      compileBoardGenerationRequest({
        data: {
          mode: 'image',
          modelId: model.id,
          prompt: '',
          imageAspect: '16:9',
          imageQuality: '2K',
          count: 3,
          status: 'idle',
        },
        model,
        prompt: 'three shots',
        imageUrls: ['reference.png'],
      }),
    ).toMatchObject({
      ok: true,
      request: {
        params: {
          aspect_ratio: '16:9',
          resolution: '2K',
          n: 3,
          imageUrls: ['reference.png'],
        },
      },
    });
  });

  it('omits fixed image controls and rejects a client that invents them', () => {
    const fixed = {
      id: 'image-fixed',
      kind: 'image' as const,
      capabilities: { maxRefs: 0, resolutions: [], aspect_ratios: [] },
    };
    expect(
      compileBoardGenerationRequest({
        data: { mode: 'image', modelId: fixed.id, prompt: '', count: 1, status: 'idle' },
        model: fixed,
        prompt: 'fixed output',
      }),
    ).toMatchObject({ ok: true, request: { params: { n: 1 } } });
    expect(
      validateBoardCompiledGenerationRequest(
        {
          modelId: fixed.id,
          prompt: 'fixed output',
          params: { n: 1, aspect_ratio: '1:1' },
        },
        fixed,
      ),
    ).toMatchObject({ ok: false, field: 'aspect_ratio' });
  });

  it('omits model-managed video controls and rejects invented wire fields', () => {
    const fixed = {
      id: 'video-model-managed',
      kind: 'video' as const,
      maxDurationSeconds: 10,
      capabilities: {
        frames: ['first'],
        durations: [4, 6, 8, 10],
        resolutions: [],
        aspect_ratios: [],
        audio: true,
        audioControl: false,
      },
    };
    expect(
      compileBoardGenerationRequest({
        data: {
          mode: 'video',
          modelId: fixed.id,
          prompt: '',
          durationSeconds: 4,
          count: 1,
          status: 'idle',
        },
        model: fixed,
        prompt: 'model-managed output',
      }),
    ).toMatchObject({
      ok: true,
      request: { params: { duration_seconds: 4, return_last_frame: true } },
    });
    for (const [field, value, expectedField] of [
      ['resolution', '720p', 'videoResolution'],
      ['aspect_ratio', '16:9', 'videoAspect'],
      ['generate_audio', false, 'generateAudio'],
    ] as const) {
      expect(
        validateBoardCompiledGenerationRequest(
          {
            modelId: fixed.id,
            prompt: 'model-managed output',
            params: { duration_seconds: 4, return_last_frame: true, [field]: value },
          },
          fixed,
        ),
      ).toMatchObject({ ok: false, field: expectedField });
    }
  });

  it('rejects incomplete catalog metadata instead of inferring a runnable contract', () => {
    const incomplete = {
      id: 'legacy-video',
      kind: 'video' as const,
      maxDurationSeconds: 8,
      capabilities: { frames: ['first'] },
    };
    expect(isBoardModelCatalogComplete(incomplete)).toBe(false);
    expect(boardModelMetadataIssues(incomplete)).toEqual(
      expect.arrayContaining([
        'capabilities.durations',
        'capabilities.resolutions',
        'capabilities.aspect_ratios',
        'capabilities.audio',
      ]),
    );
    expect(
      boardModelMetadataIssues({ id: 'legacy-image', kind: 'image', capabilities: { maxRefs: 0 } }),
    ).toEqual(expect.arrayContaining(['capabilities.resolutions', 'capabilities.aspect_ratios']));
    expect(
      boardModelMetadataIssues({
        id: 'invalid-image-options',
        kind: 'image',
        capabilities: { maxRefs: 0, resolutions: ['8K'], aspect_ratios: ['7:3'] },
      }),
    ).toEqual(expect.arrayContaining(['capabilities.resolutions', 'capabilities.aspect_ratios']));
    expect(
      boardModelMetadataIssues({
        id: 'fixed-video-options',
        kind: 'video',
        maxDurationSeconds: 4,
        capabilities: {
          frames: [],
          durations: [4],
          resolutions: [],
          aspect_ratios: [],
          audio: true,
          audioControl: false,
        },
      }),
    ).toEqual([]);
  });

  it('preserves a sparse last-frame role instead of reinterpreting it as first', () => {
    const result = compileBoardGenerationRequest({
      data: {
        mode: 'video',
        modelId: veo.id,
        prompt: '',
        durationSeconds: 6,
        videoResolution: '720p',
        videoAspect: '16:9',
        generateAudio: false,
        count: 1,
        status: 'idle',
      },
      model: veo,
      prompt: 'shot',
      frameImages: [{ role: 'last', url: 'last.png' }],
    });
    expect(result).toMatchObject({
      ok: true,
      request: { params: { frameImages: [{ role: 'last', url: 'last.png' }] } },
    });
  });

  it('rejects a frame role that the selected model does not declare', () => {
    const firstOnly = {
      ...veo,
      id: 'first-only',
      capabilities: { ...veo.capabilities, frames: ['first'] },
    };
    expect(
      validateBoardCompiledGenerationRequest(
        {
          modelId: firstOnly.id,
          prompt: 'shot',
          params: {
            duration_seconds: 6,
            resolution: '720p',
            aspect_ratio: '16:9',
            generate_audio: false,
            return_last_frame: true,
            frameImages: [{ role: 'last', url: 'last.png' }],
          },
        },
        firstOnly,
      ),
    ).toMatchObject({ ok: false, field: 'frameImages' });
  });

  it('validates aggregate cast expansion and input cardinality', () => {
    const target = node('target', 'generate', { mode: 'image', prompt: '' });
    const model = {
      id: 'edit-five',
      kind: 'image-edit' as const,
      capabilities: { maxRefs: 5 },
    };
    const connections = [
      {
        source: node('cast-a', 'cast', {
          castKind: 'character',
          name: 'A',
          imageUrls: ['1', '2', '3'],
        }),
        sourceHandle: 'out',
        targetHandle: 'images[0]',
      },
      {
        source: node('cast-b', 'cast', {
          castKind: 'character',
          name: 'B',
          imageUrls: ['4', '5', '6'],
        }),
        sourceHandle: 'out',
        targetHandle: 'images[1]',
      },
    ];
    const result = validateBoardConnections({ target, targetModel: model, connections });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('Подключено 6 изображений');

    expect(
      validateBoardConnections({
        target,
        targetModel: model,
        connections: [connections[0]!, { ...connections[1]!, targetHandle: 'images[0]' }],
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('уже занят') });
  });

  it('allows planned empty media wires but rejects them at execution readiness', () => {
    const target = node('target', 'generate', { mode: 'image', prompt: '' });
    const connection = {
      source: node('media', 'media', { mediaKind: 'image', url: '' }),
      sourceHandle: 'out',
      targetHandle: 'images[0]',
    };
    const model = {
      id: 'edit',
      kind: 'image-edit' as const,
      capabilities: { maxRefs: 1 },
    };
    expect(
      validateBoardConnections({ target, targetModel: model, connections: [connection] }).ok,
    ).toBe(true);
    expect(
      validateBoardConnections({
        target,
        targetModel: model,
        connections: [connection],
        requireReady: true,
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('не содержит файл') });
  });
});

describe('model-signed generation defaults', () => {
  const flux = {
    id: 'flux-2-pro',
    kind: 'image' as const,
    capabilities: { resolutions: ['1K', '2K'], default_resolution: '1K' },
  };
  const veo = {
    id: 'veo-3-1',
    kind: 'video' as const,
    capabilities: { resolutions: ['720p', '1080p'], default_resolution: '1080p' },
  };

  it('uses Flux’s signed default when no image quality was saved', () => {
    expect(
      resolveBoardImageSettings({ imageAspect: undefined, imageQuality: undefined }, flux)
        .imageQuality,
    ).toBe('1K');
  });

  it('uses Veo’s signed default when no video resolution was saved', () => {
    expect(
      resolveBoardVideoSettings(
        {
          durationSeconds: undefined,
          videoResolution: undefined,
          videoAspect: undefined,
          generateAudio: undefined,
        },
        veo,
      ).videoResolution,
    ).toBe('1080p');
  });

  it('keeps global defaults for an un-seeded model', () => {
    expect(
      resolveBoardImageSettings(
        { imageAspect: undefined, imageQuality: undefined },
        {
          id: 'legacy-image',
          kind: 'image',
          capabilities: { resolutions: ['1K', '2K', '4K'] },
        },
      ).imageQuality,
    ).toBe('2K');
    expect(
      resolveBoardVideoSettings(
        {
          durationSeconds: undefined,
          videoResolution: undefined,
          videoAspect: undefined,
          generateAudio: undefined,
        },
        { id: 'legacy-video', kind: 'video', capabilities: { resolutions: ['480p', '720p'] } },
      ).videoResolution,
    ).toBe('720p');
  });

  it('keeps a saved value that the model offers over its signed default', () => {
    expect(
      resolveBoardImageSettings({ imageAspect: undefined, imageQuality: '2K' }, flux).imageQuality,
    ).toBe('2K');
    expect(
      resolveBoardVideoSettings(
        {
          durationSeconds: undefined,
          videoResolution: '720p',
          videoAspect: undefined,
          generateAudio: undefined,
        },
        veo,
      ).videoResolution,
    ).toBe('720p');
  });

  it('falls through to the global default when a seeded default is not offered', () => {
    expect(
      resolveBoardImageSettings(
        { imageAspect: undefined, imageQuality: undefined },
        {
          id: 'mismatched-image',
          kind: 'image',
          capabilities: { resolutions: ['1K', '4K'], default_resolution: '2K' },
        },
      ).imageQuality,
    ).toBe('1K');
    expect(
      resolveBoardVideoSettings(
        {
          durationSeconds: undefined,
          videoResolution: undefined,
          videoAspect: undefined,
          generateAudio: undefined,
        },
        {
          id: 'mismatched-video',
          kind: 'video',
          capabilities: { resolutions: ['480p', '1080p'], default_resolution: '4K' },
        },
      ).videoResolution,
    ).toBe('480p');
  });
});

describe('BRD-3 active catalog conformance', () => {
  const activeMediaModels = seedModels.filter(
    (model) => model.isActive && ['image', 'image-edit', 'video'].includes(model.kind),
  );

  it('keeps every active Board model explicit and compilable', () => {
    expect(activeMediaModels).toHaveLength(22); // happyhorse-1-0 and Seedream 4.5 are retired
    for (const candidate of activeMediaModels) {
      const model = candidate as BoardModelLike;
      expect(boardModelMetadataIssues(model), model.id).toEqual([]);

      const capabilities = (model.capabilities ?? {}) as Record<string, unknown>;
      const durations = capabilities['durations'] as number[] | undefined;
      const resolutions = capabilities['resolutions'] as string[] | undefined;
      const aspects = capabilities['aspect_ratios'] as string[] | undefined;
      const data =
        model.kind === 'video'
          ? {
              mode: 'video' as const,
              modelId: model.id,
              prompt: '',
              durationSeconds: durations?.[0],
              videoResolution: resolutions?.[0] as '480p' | '720p' | '1080p' | undefined,
              videoAspect: aspects?.[0] as
                | '21:9'
                | '16:9'
                | '4:3'
                | '1:1'
                | '3:4'
                | '9:16'
                | 'adaptive'
                | undefined,
              ...(capabilities['audio'] === true && capabilities['audioControl'] !== false
                ? { generateAudio: true }
                : {}),
              count: 1,
              status: 'idle' as const,
            }
          : {
              mode: 'image' as const,
              modelId: model.id,
              prompt: '',
              imageAspect: aspects?.[0] as
                | '21:9'
                | '16:9'
                | '4:3'
                | '1:1'
                | '3:4'
                | '9:16'
                | undefined,
              imageQuality: resolutions?.[0] as '1K' | '2K' | '4K' | undefined,
              count: 1,
              status: 'idle' as const,
            };
      const quote = compileBoardGenerationQuote({ data, model, prompt: 'catalog conformance' });
      expect(quote.ok, model.id).toBe(true);
    }
  });
});

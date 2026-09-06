import { z } from 'zod';
import { unitsForGenerationModel } from './generation-request';
import { SCENE_OBJECTS_MAX, sceneObjectKindSchema } from './scene-objects';

export {
  PROMPT_STUDIO_CHARS_PER_TOKEN,
  PROMPT_STUDIO_BRIEF_CHAR_LIMIT,
  PROMPT_STUDIO_CREDITS,
  PROMPT_STUDIO_INPUT_TOKEN_LIMIT,
  PROMPT_STUDIO_OUTPUT_TOKEN_LIMIT,
  PROMPT_STUDIO_PRICING,
  PROMPT_STUDIO_RESULT_CHAR_LIMIT,
  PROMPT_STUDIO_AVERAGE_TOKEN_BUDGET,
  PROMPT_STUDIO_MAX_TOKEN_BUDGET,
  promptStudioCostUsd,
  promptStudioCreditsFor,
  promptStudioMarginAtFloor,
} from './prompt-studio-pricing';
export type {
  PromptStudioBudgetKind,
  PromptStudioCostBasis,
  PromptStudioModel,
  PromptStudioModelPricing,
} from './prompt-studio-pricing';

export const BOARD_SCHEMA_VERSION = 1 as const;
export const BOARD_NODE_VERSION = 1 as const;

export const BOARD_KNOWN_NODE_TYPES = [
  'prompt',
  'aiprompt',
  'note',
  'scene',
  'media',
  'cast',
  'generate',
  'text',
  'frame',
] as const;
export type BoardNodeType = (typeof BOARD_KNOWN_NODE_TYPES)[number];

export const BOARD_LIMITS = {
  stateBytes: 1_048_576,
  nodes: 500,
  edges: 2_000,
  tray: 500,
  text: 8_000,
  organizerText: 2_000,
  frameTitle: 120,
  frameWidthMin: 240,
  frameHeightMin: 160,
  frameDimensionMax: 4_000,
  note: 20_000,
  url: 4_096,
  nodeId: 128,
  edgeId: 160,
  handleId: 128,
  modelId: 160,
  castImages: 4,
  takes: 4,
  sceneText: 32_000,
  sceneSynopsis: 500,
  sceneContext: 400,
} as const;

export const BOARD_VIDEO_ASPECTS = [
  '21:9',
  '16:9',
  '4:3',
  '1:1',
  '3:4',
  '9:16',
  'adaptive',
] as const;
export const BOARD_VIDEO_RESOLUTIONS = ['480p', '720p', '1080p'] as const;
export const BOARD_IMAGE_ASPECTS = [
  '21:9',
  '16:9',
  '3:2',
  '4:3',
  '1:1',
  '3:4',
  '2:3',
  '9:16',
] as const;
// '3K' entered with Seedream 5.0 Lite (kie quality high = 3K), 2026-07-25.
// 'low'/'medium'/'high' entered with gpt-image-2 (pricing-correct-catalogue-build.md
// phase 1.1, 2026-07-28): the model's `capabilities.resolutions` keys on the vendor's
// OWN quality values, not a pixel tier, per owner ruling — this axis is a generic
// "quality" selector, not literally always a resolution.
export const BOARD_IMAGE_QUALITIES = ['1K', '2K', '3K', '4K', 'low', 'medium', 'high'] as const;

/** Human-readable Russian labels for provider-owned quality tiers. Pixel tiers
 * (1K/2K/3K/4K) deliberately stay verbatim. Shared by Boards and Generate so
 * the two entry points cannot drift. */
const BOARD_IMAGE_QUALITY_WORDS: Partial<Record<(typeof BOARD_IMAGE_QUALITIES)[number], string>> = {
  low: 'Низкое',
  medium: 'Среднее',
  high: 'Высокое',
};

export function boardImageQualityLabel(quality: string): string {
  return BOARD_IMAGE_QUALITY_WORDS[quality as keyof typeof BOARD_IMAGE_QUALITY_WORDS] ?? quality;
}

export function boardImageQualityIsVendorWord(quality: string): boolean {
  return quality in BOARD_IMAGE_QUALITY_WORDS;
}

export const BOARD_GENERATION_STATUSES = ['idle', 'running', 'done', 'failed'] as const;

export const BOARD_GENERATE_DEFAULTS = {
  durationSeconds: 5,
  videoResolution: '720p',
  videoAspect: '16:9',
  generateAudio: true,
  imageAspect: '1:1',
  imageQuality: '2K',
  count: 1,
  status: 'idle',
} as const;

const boundedString = (max: number) => z.string().max(max);
const nodeIdSchema = boundedString(BOARD_LIMITS.nodeId).min(1);
const edgeIdSchema = boundedString(BOARD_LIMITS.edgeId).min(1);
const handleIdSchema = boundedString(BOARD_LIMITS.handleId);
const urlSlotSchema = boundedString(BOARD_LIMITS.url);
const finiteCoordinate = z.number().finite().min(-10_000_000).max(10_000_000);

export const boardPositionSchema = z.object({ x: finiteCoordinate, y: finiteCoordinate }).strict();
export const boardViewportSchema = z
  .object({
    x: finiteCoordinate,
    y: finiteCoordinate,
    zoom: z.number().finite().min(0.01).max(16),
  })
  .strict();

export const boardShotGrammarSchema = z
  .object({
    size: boundedString(32).optional(),
    move: boundedString(32).optional(),
    moves: z.array(boundedString(32)).max(3).optional(),
    lens: boundedString(32).optional(),
    light: boundedString(32).optional(),
    colorTemp: boundedString(32).optional(),
    genre: boundedString(32).optional(),
    energy: boundedString(32).optional(),
  })
  .strict();

export const boardPromptDataSchema = z
  .object({
    text: boundedString(BOARD_LIMITS.text).default(''),
    sourceSceneNodeId: boundedString(BOARD_LIMITS.nodeId).optional(),
  })
  .strict();

export const boardAiPromptDataSchema = z
  .object({
    // Persistence stays at the historical 8,000-character envelope so an old
    // board can still be opened. The paid API/UI/provider boundaries enforce
    // PROMPT_STUDIO_BRIEF_CHAR_LIMIT and PROMPT_STUDIO_RESULT_CHAR_LIMIT.
    brief: boundedString(BOARD_LIMITS.text).default(''),
    // A durable claim key lets a transport retry replay a completed paid draft
    // instead of opening a second charge. It is cleared after success and
    // removed when a node is duplicated, so keys never cross node ownership.
    idempotencyKey: boundedString(128).min(8).optional(),
    sceneContext: boundedString(BOARD_LIMITS.sceneContext).optional(),
    text: boundedString(BOARD_LIMITS.text).optional(),
    model: z.enum(['claude', 'gpt', 'gemini']).default('claude'),
    mode: z.enum(['video', 'image']).default('video'),
    status: z.enum(BOARD_GENERATION_STATUSES).default('idle'),
    view: z.enum(['brief', 'result']).default('brief'),
  })
  .strict();

export const boardNoteDataSchema = z
  .object({ text: boundedString(BOARD_LIMITS.note).default('') })
  .strict();

export const boardTextSizeSchema = z.enum(['s', 'm', 'l']);
export const boardTextDataSchema = z
  .object({
    /** `content` is accepted as a one-release import alias; output is `text`. */
    text: boundedString(BOARD_LIMITS.organizerText).optional(),
    content: boundedString(BOARD_LIMITS.organizerText).optional(),
    size: boardTextSizeSchema.default('m'),
  })
  .strict()
  .transform(({ text, content, size }) => ({ text: text ?? content ?? '', size }));

export const BOARD_FRAME_TINTS = ['violet', 'blue', 'green', 'amber', 'pink', 'gray'] as const;
export const boardFrameTintSchema = z.enum(BOARD_FRAME_TINTS);
export const boardFrameDataSchema = z
  .object({
    title: boundedString(BOARD_LIMITS.frameTitle).default('Рамка'),
    tint: boardFrameTintSchema.optional(),
    /** Import alias for clients that called this field backgroundTint. */
    backgroundTint: boardFrameTintSchema.optional(),
  })
  .strict()
  .transform(({ title, tint, backgroundTint }) => ({
    title,
    ...((tint ?? backgroundTint) ? { tint: tint ?? backgroundTint } : {}),
  }));

export const boardSceneObjectSchema = z
  .object({
    kind: sceneObjectKindSchema,
    name: z
      .string()
      .min(1)
      .max(80)
      .refine((value) => value.trim().length > 0),
    /** Grounded extraction detail; absent on pre-continuity boards. */
    description: boundedString(200).optional(),
    /** Board-local continuity link. It never names a project-wide entity. */
    castNodeId: nodeIdSchema.optional(),
    /** A linked chip retained after the latest extraction no longer found it. */
    absentFromLatestExtraction: z.boolean().optional(),
  })
  .strict();

export const boardSceneDataSchema = z
  .object({
    title: boundedString(240).default('Сцена'),
    synopsis: boundedString(BOARD_LIMITS.sceneSynopsis).default(''),
    sourceText: boundedString(BOARD_LIMITS.sceneText).default(''),
    sourceScriptId: boundedString(BOARD_LIMITS.nodeId).optional(),
    sourceScriptRevision: z.number().int().nonnegative().optional(),
    sourceSceneId: boundedString(BOARD_LIMITS.nodeId).optional(),
    sourceSceneRevision: z.number().int().nonnegative().optional(),
    sourceOrdinal: z.number().int().positive().max(10_000).optional(),
    sourceHash: boundedString(128).optional(),
    /** Hash of the source text used for the last persisted object extraction. */
    objectsSourceHash: boundedString(128).optional(),
    sourceStatus: z.enum(['current', 'changed', 'removed']).default('current'),
    collapsed: z.boolean().default(true),
    objects: z.array(boardSceneObjectSchema).max(SCENE_OBJECTS_MAX).optional(),
  })
  .strict();

export const boardMediaDataSchema = z
  .object({
    url: urlSlotSchema.default(''),
    mediaKind: z.enum(['image', 'video']).default('image'),
    /** Stable Vertov gallery identity. Absent means a legacy/upload/external URL. */
    assetId: boundedString(BOARD_LIMITS.nodeId).optional(),
  })
  .strict();

export const boardCastDataSchema = z
  .object({
    castKind: z.enum(['character', 'location', 'product']).default('character'),
    name: boundedString(160).default(''),
    description: boundedString(200).optional(),
    imageUrls: z.array(urlSlotSchema).max(BOARD_LIMITS.castImages).default([]),
    videoUrl: urlSlotSchema.optional(),
    characterId: boundedString(BOARD_LIMITS.nodeId).optional(),
  })
  .strict();

export const boardGenerateDataSchema = z
  .object({
    mode: z.enum(['image', 'video']).default('video'),
    prompt: boundedString(BOARD_LIMITS.text).default(''),
    shot: boardShotGrammarSchema.optional(),
    modelId: boundedString(BOARD_LIMITS.modelId).optional(),
    durationSeconds: z.number().finite().int().min(1).max(120).optional(),
    videoResolution: z.enum(BOARD_VIDEO_RESOLUTIONS).optional(),
    videoAspect: z.enum(BOARD_VIDEO_ASPECTS).optional(),
    generateAudio: z.boolean().optional(),
    imageAspect: z.enum(BOARD_IMAGE_ASPECTS).optional(),
    imageQuality: z.enum(BOARD_IMAGE_QUALITIES).optional(),
    count: z.number().finite().int().min(1).max(BOARD_LIMITS.takes).default(1),
    status: z.enum(BOARD_GENERATION_STATUSES).default('idle'),
    jobId: boundedString(BOARD_LIMITS.nodeId).optional(),
    // A batch is complete when every id has reached a terminal state, which is
    // checked by comparing a Set's size against this array's length — a
    // duplicate id would make that comparison unsatisfiable and pin the shot on
    // «идёт…» forever. Empty is rejected for the same reason.
    jobIds: z
      .array(boundedString(BOARD_LIMITS.nodeId))
      .min(1)
      .max(BOARD_LIMITS.takes)
      .refine((ids) => new Set(ids).size === ids.length, 'jobIds must be unique')
      .optional(),
    resultUrl: urlSlotSchema.optional(),
    resultKind: z.enum(['image', 'video']).optional(),
    /** Stable gallery identity for a persisted result. Absent on legacy nodes. */
    assetId: boundedString(BOARD_LIMITS.nodeId).optional(),
    lastFrameUrl: urlSlotSchema.optional(),
    takes: z.array(urlSlotSchema).max(BOARD_LIMITS.takes).optional(),
    drifted: z.boolean().optional(),
    failureMessage: boundedString(240).optional(),
    failureAction: z.enum(['retry', 'settings', 'replace_reference']).optional(),
    sourceSceneNodeId: boundedString(BOARD_LIMITS.nodeId).optional(),
    /** The cast card that explicitly spawned this reference shot. */
    originCastNodeId: boundedString(BOARD_LIMITS.nodeId).optional(),
  })
  .strict();

/** Persisted controls that can change the generation request or quote. */
export const boardGenerateSettingsSchema = boardGenerateDataSchema.pick({
  mode: true,
  modelId: true,
  durationSeconds: true,
  videoResolution: true,
  videoAspect: true,
  generateAudio: true,
  imageAspect: true,
  imageQuality: true,
  count: true,
  shot: true,
});

const nodeChromeShape = {
  id: nodeIdSchema,
  version: z.literal(BOARD_NODE_VERSION).default(BOARD_NODE_VERSION),
  position: boardPositionSchema,
  width: z.number().finite().min(40).max(4_000).optional(),
  height: z.number().finite().min(40).max(4_000).optional(),
  selected: z.boolean().optional(),
  dragging: z.boolean().optional(),
  parentId: nodeIdSchema.optional(),
  extent: z.literal('parent').optional(),
  zIndex: z.number().finite().min(-10_000).max(10_000).optional(),
} as const;

function nodeSchema<T extends string>(type: T, data: z.ZodTypeAny) {
  return z
    .object({
      ...nodeChromeShape,
      type: z.literal(type),
      data,
    })
    .passthrough();
}

const frameNodeSchema = z
  .object({
    ...nodeChromeShape,
    type: z.literal('frame'),
    width: z
      .number()
      .finite()
      .min(BOARD_LIMITS.frameWidthMin)
      .max(BOARD_LIMITS.frameDimensionMax)
      .default(520),
    height: z
      .number()
      .finite()
      .min(BOARD_LIMITS.frameHeightMin)
      .max(BOARD_LIMITS.frameDimensionMax)
      .default(320),
    data: boardFrameDataSchema,
  })
  .passthrough();

const knownBoardNodeSchema = z.union([
  nodeSchema('prompt', boardPromptDataSchema),
  nodeSchema('aiprompt', boardAiPromptDataSchema),
  nodeSchema('note', boardNoteDataSchema),
  nodeSchema('scene', boardSceneDataSchema),
  nodeSchema('media', boardMediaDataSchema),
  nodeSchema('cast', boardCastDataSchema),
  nodeSchema('generate', boardGenerateDataSchema),
  nodeSchema('text', boardTextDataSchema),
  frameNodeSchema,
]);

/** Preserve nodes from a newer client so an older client can round-trip them. */
const forwardCompatibleNodeSchema = z
  .object({
    ...nodeChromeShape,
    type: z
      .string()
      .min(1)
      .refine((type) => !(BOARD_KNOWN_NODE_TYPES as readonly string[]).includes(type)),
    data: z.record(z.unknown()),
  })
  .passthrough();

export const boardNodeSchema = z.union([knownBoardNodeSchema, forwardCompatibleNodeSchema]);

export function isKnownBoardNodeType(value: string): value is BoardNodeType {
  return (BOARD_KNOWN_NODE_TYPES as readonly string[]).includes(value);
}

export const boardEdgeSchema = z
  .object({
    id: edgeIdSchema,
    source: nodeIdSchema,
    target: nodeIdSchema,
    sourceHandle: handleIdSchema.nullable().optional(),
    targetHandle: handleIdSchema.nullable().optional(),
    type: boundedString(64).optional(),
    animated: z.boolean().optional(),
    selected: z.boolean().optional(),
  })
  .passthrough();

export const boardDocumentSchema = z
  .object({
    schemaVersion: z.literal(BOARD_SCHEMA_VERSION),
    nodes: z.array(boardNodeSchema).max(BOARD_LIMITS.nodes).default([]),
    edges: z.array(boardEdgeSchema).max(BOARD_LIMITS.edges).default([]),
    viewport: boardViewportSchema.optional(),
    tray: z.array(nodeIdSchema).max(BOARD_LIMITS.tray).default([]),
    __rev: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER - 1)
      .optional(),
  })
  .passthrough()
  .superRefine((document, ctx) => {
    const nodeIds = new Set<string>();
    const nodesById = new Map<string, (typeof document.nodes)[number]>();
    for (let index = 0; index < document.nodes.length; index += 1) {
      const current = document.nodes[index]!;
      const id = current.id;
      if (nodeIds.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate node id '${id}'`,
          path: ['nodes', index, 'id'],
        });
      }
      nodeIds.add(id);
      nodesById.set(id, current);
    }

    for (let index = 0; index < document.nodes.length; index += 1) {
      const current = document.nodes[index]!;
      if (current.parentId === undefined) {
        if (current.extent === 'parent') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "a node with extent 'parent' must have a parentId",
            path: ['nodes', index, 'extent'],
          });
        }
        continue;
      }
      const parent = nodesById.get(current.parentId);
      if (!parent) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `parent node '${current.parentId}' does not exist`,
          path: ['nodes', index, 'parentId'],
        });
      } else if (parent.type !== 'frame') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'parentId must refer to a frame node',
          path: ['nodes', index, 'parentId'],
        });
      }
      if (current.type === 'frame') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'frames cannot be nested',
          path: ['nodes', index, 'parentId'],
        });
      }
      if (current.extent !== 'parent') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "a child node's extent must be 'parent'",
          path: ['nodes', index, 'extent'],
        });
      }
    }

    const edgeIds = new Set<string>();
    const occupiedInputs = new Set<string>();
    for (let index = 0; index < document.edges.length; index += 1) {
      const edge = document.edges[index]!;
      if (edgeIds.has(edge.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate edge id '${edge.id}'`,
          path: ['edges', index, 'id'],
        });
      }
      edgeIds.add(edge.id);
      if (!nodeIds.has(edge.source)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `edge source '${edge.source}' does not exist`,
          path: ['edges', index, 'source'],
        });
      }
      if (!nodeIds.has(edge.target)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `edge target '${edge.target}' does not exist`,
          path: ['edges', index, 'target'],
        });
      }
      const source = nodesById.get(edge.source);
      const target = nodesById.get(edge.target);
      if (
        source &&
        target &&
        isKnownBoardNodeType(source.type) &&
        isKnownBoardNodeType(target.type)
      ) {
        const semantic = validateBoardConnectionShape({
          source,
          sourceHandle: edge.sourceHandle,
          target,
          targetHandle: edge.targetHandle,
        });
        if (!semantic.ok) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: semantic.reason,
            path: ['edges', index],
          });
        }

        const occupiedKey = `${edge.target}:${edge.targetHandle ?? ''}`;
        if (occupiedInputs.has(occupiedKey)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `input '${edge.targetHandle ?? ''}' already has a connection`,
            path: ['edges', index, 'targetHandle'],
          });
        }
        occupiedInputs.add(occupiedKey);
      }
    }
    if (boardGenerateGraphHasCycle(document.nodes, document.edges)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'generate dependency graph contains a cycle',
        path: ['edges'],
      });
    }

    for (let index = 0; index < document.tray.length; index += 1) {
      if (!nodeIds.has(document.tray[index]!)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `tray node '${document.tray[index]}' does not exist`,
          path: ['tray', index],
        });
      }
    }
  });

export type BoardDocument = z.infer<typeof boardDocumentSchema>;
export type BoardNode = z.infer<typeof boardNodeSchema>;
export type BoardEdge = z.infer<typeof boardEdgeSchema>;
export type BoardPromptData = z.infer<typeof boardPromptDataSchema>;
export type BoardAiPromptData = z.infer<typeof boardAiPromptDataSchema>;
export type BoardNoteData = z.infer<typeof boardNoteDataSchema>;
export type BoardTextData = z.infer<typeof boardTextDataSchema>;
export type BoardFrameData = z.infer<typeof boardFrameDataSchema>;
export type BoardSceneObject = z.infer<typeof boardSceneObjectSchema>;
export type BoardSceneData = z.infer<typeof boardSceneDataSchema>;
export type BoardMediaData = z.infer<typeof boardMediaDataSchema>;
export type BoardCastData = z.infer<typeof boardCastDataSchema>;
export type BoardGenerateData = z.infer<typeof boardGenerateDataSchema>;
export type BoardShotGrammar = z.infer<typeof boardShotGrammarSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** React Flow requires grouping parents to precede their children. */
export function normalizeBoardNodeOrder<T extends { type?: unknown }>(nodes: readonly T[]): T[] {
  if (!nodes.some((node) => node.type === 'frame')) return [...nodes];
  return [...nodes].sort((left, right) => {
    const leftFrame = left.type === 'frame' ? 0 : 1;
    const rightFrame = right.type === 'frame' ? 0 : 1;
    return leftFrame - rightFrame;
  });
}

/**
 * Upgrade the one legacy document shape (no schema/node versions and a shared
 * `images` target handle) into v1 without mutating the caller's object.
 * Unknown/future schema versions are left untouched so the v1 parser fails
 * closed instead of pretending it understands them.
 */
export function migrateBoardDocument(input: unknown): unknown {
  if (!isRecord(input)) return input;
  if (input.schemaVersion !== undefined && input.schemaVersion !== 0) return input;

  const nodes = Array.isArray(input.nodes)
    ? normalizeBoardNodeOrder(
        input.nodes.map((node) =>
          isRecord(node) ? { ...node, version: BOARD_NODE_VERSION } : node,
        ),
      )
    : [];
  const sourceHandles = new Map<string, string>();
  for (const node of nodes) {
    if (!isRecord(node) || typeof node.id !== 'string' || typeof node.type !== 'string') continue;
    sourceHandles.set(node.id, node.type === 'prompt' || node.type === 'aiprompt' ? 'text' : 'out');
  }
  const counters = new Map<string, number>();
  const edges = Array.isArray(input.edges)
    ? input.edges.map((edge) => {
        if (!isRecord(edge)) return edge;
        let next = { ...edge };
        if (
          (edge.sourceHandle === undefined || edge.sourceHandle === null) &&
          typeof edge.source === 'string' &&
          sourceHandles.has(edge.source)
        ) {
          next = { ...next, sourceHandle: sourceHandles.get(edge.source)! };
        }
        if (edge.targetHandle === 'images' && typeof edge.target === 'string') {
          const index = counters.get(edge.target) ?? 0;
          counters.set(edge.target, index + 1);
          next = { ...next, targetHandle: `images[${index}]` };
        }
        return next;
      })
    : [];

  return {
    ...input,
    schemaVersion: BOARD_SCHEMA_VERSION,
    nodes,
    edges,
    tray: Array.isArray(input.tray) ? input.tray : [],
  };
}

export function safeParseBoardDocument(input: unknown) {
  const result = boardDocumentSchema.safeParse(migrateBoardDocument(input));
  if (!result.success) return result;
  return {
    ...result,
    data: {
      ...result.data,
      nodes: normalizeBoardNodeOrder(result.data.nodes),
    } as typeof result.data,
  };
}

export function parseBoardDocument(input: unknown): BoardDocument {
  const parsed = boardDocumentSchema.parse(migrateBoardDocument(input));
  return {
    ...parsed,
    nodes: normalizeBoardNodeOrder(parsed.nodes),
  };
}

/** Shared cycle predicate for document parsing and interactive connection checks. */
export function boardGenerateCycleEdgeIndexes(
  nodes: readonly { id: string; type?: string | null | undefined }[],
  edges: readonly {
    source: string;
    target: string;
    targetHandle?: string | null | undefined;
  }[],
): number[] {
  const generateIds = new Set(
    nodes.filter((node) => node.type === 'generate').map((node) => node.id),
  );
  const adjacency = new Map<string, { target: string; edgeIndex: number }[]>();
  const relevant: { source: string; target: string; edgeIndex: number }[] = [];
  for (let edgeIndex = 0; edgeIndex < edges.length; edgeIndex += 1) {
    const edge = edges[edgeIndex]!;
    if (
      !generateIds.has(edge.source) ||
      !generateIds.has(edge.target) ||
      !/^images(?:\[\d+\])?$/.test(edge.targetHandle ?? '')
    ) {
      continue;
    }
    relevant.push({ source: edge.source, target: edge.target, edgeIndex });
    adjacency.set(edge.source, [
      ...(adjacency.get(edge.source) ?? []),
      { target: edge.target, edgeIndex },
    ]);
  }

  let cursor = 0;
  const indexByNode = new Map<string, number>();
  const lowByNode = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const componentByNode = new Map<string, number>();
  const componentSizes = new Map<number, number>();
  let componentId = 0;

  const visit = (nodeId: string): void => {
    indexByNode.set(nodeId, cursor);
    lowByNode.set(nodeId, cursor);
    cursor += 1;
    stack.push(nodeId);
    onStack.add(nodeId);

    for (const edge of adjacency.get(nodeId) ?? []) {
      if (!indexByNode.has(edge.target)) {
        visit(edge.target);
        lowByNode.set(nodeId, Math.min(lowByNode.get(nodeId)!, lowByNode.get(edge.target)!));
      } else if (onStack.has(edge.target)) {
        lowByNode.set(nodeId, Math.min(lowByNode.get(nodeId)!, indexByNode.get(edge.target)!));
      }
    }

    if (lowByNode.get(nodeId) !== indexByNode.get(nodeId)) return;
    let size = 0;
    while (stack.length > 0) {
      const member = stack.pop()!;
      onStack.delete(member);
      componentByNode.set(member, componentId);
      size += 1;
      if (member === nodeId) break;
    }
    componentSizes.set(componentId, size);
    componentId += 1;
  };

  for (const nodeId of generateIds) if (!indexByNode.has(nodeId)) visit(nodeId);

  return relevant
    .filter((edge) => {
      const component = componentByNode.get(edge.source);
      return (
        component !== undefined &&
        component === componentByNode.get(edge.target) &&
        (edge.source === edge.target || (componentSizes.get(component) ?? 0) > 1)
      );
    })
    .map((edge) => edge.edgeIndex);
}

export function boardGenerateGraphHasCycle(
  nodes: readonly { id: string; type?: string | null | undefined }[],
  edges: readonly {
    source: string;
    target: string;
    targetHandle?: string | null | undefined;
  }[],
): boolean {
  return boardGenerateCycleEdgeIndexes(nodes, edges).length > 0;
}

export type BoardSemanticPayload =
  | 'text.prompt'
  | 'image.reference'
  | 'image.generated'
  | 'image.frame.first'
  | 'image.frame.last'
  | 'video.motionReference'
  | 'video.generated'
  | 'cast.identityPack'
  | 'cast.locationPack'
  | 'scene.context';

export interface BoardPortSpec {
  key: string;
  handle: string;
  direction: 'input' | 'output';
  payloads: readonly BoardSemanticPayload[];
  role: string;
  required: boolean;
  min: number;
  /** null means the selected model supplies the maximum. */
  max: number | null;
  dynamic: boolean;
}

export interface BoardNodeSpec {
  type: BoardNodeType;
  version: typeof BOARD_NODE_VERSION;
  operation: string;
  dataSchema: z.ZodTypeAny;
  defaultData: Readonly<Record<string, unknown>>;
  settingsSchema: z.ZodTypeAny | null;
  settingsDefaults: Readonly<Record<string, unknown>>;
  modelPredicate:
    | ((data: Record<string, unknown>, model: BoardModelLike | undefined) => BoardModelResult)
    | null;
  requestCompiler: ((input: BoardGenerationCompileInput) => BoardGenerationCompileResult) | null;
  inputPorts: (data: Record<string, unknown>) => readonly BoardPortSpec[];
  outputPorts: (data: Record<string, unknown>) => readonly BoardPortSpec[];
}

const noPorts = () => [] as const;
const noSettings = Object.freeze({});
const textOutput: BoardPortSpec = {
  key: 'text',
  handle: 'text',
  direction: 'output',
  payloads: ['text.prompt'],
  role: 'Generation prompt text',
  required: false,
  min: 0,
  max: null,
  dynamic: false,
};

function generateInputPorts(data: Record<string, unknown>): readonly BoardPortSpec[] {
  const video = data.mode !== 'image';
  return [
    {
      key: 'prompt',
      handle: 'prompt',
      direction: 'input',
      payloads: ['text.prompt'],
      role: 'Generation prompt',
      required: false,
      min: 0,
      max: 1,
      dynamic: false,
    },
    {
      key: 'references',
      handle: 'images[i]',
      direction: 'input',
      payloads: video
        ? [
            'image.reference',
            'image.generated',
            'image.frame.first',
            'image.frame.last',
            'video.motionReference',
            'cast.identityPack',
            'cast.locationPack',
          ]
        : ['image.reference', 'image.generated', 'cast.identityPack', 'cast.locationPack'],
      role: video ? 'Model-defined frame/reference input' : 'Model-defined image reference input',
      required: false,
      min: 0,
      max: null,
      dynamic: true,
    },
    {
      key: 'reference-images',
      handle: 'referenceImages[i]',
      direction: 'input',
      payloads: video
        ? [
            'image.reference',
            'image.generated',
            'video.motionReference',
            'cast.identityPack',
            'cast.locationPack',
          ]
        : [],
      role: 'Generic reference input separate from explicit frame slots',
      required: false,
      min: 0,
      max: null,
      dynamic: true,
    },
  ];
}

function generateOutputPorts(data: Record<string, unknown>): readonly BoardPortSpec[] {
  const video = data.mode !== 'image';
  return [
    {
      key: 'out',
      handle: 'out',
      direction: 'output',
      payloads: [video ? 'video.generated' : 'image.generated'],
      role: video ? 'Generated video asset' : 'Generated image asset',
      required: false,
      min: 0,
      max: null,
      dynamic: false,
    },
  ];
}

export const BOARD_NODE_REGISTRY: Readonly<Record<BoardNodeType, BoardNodeSpec>> = {
  prompt: {
    type: 'prompt',
    version: BOARD_NODE_VERSION,
    operation: 'Persist editable generation-prompt text.',
    dataSchema: boardPromptDataSchema,
    defaultData: Object.freeze({ text: '' }),
    settingsSchema: null,
    settingsDefaults: noSettings,
    modelPredicate: null,
    requestCompiler: null,
    inputPorts: noPorts,
    outputPorts: () => [textOutput],
  },
  aiprompt: {
    type: 'aiprompt',
    version: BOARD_NODE_VERSION,
    operation: 'Draft generation-prompt text from a brief.',
    dataSchema: boardAiPromptDataSchema,
    defaultData: Object.freeze({
      brief: '',
      model: 'claude',
      mode: 'video',
      status: 'idle',
      view: 'brief',
    }),
    settingsSchema: null,
    settingsDefaults: noSettings,
    modelPredicate: null,
    requestCompiler: null,
    inputPorts: () => [
      {
        key: 'scene',
        handle: 'scene',
        direction: 'input',
        payloads: ['scene.context'],
        role: 'Scene context',
        required: false,
        min: 0,
        max: 1,
        dynamic: false,
      },
    ],
    outputPorts: () => [textOutput],
  },
  note: {
    type: 'note',
    version: BOARD_NODE_VERSION,
    operation: 'Persist a non-executable canvas annotation.',
    dataSchema: boardNoteDataSchema,
    defaultData: Object.freeze({ text: '' }),
    settingsSchema: null,
    settingsDefaults: noSettings,
    modelPredicate: null,
    requestCompiler: null,
    inputPorts: noPorts,
    outputPorts: noPorts,
  },
  text: {
    type: 'text',
    version: BOARD_NODE_VERSION,
    operation: 'Persist a lightweight non-executable text annotation.',
    dataSchema: boardTextDataSchema,
    defaultData: Object.freeze({ text: '', size: 'm' }),
    settingsSchema: null,
    settingsDefaults: noSettings,
    modelPredicate: null,
    requestCompiler: null,
    inputPorts: noPorts,
    outputPorts: noPorts,
  },
  frame: {
    type: 'frame',
    version: BOARD_NODE_VERSION,
    operation: 'Group board nodes without entering generation execution.',
    dataSchema: boardFrameDataSchema,
    defaultData: Object.freeze({ title: 'Рамка' }),
    settingsSchema: null,
    settingsDefaults: noSettings,
    modelPredicate: null,
    requestCompiler: null,
    inputPorts: noPorts,
    outputPorts: noPorts,
  },
  scene: {
    type: 'scene',
    version: BOARD_NODE_VERSION,
    operation: 'Hold one non-executable screenplay scene and its source provenance.',
    dataSchema: boardSceneDataSchema,
    defaultData: Object.freeze({
      title: 'Сцена',
      synopsis: '',
      sourceText: '',
      sourceStatus: 'current',
      collapsed: true,
    }),
    settingsSchema: null,
    settingsDefaults: noSettings,
    modelPredicate: null,
    requestCompiler: null,
    inputPorts: noPorts,
    outputPorts: () => [
      {
        key: 'context',
        handle: 'context',
        direction: 'output',
        payloads: ['scene.context'],
        role: 'Scene context snapshot',
        required: false,
        min: 0,
        max: null,
        dynamic: false,
      },
    ],
  },
  media: {
    type: 'media',
    version: BOARD_NODE_VERSION,
    operation: 'Hold one image or motion-reference asset.',
    dataSchema: boardMediaDataSchema,
    defaultData: Object.freeze({ url: '', mediaKind: 'image' }),
    settingsSchema: null,
    settingsDefaults: noSettings,
    modelPredicate: null,
    requestCompiler: null,
    inputPorts: noPorts,
    outputPorts: (data) => [
      {
        key: 'out',
        handle: 'out',
        direction: 'output',
        payloads: [data.mediaKind === 'video' ? 'video.motionReference' : 'image.reference'],
        role: data.mediaKind === 'video' ? 'Motion reference' : 'Image reference',
        required: false,
        min: 0,
        max: null,
        dynamic: false,
      },
    ],
  },
  cast: {
    type: 'cast',
    version: BOARD_NODE_VERSION,
    operation: 'Hold a named object identity pack or location pack.',
    dataSchema: boardCastDataSchema,
    defaultData: Object.freeze({ castKind: 'character', name: '', imageUrls: [] }),
    settingsSchema: null,
    settingsDefaults: noSettings,
    modelPredicate: null,
    requestCompiler: null,
    inputPorts: () => [
      {
        key: 'scene',
        handle: 'scene',
        direction: 'input',
        payloads: ['scene.context'],
        role: 'Scene context',
        required: false,
        min: 0,
        max: 1,
        dynamic: false,
      },
    ],
    outputPorts: (data) => [
      {
        key: 'out',
        handle: 'out',
        direction: 'output',
        payloads: [data.castKind === 'location' ? 'cast.locationPack' : 'cast.identityPack'],
        role:
          data.castKind === 'location' ? 'Named location reference pack' : 'Named identity pack',
        required: false,
        min: 0,
        max: null,
        dynamic: false,
      },
    ],
  },
  generate: {
    type: 'generate',
    version: BOARD_NODE_VERSION,
    operation: 'Compile and execute an image or video generation job.',
    dataSchema: boardGenerateDataSchema,
    defaultData: Object.freeze({ mode: 'video', prompt: '', count: 1, status: 'idle' }),
    settingsSchema: boardGenerateSettingsSchema,
    settingsDefaults: Object.freeze({ ...BOARD_GENERATE_DEFAULTS }),
    modelPredicate: validateBoardModelForNode,
    requestCompiler: compileBoardGenerationRequest,
    inputPorts: generateInputPorts,
    outputPorts: generateOutputPorts,
  },
};

export function boardNodeDefaultData(
  type: BoardNodeType,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const spec = BOARD_NODE_REGISTRY[type];
  return spec.dataSchema.parse({ ...spec.defaultData, ...overrides }) as Record<string, unknown>;
}

function handleMatches(spec: BoardPortSpec, handle: string | null | undefined): boolean {
  if (!handle) return false;
  if (!spec.dynamic) return handle === spec.handle;
  if (spec.handle === 'images[i]') return handle === 'images' || /^images\[\d+\]$/.test(handle);
  if (spec.handle === 'referenceImages[i]') return /^referenceImages\[\d+\]$/.test(handle);
  return false;
}

export function boardOutputPort(
  node: Pick<BoardNode, 'type' | 'data'>,
  handle: string | null | undefined,
): BoardPortSpec | null {
  if (!isKnownBoardNodeType(node.type)) return null;
  const ports = BOARD_NODE_REGISTRY[node.type].outputPorts(node.data as Record<string, unknown>);
  return ports.find((port) => handleMatches(port, handle)) ?? null;
}

export function boardInputPort(
  node: Pick<BoardNode, 'type' | 'data'>,
  handle: string | null | undefined,
): BoardPortSpec | null {
  if (!isKnownBoardNodeType(node.type)) return null;
  const ports = BOARD_NODE_REGISTRY[node.type].inputPorts(node.data as Record<string, unknown>);
  return ports.find((port) => handleMatches(port, handle)) ?? null;
}

export type BoardConnectionShapeResult =
  | { ok: true; payload: BoardSemanticPayload }
  | { ok: false; reason: string };

/**
 * Registry-level semantic shape check. Model-specific role/cardinality checks
 * are intentionally the next layer: this prevents broad type confusion (for
 * example generated video masquerading as an image) without pretending every
 * video model accepts every reference kind.
 */
export function validateBoardConnectionShape(input: {
  source: Pick<BoardNode, 'type' | 'data'>;
  sourceHandle: string | null | undefined;
  target: Pick<BoardNode, 'type' | 'data'>;
  targetHandle: string | null | undefined;
}): BoardConnectionShapeResult {
  const output = boardOutputPort(input.source, input.sourceHandle);
  if (!output) return { ok: false, reason: 'У исходного узла нет такого выхода.' };
  const target = boardInputPort(input.target, input.targetHandle);
  if (!target) return { ok: false, reason: 'У целевого узла нет такого входа.' };
  const payload = output.payloads.find((candidate) => target.payloads.includes(candidate));
  if (!payload) {
    return {
      ok: false,
      reason: `Выход ${output.payloads.join('|')} несовместим со входом ${target.payloads.join('|')}.`,
    };
  }
  return { ok: true, payload };
}

export interface BoardModelLike {
  id: string;
  kind: 'image' | 'image-edit' | 'video' | 'voice';
  capabilities?: Record<string, unknown> | null;
  maxDurationSeconds?: number | null;
  maxResolution?: string | null;
}

export type BoardImageInputRole = 'none' | 'frame' | 'reference';

export interface BoardResolvedModelContract {
  id: string;
  mode: 'image' | 'video';
  sourceKind: 'image' | 'image-edit' | 'video';
  imageInput: {
    role: BoardImageInputRole;
    max: number;
    frameRoles: readonly ('first' | 'last')[];
  };
  /** Generic image references when explicit frame slots are also available. */
  referenceImageMax: number;
  videoReferenceMax: number;
  audioReferenceMax: number;
  output: 'image.generated' | 'video.generated';
  outputFormat: 'raster' | 'vector' | 'video';
  /** The model's output can contain generated audio, whether optional or fixed. */
  audioOutput: boolean;
  /** Board may explicitly enable/disable generated audio for this route. */
  generateAudio: boolean;
  negativePrompt: boolean;
  /** Fields inferred for a legacy/incomplete capability bag. */
  inferred: readonly string[];
}

function capabilityRecord(model: BoardModelLike): Record<string, unknown> {
  return (model.capabilities ?? {}) as Record<string, unknown>;
}

/**
 * The rung a request gets, decided once for Boards and /generate.
 *
 * Precedence: an explicit pick the model actually offers → the model's SIGNED
 * `default_resolution` → the surface's legacy default → the first offered rung.
 *
 * The signed default has to outrank the legacy one because rev. 15 overruled the legacy
 * rule outright: a model's default is its CHEAPEST rung, and that is per-model export data
 * (`ступень_по_умолчанию`), not something a single literal can express. `'2K'` for images
 * and `'720p'` for video named one rung for the whole catalogue.
 *
 * It is ONE function because it was two, and two hand-maintained copies of a rule that
 * decides what a customer is charged is a bug waiting for a quiet afternoon: flux-2-pro
 * would open at 2K/15 credits on one screen and 1K/11 on the other, and nothing would say
 * so. `generate-board-default-parity.test.ts` is what proved they agreed before this
 * collapsed them, and what keeps the two callers passing compatible inputs now.
 *
 * The offered list and the legacy default stay PARAMETERS rather than being derived here:
 * the surfaces genuinely differ. Boards renders no picker for a model that declares an
 * empty rung list (gemini-omni-flash — a fixed-output contract) while /generate shows the
 * single output it will render, and /generate's legacy image rule picks the middle entry
 * where Boards names `'2K'`, which is why an unseeded gpt-image-2 reads `medium` and not
 * `low`. Those are presentation decisions; only the precedence is shared.
 */
export function pickSignedRung<T extends string>(
  offered: readonly T[],
  capabilities: unknown,
  pick?: string | null,
  legacyDefault?: string,
): T | undefined {
  if (pick !== undefined && pick !== null && (offered as readonly string[]).includes(pick)) {
    return pick as T;
  }
  const defaultResolution =
    capabilities && typeof capabilities === 'object'
      ? (capabilities as Record<string, unknown>)['default_resolution']
      : undefined;
  if (
    typeof defaultResolution === 'string' &&
    (offered as readonly string[]).includes(defaultResolution)
  ) {
    return defaultResolution as T;
  }
  if (legacyDefault !== undefined && (offered as readonly string[]).includes(legacyDefault)) {
    return legacyDefault as T;
  }
  return offered[0];
}

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Normalize the catalog's current capability bags into the one contract Boards
 * consumes. Explicit frame metadata and the older `reference` boolean are
 * independent channels. Inferences are surfaced rather than hidden so BRD-3 can
 * eventually fail closed on incomplete rows.
 */
export function resolveBoardModelContract(
  model: BoardModelLike | undefined,
): BoardResolvedModelContract | null {
  if (!model || model.kind === 'voice') return null;
  const capabilities = capabilityRecord(model);
  const inferred: string[] = [];

  if (model.kind === 'image' || model.kind === 'image-edit') {
    const acceptsReferences =
      model.kind === 'image-edit' ||
      capabilities['reference'] === true ||
      capabilities['edit'] === true;
    let max = positiveInt(capabilities['maxRefs']);
    if (max === null) {
      if (!acceptsReferences) max = 0;
      else if (capabilities['multi_image'] === true) max = 14;
      else max = 1;
      inferred.push('imageInput.max');
    }
    const passthrough = capabilities['passthrough'];
    return {
      id: model.id,
      mode: 'image',
      sourceKind: model.kind,
      imageInput: { role: max > 0 ? 'reference' : 'none', max, frameRoles: [] },
      referenceImageMax: 0,
      videoReferenceMax: 0,
      audioReferenceMax: 0,
      output: 'image.generated',
      outputFormat: capabilities['vector'] === true ? 'vector' : 'raster',
      audioOutput: false,
      generateAudio: false,
      negativePrompt:
        capabilities['negativePrompt'] === true ||
        (Array.isArray(passthrough) && passthrough.includes('negative_prompt')),
      inferred,
    };
  }

  const frames = capabilities['frames'];
  const frameRoles = Array.isArray(frames)
    ? frames.filter((value): value is 'first' | 'last' => value === 'first' || value === 'last')
    : null;
  let imageRole: BoardImageInputRole;
  let imageMax: number;
  let resolvedFrames: readonly ('first' | 'last')[];
  const acceptsReferences = capabilities['reference'] === true || /reference/i.test(model.id);
  // Gemini Omni has no maxRefs seed value. Its reference count is UNVERIFIED;
  // retain the established fallback until the provider documents a limit.
  const referenceImageMax =
    acceptsReferences && frameRoles !== null ? (positiveInt(capabilities['maxRefs']) ?? 9) : 0;
  let videoReferenceMax = 0;
  let audioReferenceMax = 0;
  if (frameRoles !== null) {
    imageRole = frameRoles.length > 0 ? 'frame' : 'none';
    imageMax = frameRoles.length;
    resolvedFrames = frameRoles;
  } else if (acceptsReferences) {
    imageRole = 'reference';
    imageMax = positiveInt(capabilities['maxRefs']) ?? 9;
    videoReferenceMax = positiveInt(capabilities['maxVideoRefs']) ?? 3;
    audioReferenceMax = positiveInt(capabilities['maxAudioRefs']) ?? 3;
    resolvedFrames = [];
    // Gemini Omni's documented plural image_urls has no maximum. Its established
    // Board fallback remains usable, but stays marked UNVERIFIED in the seed/route.
    if (positiveInt(capabilities['maxRefs']) === null && model.id !== 'gemini-omni-flash') {
      inferred.push('imageInput.max');
    }
    if (positiveInt(capabilities['maxVideoRefs']) === null) inferred.push('videoReferenceMax');
    if (positiveInt(capabilities['maxAudioRefs']) === null) inferred.push('audioReferenceMax');
  } else {
    // Legacy Seedance rows predate explicit frames metadata but the adapters
    // have always accepted first+last frames.
    imageRole = 'frame';
    imageMax = 2;
    resolvedFrames = ['first', 'last'];
    inferred.push('imageInput.role', 'imageInput.max');
  }

  if (acceptsReferences && frameRoles !== null) {
    videoReferenceMax = positiveInt(capabilities['maxVideoRefs']) ?? 3;
    audioReferenceMax = positiveInt(capabilities['maxAudioRefs']) ?? 3;
    if (positiveInt(capabilities['maxRefs']) === null) inferred.push('referenceImageMax');
    if (positiveInt(capabilities['maxVideoRefs']) === null) inferred.push('videoReferenceMax');
    if (positiveInt(capabilities['maxAudioRefs']) === null) inferred.push('audioReferenceMax');
  }

  const passthrough = capabilities['passthrough'];
  const audioOutput = capabilities['audio'] === true;
  return {
    id: model.id,
    mode: 'video',
    sourceKind: 'video',
    imageInput: { role: imageRole, max: imageMax, frameRoles: resolvedFrames },
    referenceImageMax,
    videoReferenceMax,
    audioReferenceMax,
    output: 'video.generated',
    outputFormat: 'video',
    audioOutput,
    generateAudio: audioOutput && capabilities['audioControl'] !== false,
    negativePrompt:
      capabilities['negativePrompt'] === true ||
      (Array.isArray(passthrough) && passthrough.includes('negative_prompt')),
    inferred,
  };
}

export type BoardModelResult =
  | { ok: true; model: BoardResolvedModelContract }
  | { ok: false; reason: string };

/** Node-level model predicate used by the registry, connection validator, and compiler. */
export function validateBoardModelForNode(
  data: Record<string, unknown>,
  candidate: BoardModelLike | undefined,
): BoardModelResult {
  const model = resolveBoardModelContract(candidate);
  if (!model) return { ok: false, reason: 'Для кадра не выбрана доступная модель.' };
  if (typeof data.modelId === 'string' && data.modelId.length > 0 && data.modelId !== model.id) {
    return {
      ok: false,
      reason: `Выбранная модель ${data.modelId} недоступна; замена на ${model.id} не применена.`,
    };
  }
  const mode = data.mode === 'image' ? 'image' : 'video';
  if (model.mode !== mode) {
    return { ok: false, reason: `Модель ${model.id} не поддерживает режим «${mode}».` };
  }
  return { ok: true, model };
}

export function boardReferenceInputCapacity(model: BoardResolvedModelContract | null): number {
  if (!model) return 0;
  return Math.max(model.imageInput.max, model.referenceImageMax, model.videoReferenceMax);
}

const BOARD_DURATION_MIN = 4;
const BOARD_DURATION_MAX = 15;

export interface BoardResolvedVideoSettings {
  durationSeconds: number;
  videoResolution: (typeof BOARD_VIDEO_RESOLUTIONS)[number];
  videoAspect: (typeof BOARD_VIDEO_ASPECTS)[number];
  generateAudio: boolean;
}

export interface BoardResolvedImageSettings {
  imageAspect: (typeof BOARD_IMAGE_ASPECTS)[number];
  imageQuality: (typeof BOARD_IMAGE_QUALITIES)[number];
}

function capabilityStrings(model: BoardModelLike | undefined, key: string): string[] | null {
  const value = model ? capabilityRecord(model)[key] : undefined;
  if (!Array.isArray(value)) return null;
  const strings = value.filter(
    (candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0,
  );
  return strings.length > 0 ? strings : null;
}

/** Unlike capabilityStrings, an explicit empty array is meaningful here: the
 * model intentionally exposes no control for this setting. */
function declaredCapabilityStrings(
  model: BoardModelLike | undefined,
  key: string,
): string[] | null {
  const value = model ? capabilityRecord(model)[key] : undefined;
  if (!Array.isArray(value)) return null;
  return value.filter(
    (candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0,
  );
}

function capabilityNumbers(model: BoardModelLike | undefined, key: string): number[] | null {
  const value = model ? capabilityRecord(model)[key] : undefined;
  if (!Array.isArray(value)) return null;
  const numbers = value.filter(
    (candidate): candidate is number =>
      typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0,
  );
  return numbers.length > 0 ? numbers : null;
}

export function boardVideoDurationsFor(model: BoardModelLike | undefined): number[] | null {
  return capabilityNumbers(model, 'durations');
}

export function boardVideoResolutionsFor(
  model: BoardModelLike | undefined,
): (typeof BOARD_VIDEO_RESOLUTIONS)[number][] {
  const declared = declaredCapabilityStrings(model, 'resolutions');
  if (declared === null) return [...BOARD_VIDEO_RESOLUTIONS];
  return declared.filter((value): value is (typeof BOARD_VIDEO_RESOLUTIONS)[number] =>
    (BOARD_VIDEO_RESOLUTIONS as readonly string[]).includes(value),
  );
}

export function boardVideoAspectsFor(
  model: BoardModelLike | undefined,
): (typeof BOARD_VIDEO_ASPECTS)[number][] {
  const declared = declaredCapabilityStrings(model, 'aspect_ratios');
  if (declared === null) return BOARD_VIDEO_ASPECTS.filter((value) => value !== 'adaptive');
  const supported = declared.filter((value): value is (typeof BOARD_VIDEO_ASPECTS)[number] =>
    (BOARD_VIDEO_ASPECTS as readonly string[]).includes(value),
  );
  return [...new Set(supported)];
}

export function boardImageAspectsFor(
  model: BoardModelLike | undefined,
): (typeof BOARD_IMAGE_ASPECTS)[number][] {
  const declared = declaredCapabilityStrings(model, 'aspect_ratios');
  if (declared === null) return [...BOARD_IMAGE_ASPECTS];
  return declared.filter((value): value is (typeof BOARD_IMAGE_ASPECTS)[number] =>
    (BOARD_IMAGE_ASPECTS as readonly string[]).includes(value),
  );
}

export function boardImageQualitiesFor(
  model: BoardModelLike | undefined,
): (typeof BOARD_IMAGE_QUALITIES)[number][] {
  const declared = declaredCapabilityStrings(model, 'resolutions');
  if (declared === null) return [...BOARD_IMAGE_QUALITIES];
  return declared.filter((value): value is (typeof BOARD_IMAGE_QUALITIES)[number] =>
    (BOARD_IMAGE_QUALITIES as readonly string[]).includes(value),
  );
}

function snapBoardDuration(requested: number, supported: number[]): number {
  const sorted = [...supported].sort((left, right) => left - right);
  const atOrBelow = sorted.filter((duration) => duration <= requested);
  return atOrBelow.length > 0 ? atOrBelow[atOrBelow.length - 1]! : sorted[0]!;
}

export function resolveBoardVideoSettings(
  data: Pick<
    BoardGenerateData,
    'durationSeconds' | 'videoResolution' | 'videoAspect' | 'generateAudio'
  >,
  candidate: BoardModelLike | undefined,
): BoardResolvedVideoSettings {
  const durations = boardVideoDurationsFor(candidate);
  const ceiling =
    candidate?.maxDurationSeconds && candidate.maxDurationSeconds > 0
      ? candidate.maxDurationSeconds
      : BOARD_DURATION_MAX;
  const requested =
    typeof data.durationSeconds === 'number'
      ? Math.round(data.durationSeconds)
      : BOARD_GENERATE_DEFAULTS.durationSeconds;
  const floor = Math.min(BOARD_DURATION_MIN, ceiling);
  let durationSeconds = Math.max(floor, Math.min(ceiling, requested));
  if (durations?.length) durationSeconds = snapBoardDuration(durationSeconds, durations);

  const resolutions = boardVideoResolutionsFor(candidate);
  const aspects = boardVideoAspectsFor(candidate);
  const model = resolveBoardModelContract(candidate);
  return {
    durationSeconds,
    videoResolution:
      pickSignedRung(
        resolutions,
        candidate?.capabilities,
        data.videoResolution,
        BOARD_GENERATE_DEFAULTS.videoResolution,
      ) ?? BOARD_GENERATE_DEFAULTS.videoResolution,
    videoAspect: aspects.includes(data.videoAspect!)
      ? data.videoAspect!
      : aspects.includes(BOARD_GENERATE_DEFAULTS.videoAspect)
        ? BOARD_GENERATE_DEFAULTS.videoAspect
        : (aspects[0] ?? BOARD_GENERATE_DEFAULTS.videoAspect),
    generateAudio:
      model?.generateAudio === false
        ? false
        : typeof data.generateAudio === 'boolean'
          ? data.generateAudio
          : BOARD_GENERATE_DEFAULTS.generateAudio,
  };
}

export function resolveBoardImageSettings(
  data: Pick<BoardGenerateData, 'imageAspect' | 'imageQuality'>,
  candidate?: BoardModelLike,
): BoardResolvedImageSettings {
  const aspects = boardImageAspectsFor(candidate);
  const qualities = boardImageQualitiesFor(candidate);
  return {
    imageAspect: aspects.includes(data.imageAspect!)
      ? data.imageAspect!
      : aspects.includes(BOARD_GENERATE_DEFAULTS.imageAspect)
        ? BOARD_GENERATE_DEFAULTS.imageAspect
        : (aspects[0] ?? BOARD_GENERATE_DEFAULTS.imageAspect),
    imageQuality:
      pickSignedRung(
        qualities,
        candidate?.capabilities,
        data.imageQuality,
        BOARD_GENERATE_DEFAULTS.imageQuality,
      ) ?? BOARD_GENERATE_DEFAULTS.imageQuality,
  };
}

export type BoardGenerateSettingField =
  | 'modelId'
  | 'durationSeconds'
  | 'videoResolution'
  | 'videoAspect'
  | 'generateAudio'
  | 'imageAspect'
  | 'imageQuality';

export interface BoardGenerateSettingIssue {
  field: BoardGenerateSettingField;
  reason: string;
  current: unknown;
  replacement?: unknown;
  remove?: boolean;
}

/** Explicit saved values that the selected model would otherwise normalize or ignore. */
export function boardGenerateSettingIssues(
  data: BoardGenerateData,
  candidate: BoardModelLike | undefined,
): BoardGenerateSettingIssue[] {
  const modelResult = validateBoardModelForNode(data as Record<string, unknown>, candidate);
  if (!modelResult.ok) {
    return [{ field: 'modelId', reason: modelResult.reason, current: data.modelId ?? null }];
  }
  const model = modelResult.model;
  if (data.mode === 'image') {
    const resolved = resolveBoardImageSettings(data, candidate);
    const aspects = boardImageAspectsFor(candidate);
    const qualities = boardImageQualitiesFor(candidate);
    const issues: BoardGenerateSettingIssue[] = [];
    if (data.imageAspect !== undefined) {
      if (aspects.length === 0) {
        issues.push({
          field: 'imageAspect',
          reason: `Модель ${model.id} сама определяет формат изображения.`,
          current: data.imageAspect,
          remove: true,
        });
      } else if (data.imageAspect !== resolved.imageAspect) {
        issues.push({
          field: 'imageAspect',
          reason: `Модель ${model.id} не поддерживает формат ${data.imageAspect}; доступное значение — ${resolved.imageAspect}.`,
          current: data.imageAspect,
          replacement: resolved.imageAspect,
        });
      }
    }
    if (data.imageQuality !== undefined) {
      if (qualities.length === 0) {
        issues.push({
          field: 'imageQuality',
          reason: `Модель ${model.id} использует фиксированное разрешение.`,
          current: data.imageQuality,
          remove: true,
        });
      } else if (data.imageQuality !== resolved.imageQuality) {
        issues.push({
          field: 'imageQuality',
          reason: `Модель ${model.id} не поддерживает ${data.imageQuality}; доступное значение — ${resolved.imageQuality}.`,
          current: data.imageQuality,
          replacement: resolved.imageQuality,
        });
      }
    }
    return issues;
  }

  const resolved = resolveBoardVideoSettings(data, candidate);
  const resolutions = boardVideoResolutionsFor(candidate);
  const aspects = boardVideoAspectsFor(candidate);
  const issues: BoardGenerateSettingIssue[] = [];
  if (data.durationSeconds !== undefined && data.durationSeconds !== resolved.durationSeconds) {
    issues.push({
      field: 'durationSeconds',
      reason: `Модель ${model.id} использует длительность ${resolved.durationSeconds} с вместо ${data.durationSeconds} с.`,
      current: data.durationSeconds,
      replacement: resolved.durationSeconds,
    });
  }
  if (data.videoResolution !== undefined) {
    if (resolutions.length === 0) {
      issues.push({
        field: 'videoResolution',
        reason: `Модель ${model.id} сама определяет разрешение видео.`,
        current: data.videoResolution,
        remove: true,
      });
    } else if (data.videoResolution !== resolved.videoResolution) {
      issues.push({
        field: 'videoResolution',
        reason: `Модель ${model.id} не поддерживает ${data.videoResolution}; ближайшее доступное значение — ${resolved.videoResolution}.`,
        current: data.videoResolution,
        replacement: resolved.videoResolution,
      });
    }
  }
  if (data.videoAspect !== undefined) {
    if (aspects.length === 0) {
      issues.push({
        field: 'videoAspect',
        reason: `Модель ${model.id} сама определяет формат видео.`,
        current: data.videoAspect,
        remove: true,
      });
    } else if (data.videoAspect !== 'adaptive' && data.videoAspect !== resolved.videoAspect) {
      issues.push({
        field: 'videoAspect',
        reason: `Модель ${model.id} не поддерживает формат ${data.videoAspect}; доступное значение — ${resolved.videoAspect}.`,
        current: data.videoAspect,
        replacement: resolved.videoAspect,
      });
    }
  }
  if (
    !model.generateAudio &&
    (model.audioOutput ? data.generateAudio !== undefined : data.generateAudio === true)
  ) {
    issues.push({
      field: 'generateAudio',
      reason: model.audioOutput
        ? `Модель ${model.id} сама определяет звук; переключатель не поддерживается.`
        : `Модель ${model.id} не генерирует звук.`,
      current: data.generateAudio,
      ...(model.audioOutput ? { remove: true } : { replacement: false }),
    });
  }
  return issues;
}

export function boardGenerateSettingsPatch(
  issues: readonly BoardGenerateSettingIssue[],
): Partial<BoardGenerateData> {
  const patch: Partial<BoardGenerateData> = {};
  for (const issue of issues) {
    switch (issue.field) {
      case 'durationSeconds':
        if (typeof issue.replacement === 'number') patch.durationSeconds = issue.replacement;
        break;
      case 'videoResolution':
        if (issue.remove) patch.videoResolution = undefined;
        else if (
          typeof issue.replacement === 'string' &&
          (BOARD_VIDEO_RESOLUTIONS as readonly string[]).includes(issue.replacement)
        ) {
          patch.videoResolution = issue.replacement as NonNullable<
            BoardGenerateData['videoResolution']
          >;
        }
        break;
      case 'videoAspect':
        if (issue.remove) patch.videoAspect = undefined;
        else if (
          typeof issue.replacement === 'string' &&
          (BOARD_VIDEO_ASPECTS as readonly string[]).includes(issue.replacement)
        ) {
          patch.videoAspect = issue.replacement as NonNullable<BoardGenerateData['videoAspect']>;
        }
        break;
      case 'generateAudio':
        if (issue.remove) patch.generateAudio = undefined;
        else if (typeof issue.replacement === 'boolean') patch.generateAudio = issue.replacement;
        break;
      case 'imageAspect':
        if (issue.remove) patch.imageAspect = undefined;
        else if (
          typeof issue.replacement === 'string' &&
          (BOARD_IMAGE_ASPECTS as readonly string[]).includes(issue.replacement)
        ) {
          patch.imageAspect = issue.replacement as NonNullable<BoardGenerateData['imageAspect']>;
        }
        break;
      case 'imageQuality':
        if (issue.remove) patch.imageQuality = undefined;
        else if (
          typeof issue.replacement === 'string' &&
          (BOARD_IMAGE_QUALITIES as readonly string[]).includes(issue.replacement)
        ) {
          patch.imageQuality = issue.replacement as NonNullable<BoardGenerateData['imageQuality']>;
        }
        break;
      case 'modelId':
        break;
    }
  }
  return patch;
}

export interface BoardGenerationCompileInput {
  data: BoardGenerateData;
  model: BoardModelLike | undefined;
  prompt: string;
  imageUrls?: readonly string[];
  frameImages?: readonly BoardCompiledFrameImage[];
  videoUrls?: readonly string[];
  audioUrls?: readonly string[];
}

export interface BoardGenerationOutputContract {
  payload: 'image.generated' | 'video.generated';
  format: 'raster' | 'vector' | 'video';
}

export interface BoardCompiledGenerationRequest {
  modelId: string;
  prompt: string;
  params: Record<string, unknown>;
}

export interface BoardCompiledFrameImage {
  role: 'first' | 'last';
  url: string;
}

const boardCompiledShotGrammarSchema = z
  .object({
    size: boundedString(32).optional(),
    moves: z.array(boundedString(32)).max(3).optional(),
    lens: boundedString(32).optional(),
    light: boundedString(32).optional(),
    colorTemp: boundedString(32).optional(),
    genre: boundedString(32).optional(),
    energy: boundedString(32).optional(),
  })
  .strict();

const compiledUrlArray = z.array(urlSlotSchema).max(BOARD_LIMITS.castImages * 4);

export const boardCompiledFrameImageSchema = z
  .object({
    role: z.enum(['first', 'last']),
    url: urlSlotSchema.min(1),
  })
  .strict();

export const boardCompiledFrameImagesSchema = z
  .array(boardCompiledFrameImageSchema)
  .max(2)
  .superRefine((frames, ctx) => {
    const roles = frames.map((frame) => frame.role);
    if (new Set(roles).size !== roles.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate frame role' });
    }
  });

export const boardCompiledImageParamsSchema = z
  .object({
    aspect_ratio: z.enum(BOARD_IMAGE_ASPECTS).optional(),
    resolution: z.enum(BOARD_IMAGE_QUALITIES).optional(),
    n: z.number().int().min(1).max(BOARD_LIMITS.takes),
    imageUrls: compiledUrlArray.optional(),
    shotGrammar: boardCompiledShotGrammarSchema.optional(),
  })
  .strict();

export const boardCompiledVideoParamsSchema = z
  .object({
    duration_seconds: z.number().int().min(1).max(120),
    resolution: z.enum(BOARD_VIDEO_RESOLUTIONS).optional(),
    aspect_ratio: z.enum(BOARD_VIDEO_ASPECTS).optional(),
    generate_audio: z.boolean().optional(),
    return_last_frame: z.literal(true),
    imageUrls: compiledUrlArray.optional(),
    frameImages: boardCompiledFrameImagesSchema.optional(),
    videoUrls: compiledUrlArray.optional(),
    audioUrls: compiledUrlArray.optional(),
    shotGrammar: boardCompiledShotGrammarSchema.optional(),
  })
  .strict();

export const boardCompiledGenerationRequestSchema = z
  .object({
    modelId: boundedString(BOARD_LIMITS.modelId).min(1),
    prompt: boundedString(BOARD_LIMITS.text).min(1),
    params: z.record(z.unknown()),
  })
  .strict();

export type BoardCompiledRequestValidationResult =
  | {
      ok: true;
      request: BoardCompiledGenerationRequest;
      model: BoardResolvedModelContract;
    }
  | { ok: false; reason: string; field?: string };

/** Metadata required before a catalog row may be quoted or submitted by Boards. */
export function boardModelMetadataIssues(model: BoardModelLike | undefined): string[] {
  const resolved = resolveBoardModelContract(model);
  if (!resolved || !model) return ['model.kind'];
  const capabilities = capabilityRecord(model);
  const issues = [...resolved.inferred];
  if (resolved.mode === 'video') {
    if (!capabilityNumbers(model, 'durations')) issues.push('capabilities.durations');
    const resolutions = capabilities['resolutions'];
    if (
      !Array.isArray(resolutions) ||
      resolutions.some(
        (value) =>
          typeof value !== 'string' ||
          !(BOARD_VIDEO_RESOLUTIONS as readonly string[]).includes(value),
      )
    ) {
      issues.push('capabilities.resolutions');
    }
    const aspects = capabilities['aspect_ratios'];
    if (
      !Array.isArray(aspects) ||
      aspects.some(
        (value) =>
          typeof value !== 'string' || !(BOARD_VIDEO_ASPECTS as readonly string[]).includes(value),
      )
    ) {
      issues.push('capabilities.aspect_ratios');
    }
    if (typeof capabilities['audio'] !== 'boolean') issues.push('capabilities.audio');
    if (
      capabilities['audioControl'] !== undefined &&
      typeof capabilities['audioControl'] !== 'boolean'
    ) {
      issues.push('capabilities.audioControl');
    }
  } else {
    if (positiveInt(capabilities['maxRefs']) === null) issues.push('capabilities.maxRefs');
    const resolutions = capabilities['resolutions'];
    if (
      !Array.isArray(resolutions) ||
      resolutions.some(
        (value) =>
          typeof value !== 'string' ||
          !(BOARD_IMAGE_QUALITIES as readonly string[]).includes(value),
      )
    ) {
      issues.push('capabilities.resolutions');
    }
    const aspects = capabilities['aspect_ratios'];
    if (
      !Array.isArray(aspects) ||
      aspects.some(
        (value) =>
          typeof value !== 'string' || !(BOARD_IMAGE_ASPECTS as readonly string[]).includes(value),
      )
    ) {
      issues.push('capabilities.aspect_ratios');
    }
  }
  return [...new Set(issues)];
}

export function isBoardModelCatalogComplete(model: BoardModelLike | undefined): boolean {
  return boardModelMetadataIssues(model).length === 0;
}

/**
 * Revalidate a client-compiled Board request against the selected catalog row.
 * Strict parameter objects make unsupported controls fail before a provider
 * adapter can clamp, truncate, or ignore them.
 */
export function validateBoardCompiledGenerationRequest(
  input: unknown,
  candidate: BoardModelLike | undefined,
): BoardCompiledRequestValidationResult {
  const outer = boardCompiledGenerationRequestSchema.safeParse(input);
  if (!outer.success) {
    return { ok: false, reason: 'Запрос кадра не соответствует общей схеме.', field: 'request' };
  }
  const modelResult = validateBoardModelForNode(
    {
      mode: candidate?.kind === 'video' ? 'video' : 'image',
      modelId: outer.data.modelId,
    },
    candidate,
  );
  if (!modelResult.ok) return modelResult;
  const metadataIssues = boardModelMetadataIssues(candidate);
  if (metadataIssues.length > 0) {
    return {
      ok: false,
      reason: `Модель ${modelResult.model.id} не готова для Boards: ${metadataIssues.join(', ')}.`,
      field: 'model',
    };
  }

  const parsedParams =
    modelResult.model.mode === 'video'
      ? boardCompiledVideoParamsSchema.safeParse(outer.data.params)
      : boardCompiledImageParamsSchema.safeParse(outer.data.params);
  if (!parsedParams.success) {
    return {
      ok: false,
      reason: 'Параметры кадра не соответствуют контракту выбранной модели.',
      field: 'params',
    };
  }
  const params = parsedParams.data as Record<string, unknown>;
  const imageUrls = cleanBoardUrls(params['imageUrls'] as string[] | undefined);
  const frameImages = cleanBoardFrameImages(
    params['frameImages'] as BoardCompiledFrameImage[] | undefined,
  );
  const videoUrls = cleanBoardUrls(params['videoUrls'] as string[] | undefined);
  const audioUrls = cleanBoardUrls(params['audioUrls'] as string[] | undefined);
  const normalizedParams = { ...params };
  for (const [key, urls] of [
    ['imageUrls', imageUrls],
    ['videoUrls', videoUrls],
    ['audioUrls', audioUrls],
  ] as const) {
    if (urls.length > 0) normalizedParams[key] = urls;
    else delete normalizedParams[key];
  }
  if (frameImages.length > 0) normalizedParams['frameImages'] = frameImages;
  else delete normalizedParams['frameImages'];
  const imageReferenceMax =
    modelResult.model.referenceImageMax > 0
      ? modelResult.model.referenceImageMax
      : modelResult.model.imageInput.max;
  if (imageUrls.length > imageReferenceMax) {
    return {
      ok: false,
      reason: `Модель ${modelResult.model.id} принимает не больше ${imageReferenceMax} изображений.`,
      field: 'imageUrls',
    };
  }
  if (videoUrls.length > modelResult.model.videoReferenceMax) {
    return {
      ok: false,
      reason: `Модель ${modelResult.model.id} принимает не больше ${modelResult.model.videoReferenceMax} видео-референсов.`,
      field: 'videoUrls',
    };
  }
  if (audioUrls.length > modelResult.model.audioReferenceMax) {
    return {
      ok: false,
      reason: `Модель ${modelResult.model.id} принимает не больше ${modelResult.model.audioReferenceMax} аудио-референсов.`,
      field: 'audioUrls',
    };
  }

  if (modelResult.model.mode === 'video') {
    if (modelResult.model.imageInput.role === 'frame') {
      if (imageUrls.length > 0 && modelResult.model.referenceImageMax === 0) {
        return {
          ok: false,
          reason: 'Кадры должны передаваться с явной ролью first/last.',
          field: 'imageUrls',
        };
      }
      const unsupportedFrame = frameImages.find(
        (frame) => !modelResult.model.imageInput.frameRoles.includes(frame.role),
      );
      if (unsupportedFrame) {
        return {
          ok: false,
          reason: `Модель ${modelResult.model.id} не принимает роль кадра ${unsupportedFrame.role}.`,
          field: 'frameImages',
        };
      }
    } else if (frameImages.length > 0) {
      return {
        ok: false,
        reason: `Модель ${modelResult.model.id} принимает референсы без ролей first/last.`,
        field: 'frameImages',
      };
    }
  }

  if (modelResult.model.mode === 'video') {
    const video = parsedParams.data as z.infer<typeof boardCompiledVideoParamsSchema>;
    const data: BoardGenerateData = {
      mode: 'video',
      modelId: outer.data.modelId,
      prompt: '',
      count: 1,
      status: 'idle',
      durationSeconds: video.duration_seconds,
      ...(video.resolution !== undefined ? { videoResolution: video.resolution } : {}),
      ...(video.aspect_ratio !== undefined ? { videoAspect: video.aspect_ratio } : {}),
      ...(video.generate_audio !== undefined ? { generateAudio: video.generate_audio } : {}),
    };
    const issue = boardGenerateSettingIssues(data, candidate)[0];
    if (issue) return { ok: false, reason: issue.reason, field: issue.field };
    if (modelResult.model.generateAudio && video.generate_audio === undefined) {
      return {
        ok: false,
        reason: `Для модели ${modelResult.model.id} не указано, нужен ли звук.`,
        field: 'generate_audio',
      };
    }
    if (!modelResult.model.generateAudio && video.generate_audio !== undefined) {
      return {
        ok: false,
        reason: `Модель ${modelResult.model.id} не принимает настройку звука.`,
        field: 'generate_audio',
      };
    }
    const resolutions = boardVideoResolutionsFor(candidate);
    if (resolutions.length === 0 && video.resolution !== undefined) {
      return {
        ok: false,
        reason: `Модель ${modelResult.model.id} не принимает настройку разрешения.`,
        field: 'resolution',
      };
    }
    if (resolutions.length > 0 && video.resolution === undefined) {
      return {
        ok: false,
        reason: `Для модели ${modelResult.model.id} не указано разрешение видео.`,
        field: 'resolution',
      };
    }
    if (video.resolution !== undefined && !resolutions.includes(video.resolution)) {
      return {
        ok: false,
        reason: `Модель ${modelResult.model.id} не поддерживает ${video.resolution}.`,
        field: 'resolution',
      };
    }
    const aspects = boardVideoAspectsFor(candidate);
    if (aspects.length === 0 && video.aspect_ratio !== undefined) {
      return {
        ok: false,
        reason: `Модель ${modelResult.model.id} не принимает настройку формата.`,
        field: 'aspect_ratio',
      };
    }
    if (aspects.length > 0 && video.aspect_ratio === undefined) {
      return {
        ok: false,
        reason: `Для модели ${modelResult.model.id} не указан формат видео.`,
        field: 'aspect_ratio',
      };
    }
    if (video.aspect_ratio !== undefined && !aspects.includes(video.aspect_ratio)) {
      return {
        ok: false,
        reason: `Модель ${modelResult.model.id} не поддерживает формат ${video.aspect_ratio}.`,
        field: 'aspect_ratio',
      };
    }
  } else {
    const image = parsedParams.data as z.infer<typeof boardCompiledImageParamsSchema>;
    const aspects = boardImageAspectsFor(candidate);
    const qualities = boardImageQualitiesFor(candidate);
    if (aspects.length === 0 && image.aspect_ratio !== undefined) {
      return {
        ok: false,
        reason: `Модель ${modelResult.model.id} не принимает настройку формата.`,
        field: 'aspect_ratio',
      };
    }
    if (aspects.length > 0 && image.aspect_ratio === undefined) {
      return {
        ok: false,
        reason: `Для модели ${modelResult.model.id} не указан формат изображения.`,
        field: 'aspect_ratio',
      };
    }
    if (image.aspect_ratio !== undefined && !aspects.includes(image.aspect_ratio)) {
      return {
        ok: false,
        reason: `Модель ${modelResult.model.id} не поддерживает формат ${image.aspect_ratio}.`,
        field: 'aspect_ratio',
      };
    }
    if (qualities.length === 0 && image.resolution !== undefined) {
      return {
        ok: false,
        reason: `Модель ${modelResult.model.id} не принимает настройку разрешения.`,
        field: 'resolution',
      };
    }
    if (qualities.length > 0 && image.resolution === undefined) {
      return {
        ok: false,
        reason: `Для модели ${modelResult.model.id} не указано разрешение изображения.`,
        field: 'resolution',
      };
    }
    if (image.resolution !== undefined && !qualities.includes(image.resolution)) {
      return {
        ok: false,
        reason: `Модель ${modelResult.model.id} не поддерживает ${image.resolution}.`,
        field: 'resolution',
      };
    }
  }

  return {
    ok: true,
    request: { ...outer.data, params: normalizedParams },
    model: modelResult.model,
  };
}

export type BoardGenerationCompileResult =
  | {
      ok: true;
      request: BoardCompiledGenerationRequest;
      output: BoardGenerationOutputContract;
      model: BoardResolvedModelContract;
    }
  | { ok: false; reason: string; field?: string };

export type BoardGenerationQuoteResult =
  | {
      ok: true;
      request: BoardCompiledGenerationRequest;
      output: BoardGenerationOutputContract;
      model: BoardResolvedModelContract;
      units: number;
      /** Local quotes are intentionally unavailable; API estimate is authoritative. */
      cost: null;
    }
  | { ok: false; reason: string; field?: string };

function cleanBoardUrls(values: readonly string[] | undefined): string[] {
  return [
    ...new Set(
      (values ?? []).filter(
        (value): value is string => typeof value === 'string' && value.length > 0,
      ),
    ),
  ];
}

function cleanBoardFrameImages(
  values: readonly BoardCompiledFrameImage[] | undefined,
): BoardCompiledFrameImage[] {
  return (values ?? []).filter(
    (frame): frame is BoardCompiledFrameImage =>
      (frame?.role === 'first' || frame?.role === 'last') &&
      typeof frame.url === 'string' &&
      frame.url.length > 0,
  );
}

function boardShotGrammarParams(
  grammar: BoardShotGrammar | undefined,
): Record<string, string | string[]> | null {
  if (!grammar) return null;
  const result: Record<string, string | string[]> = {};
  if (grammar.size) result['size'] = grammar.size;
  if (grammar.lens) result['lens'] = grammar.lens;
  const moves = grammar.moves?.length ? grammar.moves : grammar.move ? [grammar.move] : [];
  if (moves.length) result['moves'] = moves;
  if (grammar.light) result['light'] = grammar.light;
  if (grammar.colorTemp) result['colorTemp'] = grammar.colorTemp;
  if (grammar.genre) result['genre'] = grammar.genre;
  if (grammar.energy) result['energy'] = grammar.energy;
  return Object.keys(result).length > 0 ? result : null;
}

/** Strict compiler owned by the generate-node registry entry. It never truncates inputs. */
export function compileBoardGenerationRequest(
  input: BoardGenerationCompileInput,
): BoardGenerationCompileResult {
  const parsed = boardGenerateDataSchema.safeParse(input.data);
  if (!parsed.success) {
    return { ok: false, reason: 'Настройки узла не соответствуют текущей схеме.', field: 'data' };
  }
  const data = parsed.data;
  const predicate = validateBoardModelForNode(data as Record<string, unknown>, input.model);
  if (!predicate.ok) return predicate;
  const model = predicate.model;
  const settingIssue = boardGenerateSettingIssues(data, input.model)[0];
  if (settingIssue) {
    return { ok: false, reason: settingIssue.reason, field: settingIssue.field };
  }
  const imageUrls = cleanBoardUrls(input.imageUrls);
  let frameImages = cleanBoardFrameImages(input.frameImages);
  const videoUrls = cleanBoardUrls(input.videoUrls);
  const audioUrls = cleanBoardUrls(input.audioUrls);

  const imageReferenceMax =
    model.referenceImageMax > 0 ? model.referenceImageMax : model.imageInput.max;
  if (imageUrls.length > imageReferenceMax) {
    return {
      ok: false,
      reason: `Модель ${model.id} принимает не больше ${imageReferenceMax} изображений.`,
      field: 'imageUrls',
    };
  }
  if (videoUrls.length > model.videoReferenceMax) {
    return {
      ok: false,
      reason: `Модель ${model.id} принимает не больше ${model.videoReferenceMax} видео-референсов.`,
      field: 'videoUrls',
    };
  }
  if (audioUrls.length > model.audioReferenceMax) {
    return {
      ok: false,
      reason: `Модель ${model.id} принимает не больше ${model.audioReferenceMax} аудио-референсов.`,
      field: 'audioUrls',
    };
  }

  if (model.imageInput.role === 'frame') {
    if (frameImages.length === 0 && model.referenceImageMax === 0) {
      frameImages = imageUrls.map((url, index) => ({
        role: model.imageInput.frameRoles[index]!,
        url,
      }));
    }
    if (new Set(frameImages.map((frame) => frame.role)).size !== frameImages.length) {
      return {
        ok: false,
        reason: 'Одна роль кадра подключена больше одного раза.',
        field: 'frameImages',
      };
    }
    const unsupportedFrame = frameImages.find(
      (frame) => !model.imageInput.frameRoles.includes(frame.role),
    );
    if (unsupportedFrame) {
      return {
        ok: false,
        reason: `Модель ${model.id} не принимает роль кадра ${unsupportedFrame.role}.`,
        field: 'frameImages',
      };
    }
  } else if (frameImages.length > 0) {
    return {
      ok: false,
      reason: `Модель ${model.id} принимает референсы без ролей first/last.`,
      field: 'frameImages',
    };
  }

  let params: Record<string, unknown>;
  if (data.mode === 'video') {
    const settings = resolveBoardVideoSettings(data, input.model);
    const resolutions = boardVideoResolutionsFor(input.model);
    const aspects = boardVideoAspectsFor(input.model);
    params = {
      duration_seconds: settings.durationSeconds,
      ...(resolutions.length > 0 ? { resolution: settings.videoResolution } : {}),
      ...(aspects.length > 0 ? { aspect_ratio: settings.videoAspect } : {}),
      ...(model.generateAudio ? { generate_audio: settings.generateAudio } : {}),
      return_last_frame: true,
      ...(model.imageInput.role === 'frame' && frameImages.length > 0 ? { frameImages } : {}),
      ...((model.imageInput.role === 'reference' || model.referenceImageMax > 0) &&
      imageUrls.length > 0
        ? { imageUrls }
        : {}),
      ...(videoUrls.length > 0 ? { videoUrls } : {}),
      ...(audioUrls.length > 0 ? { audioUrls } : {}),
    };
  } else {
    const settings = resolveBoardImageSettings(data, input.model);
    const aspects = boardImageAspectsFor(input.model);
    const qualities = boardImageQualitiesFor(input.model);
    params = {
      ...(aspects.length > 0 ? { aspect_ratio: settings.imageAspect } : {}),
      ...(qualities.length > 0 ? { resolution: settings.imageQuality } : {}),
      n: data.count,
      ...(imageUrls.length > 0 ? { imageUrls } : {}),
    };
  }
  const shotGrammar = boardShotGrammarParams(data.shot);
  if (shotGrammar) params['shotGrammar'] = shotGrammar;

  return {
    ok: true,
    request: { modelId: model.id, prompt: input.prompt, params },
    output: { payload: model.output, format: model.outputFormat },
    model,
  };
}

/** Compile first, validate the exact normalized request, then derive its quote. */
export function compileBoardGenerationQuote(
  input: BoardGenerationCompileInput & {
    model: BoardModelLike | undefined;
  },
): BoardGenerationQuoteResult {
  const compiled = compileBoardGenerationRequest(input);
  if (!compiled.ok) return compiled;
  const validated = validateBoardCompiledGenerationRequest(compiled.request, input.model);
  if (!validated.ok) return validated;
  const units = unitsForGenerationModel({
    kind: compiled.model.mode,
    params: validated.request.params,
    maxDurationSeconds: input.model?.maxDurationSeconds ?? null,
  });
  if (!units.ok) return { ok: false, reason: units.error, field: 'params' };
  return {
    ...compiled,
    request: validated.request,
    units: units.units,
    // Board UI fetches the authoritative server estimate. Do not fabricate a
    // local flat quote from the mutable model catalog rate.
    cost: null,
  };
}

export type BoardConnectionResult =
  | { ok: true; payload: BoardSemanticPayload; model: BoardResolvedModelContract | null }
  | { ok: false; reason: string };

/** Semantic shape + selected-model capability predicate with user-facing errors. */
export function validateBoardConnection(input: {
  source: Pick<BoardNode, 'type' | 'data'>;
  sourceHandle: string | null | undefined;
  target: Pick<BoardNode, 'type' | 'data'>;
  targetHandle: string | null | undefined;
  targetModel?: BoardModelLike | undefined;
}): BoardConnectionResult {
  const shape = validateBoardConnectionShape(input);
  if (!shape.ok) return shape;
  if (input.target.type !== 'generate') return { ok: true, payload: shape.payload, model: null };

  const targetData = input.target.data as Record<string, unknown>;
  const modelResult = BOARD_NODE_REGISTRY.generate.modelPredicate!(targetData, input.targetModel);
  if (!modelResult.ok) return modelResult;
  const model = modelResult.model;
  if (shape.payload === 'text.prompt') return { ok: true, payload: shape.payload, model };

  const referenceSlotMatch = /^referenceImages\[(\d+)\]$/.exec(input.targetHandle ?? '');
  const imageSlotMatch = /^images\[(\d+)\]$/.exec(input.targetHandle ?? '');
  const isReferenceChannel = referenceSlotMatch !== null;
  const slot =
    input.targetHandle === 'images' ? 0 : Number((referenceSlotMatch ?? imageSlotMatch)?.[1] ?? 0);
  if (shape.payload === 'video.motionReference') {
    if (model.videoReferenceMax === 0) {
      return { ok: false, reason: `Модель ${model.id} не принимает видео-референсы.` };
    }
    if (!isReferenceChannel && model.imageInput.role === 'frame') {
      return {
        ok: false,
        reason: `Вход модели ${model.id} ждёт отдельный кадр, а не видео-референс.`,
      };
    }
    if (slot >= model.videoReferenceMax) {
      return {
        ok: false,
        reason: `Модель ${model.id} принимает не больше ${model.videoReferenceMax} видео-референсов.`,
      };
    }
    return { ok: true, payload: shape.payload, model };
  }

  const imageMax = isReferenceChannel ? model.referenceImageMax : model.imageInput.max;
  if (imageMax === 0) {
    return { ok: false, reason: `Модель ${model.id} не принимает изображения на вход.` };
  }
  if (
    !isReferenceChannel &&
    model.imageInput.role === 'frame' &&
    (shape.payload === 'cast.identityPack' || shape.payload === 'cast.locationPack')
  ) {
    return {
      ok: false,
      reason: `Вход модели ${model.id} ждёт отдельный кадр, а не набор референсов.`,
    };
  }
  const sourceData = input.source.data as Record<string, unknown>;
  const expandedImages =
    shape.payload === 'cast.identityPack' || shape.payload === 'cast.locationPack'
      ? Array.isArray(sourceData.imageUrls)
        ? sourceData.imageUrls.filter((url) => typeof url === 'string' && url.length > 0).length
        : 0
      : 1;
  if (
    (shape.payload === 'cast.identityPack' || shape.payload === 'cast.locationPack') &&
    expandedImages === 0
  ) {
    return { ok: false, reason: 'В наборе референсов пока нет изображений.' };
  }
  if (expandedImages > imageMax) {
    return {
      ok: false,
      reason: `Набор содержит ${expandedImages} изображений и превышает лимит модели ${model.id}: ${imageMax}.`,
    };
  }
  if (slot >= imageMax) {
    return {
      ok: false,
      reason: `Вход ${slot + 1} выходит за лимит модели ${model.id}: ${imageMax}.`,
    };
  }
  if (
    shape.payload === 'cast.locationPack' &&
    typeof sourceData.videoUrl === 'string' &&
    sourceData.videoUrl.length > 0 &&
    model.videoReferenceMax === 0
  ) {
    return { ok: false, reason: `Модель ${model.id} не использует видео движения локации.` };
  }
  return { ok: true, payload: shape.payload, model };
}

export interface BoardConnectionCandidate {
  source: Pick<BoardNode, 'type' | 'data'>;
  sourceHandle: string | null | undefined;
  targetHandle: string | null | undefined;
}

export type BoardConnectionsResult =
  | {
      ok: true;
      model: BoardResolvedModelContract;
      imageReferences: number;
      videoReferences: number;
      audioReferences: number;
    }
  | { ok: false; reason: string };

function russianCount(count: number, one: string, few: string, many: string): string {
  const mod100 = count % 100;
  const mod10 = count % 10;
  const word =
    mod100 >= 11 && mod100 <= 14 ? many : mod10 === 1 ? one : mod10 >= 2 && mod10 <= 4 ? few : many;
  return `${count} ${word}`;
}

/** Validate a complete target input set, including expanded cast-pack cardinality. */
export function validateBoardConnections(input: {
  target: Pick<BoardNode, 'type' | 'data'>;
  targetModel: BoardModelLike | undefined;
  connections: readonly BoardConnectionCandidate[];
  requireReady?: boolean;
}): BoardConnectionsResult {
  const modelResult =
    input.target.type === 'generate'
      ? validateBoardModelForNode(input.target.data as Record<string, unknown>, input.targetModel)
      : { ok: false as const, reason: 'Целевой узел не выполняет генерацию.' };
  if (!modelResult.ok) return modelResult;
  const occupied = new Set<string>();
  const frameReferences = new Set<string>();
  const imageReferences = new Set<string>();
  const videoReferences = new Set<string>();
  const audioReferences = new Set<string>();

  for (let index = 0; index < input.connections.length; index += 1) {
    const connection = input.connections[index]!;
    const handle = connection.targetHandle ?? '';
    if (occupied.has(handle)) return { ok: false, reason: `Вход «${handle}» уже занят.` };
    occupied.add(handle);

    const result = validateBoardConnection({
      ...connection,
      target: input.target,
      targetModel: input.targetModel,
    });
    if (!result.ok) return result;
    const data = connection.source.data as Record<string, unknown>;
    if (
      input.requireReady &&
      connection.source.type === 'media' &&
      (typeof data.url !== 'string' || data.url.length === 0)
    ) {
      return { ok: false, reason: 'Подключённый медиа-узел ещё не содержит файл.' };
    }
    if (result.payload === 'video.motionReference') {
      const url = typeof data.url === 'string' && data.url.length > 0 ? data.url : `edge:${index}`;
      videoReferences.add(url);
      continue;
    }
    if (result.payload === 'text.prompt') continue;
    const isFrameChannel =
      !/^referenceImages\[\d+\]$/.test(handle) && modelResult.model.imageInput.role === 'frame';
    if (result.payload === 'cast.identityPack' || result.payload === 'cast.locationPack') {
      for (const url of Array.isArray(data.imageUrls) ? data.imageUrls : []) {
        if (typeof url === 'string' && url.length > 0) {
          if (isFrameChannel) frameReferences.add(url);
          else imageReferences.add(url);
        }
      }
      if (
        result.payload === 'cast.locationPack' &&
        typeof data.videoUrl === 'string' &&
        data.videoUrl.length > 0
      ) {
        videoReferences.add(data.videoUrl);
      }
      continue;
    }
    const url =
      typeof data.url === 'string' && data.url.length > 0
        ? data.url
        : typeof data.resultUrl === 'string' && data.resultUrl.length > 0
          ? data.resultUrl
          : `edge:${index}`;
    if (isFrameChannel) frameReferences.add(url);
    else imageReferences.add(url);
  }

  const model = modelResult.model;
  if (frameReferences.size > model.imageInput.max) {
    return {
      ok: false,
      reason: `Подключено ${russianCount(frameReferences.size, 'изображение', 'изображения', 'изображений')}; модель ${model.id} принимает ${russianCount(model.imageInput.max, 'изображение', 'изображения', 'изображений')}.`,
    };
  }
  const imageReferenceMax =
    model.referenceImageMax > 0 ? model.referenceImageMax : model.imageInput.max;
  if (imageReferences.size > imageReferenceMax) {
    return {
      ok: false,
      reason: `Подключено ${russianCount(imageReferences.size, 'изображение', 'изображения', 'изображений')}; модель ${model.id} принимает ${russianCount(imageReferenceMax, 'изображение', 'изображения', 'изображений')}.`,
    };
  }
  if (videoReferences.size > model.videoReferenceMax) {
    return {
      ok: false,
      reason: `Подключено ${russianCount(videoReferences.size, 'видео', 'видео', 'видео')}; модель ${model.id} принимает ${russianCount(model.videoReferenceMax, 'видео', 'видео', 'видео')}.`,
    };
  }
  if (audioReferences.size > model.audioReferenceMax) {
    return {
      ok: false,
      reason: `Подключено ${audioReferences.size} аудио; модель ${model.id} принимает ${model.audioReferenceMax}.`,
    };
  }
  return {
    ok: true,
    model,
    imageReferences: imageReferences.size,
    videoReferences: videoReferences.size,
    audioReferences: audioReferences.size,
  };
}

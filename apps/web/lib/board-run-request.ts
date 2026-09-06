import {
  BOARD_NODE_REGISTRY,
  boardGenerateGraphHasCycle,
  compileBoardGenerationRequest,
  validateBoardConnections,
  type BoardCompiledFrameImage,
  type BoardGenerateData,
  type BoardNode,
  type BoardNodeType,
} from '@seed/shared/board-contract';
import { resolveGeneratePrompt } from '@seed/shared/board-prompt';
import { assembleShotRefs, castPromptPrefix, type CastLike, type RefSource } from './cast';
import { buildShotPrompt, type ShotGrammar } from './film-grammar';
import { resolveProvider } from './gateway-routing';
import { imageHandleIndex, referenceImageHandleIndex } from './ref-ports';
import { defaultModelForMode, resolveModel, type ModelLike } from './node-settings';
import { modelDisplayName } from './models';
import { isModelLocked, tierUpsellLabel } from './model-tier';

export interface BoardRunNodeLike {
  id: string;
  type?: string | null | undefined;
  data: Record<string, unknown>;
}

export interface BoardRunEdgeLike {
  source: string;
  target: string;
  sourceHandle?: string | null | undefined;
  targetHandle?: string | null | undefined;
}

export type PreparedBoardRun =
  | { ok: false; reason: string; reasonCode?: 'tier_required' }
  | {
      ok: true;
      nodeId: string;
      modelLabel: string;
      request: {
        source: 'boards';
        modelId: string;
        prompt: string;
        params: Record<string, unknown>;
        provider: 'openrouter' | 'atlascloud';
      };
    };

function selectedModel(
  models: readonly ModelLike[],
  data: BoardGenerateData,
  planTier: string | null,
): ModelLike | undefined {
  const fallback =
    data.mode === 'video'
      ? defaultModelForMode([...models], 'video', 'seedance-2-0-fast', planTier)
      : defaultModelForMode([...models], 'image', 'seedream-5-0-pro', planTier);
  return resolveModel([...models], data.mode, data.modelId, fallback);
}

/** One entitlement preflight shared by mobile compilation and desktop execution. */
export function boardRunModelLocked(
  model: Pick<ModelLike, 'tierMin'> | undefined,
  planTier: string | null,
): boolean {
  return Boolean(model && isModelLocked(model, planTier));
}

/**
 * Compile one already-prepared Board shot without mutating the graph. Mobile
 * deliberately does not recurse into unfinished dependencies: graph setup and
 * multi-shot orchestration stay on desktop, while a ready shot can be reviewed
 * and launched safely from a phone.
 */
export function prepareBoardNodeRun(input: {
  nodes: readonly BoardRunNodeLike[];
  edges: readonly BoardRunEdgeLike[];
  nodeId: string;
  models: readonly ModelLike[];
  planTier: string | null;
}): PreparedBoardRun {
  const nodesById = new Map(input.nodes.map((node) => [node.id, node]));
  const node = nodesById.get(input.nodeId);
  if (!node || node.type !== 'generate') {
    return { ok: false, reason: 'Выберите кадр для запуска.' };
  }
  if (boardGenerateGraphHasCycle(input.nodes, input.edges)) {
    return { ok: false, reason: 'Граф содержит цикл. Исправьте связи на компьютере.' };
  }

  const data = node.data as unknown as BoardGenerateData;
  const model = selectedModel(input.models, data, input.planTier);
  if (!model) return { ok: false, reason: 'Для кадра нет доступной модели.' };
  if (boardRunModelLocked(model, input.planTier)) {
    return { ok: false, reason: tierUpsellLabel(model), reasonCode: 'tier_required' };
  }

  const incoming = input.edges.filter((edge) => edge.target === node.id);
  const connections = [];
  for (const edge of incoming) {
    const source = nodesById.get(edge.source);
    if (!source?.type || !(source.type in BOARD_NODE_REGISTRY)) {
      return { ok: false, reason: 'У кадра есть связь с неизвестным узлом.' };
    }
    connections.push({
      source: {
        type: source.type as BoardNodeType,
        data: source.data,
      } as Pick<BoardNode, 'type' | 'data'>,
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
    });
  }
  const semantic = validateBoardConnections({
    target: { type: 'generate', data: node.data } as Pick<BoardNode, 'type' | 'data'>,
    targetModel: model,
    connections,
    requireReady: true,
  });
  if (!semantic.ok) return { ok: false, reason: semantic.reason };

  const promptText = resolveGeneratePrompt(
    node,
    nodesById,
    incoming.map((edge) => ({ source: edge.source, targetHandle: edge.targetHandle ?? null })),
  );

  const sources: RefSource[] = [];
  const casts: CastLike[] = [];
  const frameImages: BoardCompiledFrameImage[] = [];
  const referenceEdges = incoming
    .filter(
      (edge) =>
        imageHandleIndex(edge.targetHandle) !== null ||
        referenceImageHandleIndex(edge.targetHandle) !== null,
    )
    .sort(
      (left, right) =>
        (referenceImageHandleIndex(left.targetHandle) ?? imageHandleIndex(left.targetHandle)!) -
        (referenceImageHandleIndex(right.targetHandle) ?? imageHandleIndex(right.targetHandle)!),
    );
  for (const edge of referenceEdges) {
    const source = nodesById.get(edge.source)!;
    const slot = imageHandleIndex(edge.targetHandle);
    const isReferenceChannel = referenceImageHandleIndex(edge.targetHandle) !== null;
    const frameRole =
      !isReferenceChannel && semantic.model.imageInput.role === 'frame' && slot !== null
        ? semantic.model.imageInput.frameRoles[slot]
        : undefined;
    const addImage = (url: string) => {
      if (frameRole) frameImages.push({ role: frameRole, url });
      else sources.push({ kind: 'image', url });
    };

    if (source.type === 'media') {
      const media = source.data as { mediaKind?: unknown; url?: unknown };
      if (typeof media.url !== 'string' || !media.url) continue;
      if (media.mediaKind === 'video') sources.push({ kind: 'video', url: media.url });
      else addImage(media.url);
    } else if (source.type === 'cast') {
      const cast = source.data as unknown as CastLike;
      sources.push({ kind: 'cast', cast });
      casts.push(cast);
    } else if (source.type === 'generate') {
      const upstream = source.data as unknown as BoardGenerateData & {
        resultUrl?: string | undefined;
      };
      if (upstream.status !== 'done' || !upstream.resultUrl) {
        return {
          ok: false,
          reason: 'Сначала завершите связанные предыдущие кадры на компьютере.',
        };
      }
      // the chosen take (take-strip) is what rides downstream; a generated clip
      // rides as a motion ref, a generated still as an image ref
      const upstreamKind = (upstream as { resultKind?: unknown }).resultKind;
      if (upstreamKind === 'video') sources.push({ kind: 'video', url: upstream.resultUrl });
      else addImage(upstream.resultUrl);
    }
  }

  const refs = assembleShotRefs(sources, {
    images:
      semantic.model.referenceImageMax > 0
        ? semantic.model.referenceImageMax
        : semantic.model.imageInput.max,
    videos: semantic.model.videoReferenceMax,
  });
  const shotPrompt = buildShotPrompt({
    grammar: data.shot as ShotGrammar | undefined,
    text: promptText,
  });
  const prefix = castPromptPrefix(casts);
  const finalPrompt = prefix ? `${prefix} ${shotPrompt}`.trim() : shotPrompt;
  const compiled = compileBoardGenerationRequest({
    data,
    model,
    prompt: finalPrompt || ' ',
    imageUrls: refs.imageUrls,
    frameImages,
    videoUrls: refs.videoUrls,
  });
  if (!compiled.ok) return { ok: false, reason: compiled.reason };

  const params = compiled.request.params;
  const provider = resolveProvider('auto', {
    videoUrls: params['videoUrls'] as string[] | undefined,
    audioUrls: params['audioUrls'] as string[] | undefined,
  });
  return {
    ok: true,
    nodeId: node.id,
    modelLabel: modelDisplayName(model),
    request: {
      source: 'boards',
      modelId: compiled.request.modelId,
      prompt: compiled.request.prompt,
      params,
      provider,
    },
  };
}

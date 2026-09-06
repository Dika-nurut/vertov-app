/**
 * What type of payload flows along an edge — derived from its SOURCE node's
 * output. Drives the colour-coded chip rendered at the edge midpoint
 * (Higgsfield's edge "data chip" pattern). Pure so it's unit-testable.
 */
import {
  BOARD_NODE_REGISTRY,
  boardOutputPort,
  type BoardNode,
  type BoardNodeType,
  type BoardSemanticPayload,
} from '@seed/shared/board-contract';

export type PortType = 'text' | 'image' | 'video' | 'scene';

interface NodeLike {
  type?: string | undefined;
  data: Record<string, unknown>;
}

export function edgePayloadType(
  source: NodeLike | undefined,
  sourceHandle?: string | null | undefined,
): PortType | null {
  const payload = edgeSemanticPayload(source, sourceHandle);
  if (!payload) return null;
  if (payload.startsWith('text.')) return 'text';
  if (payload.startsWith('video.')) return 'video';
  if (payload.startsWith('scene.')) return 'scene';
  return 'image';
}

/** Exact registry payload behind the broad colour chip. */
export function edgeSemanticPayload(
  source: NodeLike | undefined,
  sourceHandle?: string | null | undefined,
): BoardSemanticPayload | null {
  if (!source?.type || !(source.type in BOARD_NODE_REGISTRY)) return null;
  const type = source.type as BoardNodeType;
  const handle =
    sourceHandle ?? BOARD_NODE_REGISTRY[type].outputPorts(source.data)[0]?.handle ?? null;
  const port = boardOutputPort(
    { type, data: source.data } as Pick<BoardNode, 'type' | 'data'>,
    handle,
  );
  return port?.payloads[0] ?? null;
}

export const PAYLOAD_LABEL: Record<PortType, string> = {
  text: 'текст',
  image: 'картинка',
  video: 'видео',
  scene: 'сцена',
};

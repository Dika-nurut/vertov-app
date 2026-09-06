/**
 * Derive a linear shot list from the board graph (B-3). The graph is great for
 * construction; directors also need a scannable list — shot number, prompt,
 * cast, location, model, status, selected take — without panning the canvas.
 *
 * Pure + side-effect-free (structural node/edge shapes, not ReactFlow types) so
 * the derivation is unit-tested; the panel renders the rows and stays in sync
 * because it derives live from the same nodes/edges.
 */

import { compareBoardReadingOrder } from '@seed/shared/board-order';
import { resolveGeneratePrompt } from '@seed/shared/board-prompt';
import { shotGrammarLabel, type ShotGrammar } from './film-grammar';

export type ShotStatus = 'idle' | 'running' | 'done' | 'failed';

export interface ShotNodeLike {
  id: string;
  type?: string;
  position: { x: number; y: number };
  data?: Record<string, unknown>;
}

export interface ShotEdgeLike {
  source: string;
  target: string;
  targetHandle?: string | null;
}

export interface ShotListRow {
  id: string;
  /** 1-based reading order (top→bottom, then left→right). */
  shotNumber: number;
  title: string;
  prompt: string;
  mode: 'image' | 'video';
  modelId?: string | undefined;
  durationSeconds?: number | undefined;
  count?: number | undefined;
  status: ShotStatus;
  /** The selected/best take URL, if the shot has produced one. */
  resultUrl?: string | undefined;
  resultKind?: 'image' | 'video' | undefined;
  /** For video takes, a still (last frame) usable in a storyboard. */
  lastFrameUrl?: string | undefined;
  cast: string[];
  locations: string[];
  /** B-4: compact camera/lens/light/genre grammar label ('' when unset). */
  grammarLabel: string;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

export function deriveShotList(nodes: ShotNodeLike[], edges: ShotEdgeLike[]): ShotListRow[] {
  const generates = nodes.filter(
    (n) =>
      n.type === 'generate' &&
      !(
        typeof n.data?.['originCastNodeId'] === 'string' &&
        n.data['originCastNodeId'].trim().length > 0
      ),
  );
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const incomingEdgesByTarget = new Map<string, ShotEdgeLike[]>();
  for (const edge of edges) {
    const existing = incomingEdgesByTarget.get(edge.target);
    if (existing) existing.push(edge);
    else incomingEdgesByTarget.set(edge.target, [edge]);
  }
  // Reading order gives stable shot numbers: top-to-bottom, then left-to-right.
  const ordered = [...generates].sort(compareBoardReadingOrder);
  const castById = new Map(nodes.filter((n) => n.type === 'cast').map((n) => [n.id, n.data ?? {}]));
  const castInputsByTarget = new Map<string, Record<string, unknown>[]>();
  for (const edge of edges) {
    const cast = castById.get(edge.source);
    if (!cast) continue;
    const existing = castInputsByTarget.get(edge.target);
    if (existing) existing.push(cast);
    else castInputsByTarget.set(edge.target, [cast]);
  }

  return ordered.map((n, i) => {
    const d = n.data ?? {};
    const inbound = castInputsByTarget.get(n.id) ?? [];
    const namesOfKind = (kind: 'character' | 'location' | 'product') =>
      inbound
        .filter((c) => c['castKind'] === kind)
        .map((c) => str(c['name']))
        .filter((s): s is string => !!s && s.trim().length > 0);

    const prompt = resolveGeneratePrompt(n, nodesById, incomingEdgesByTarget.get(n.id) ?? []);
    const trimmed = prompt.trim();
    const mode = d['mode'] === 'image' ? 'image' : 'video';
    const status = (['idle', 'running', 'done', 'failed'] as const).includes(
      d['status'] as ShotStatus,
    )
      ? (d['status'] as ShotStatus)
      : 'idle';

    return {
      id: n.id,
      shotNumber: i + 1,
      title: trimmed ? trimmed.slice(0, 48) : `Кадр ${i + 1}`,
      prompt,
      mode,
      modelId: str(d['modelId']),
      durationSeconds: num(d['durationSeconds']),
      count: num(d['count']),
      status,
      resultUrl: str(d['resultUrl']),
      resultKind:
        d['resultKind'] === 'image' ? 'image' : d['resultKind'] === 'video' ? 'video' : undefined,
      lastFrameUrl: str(d['lastFrameUrl']),
      cast: [...namesOfKind('character'), ...namesOfKind('product')],
      locations: namesOfKind('location'),
      grammarLabel: shotGrammarLabel(d['shot'] as ShotGrammar | undefined),
    };
  });
}

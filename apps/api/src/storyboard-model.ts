/**
 * Раскадровка print model (previz S5): turn an opaque board `state` into an
 * ordered list of storyboard cards. Pure — the PDF route renders this.
 *
 * Shot order = reading order on the canvas (y, then x, then id). The frame shown for
 * a shot: its keyframe render (an image-generate node wired into images[0],
 * S4 bridge) → the shot's own lastFrameUrl → its image result → none.
 */

import { compareBoardReadingOrder } from '@seed/shared/board-order';
import { resolveGeneratePrompt } from '@seed/shared/board-prompt';

interface NodeLike {
  id: string;
  type?: string;
  position?: { x?: number; y?: number };
  data?: Record<string, unknown>;
}
interface EdgeLike {
  source: string;
  target: string;
  targetHandle?: string | null | undefined;
}
export interface BoardStateLike {
  nodes?: NodeLike[];
  edges?: EdgeLike[];
}

export interface StoryboardCard {
  index: number;
  prompt: string;
  grammar: string;
  durationSeconds: number;
  frameUrl: string | null;
  castNames: string[];
}

export interface Storyboard {
  cards: StoryboardCard[];
  castNames: string[];
}

/* Chip labels mirror apps/web/lib/film-grammar.ts (small and stable). */
const SIZE_LABEL: Record<string, string> = {
  ews: 'Дальний',
  ws: 'Общий',
  ms: 'Средний',
  cu: 'Крупный',
  ecu: 'Деталь',
};
const MOVE_LABEL: Record<string, string> = {
  static: 'Статика',
  push: 'Наезд',
  pull: 'Отъезд',
  pan: 'Панорама',
  track: 'Проводка',
  crane: 'Кран',
  handheld: 'С рук',
};
const LENS_LABEL: Record<string, string> = {
  '24': '24мм',
  '35': '35мм',
  '50': '50мм',
  '85': '85мм',
};

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown, d: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : d;

function isImageSlot(h: string | null | undefined): boolean {
  return h === 'images' || /^images\[\d+\]$/.test(h ?? '');
}

function grammarLabel(g: unknown): string {
  if (!g || typeof g !== 'object') return '';
  const o = g as Record<string, unknown>;
  return [SIZE_LABEL[str(o.size)], LENS_LABEL[str(o.lens)], MOVE_LABEL[str(o.move)]]
    .filter(Boolean)
    .join(' · ');
}

export function buildStoryboard(state: BoardStateLike): Storyboard {
  const nodes = state.nodes ?? [];
  const edges = state.edges ?? [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const incomingEdgesByTarget = new Map<string, EdgeLike[]>();
  for (const edge of edges) {
    const existing = incomingEdgesByTarget.get(edge.target);
    if (existing) existing.push(edge);
    else incomingEdgesByTarget.set(edge.target, [edge]);
  }

  const shots = nodes
    .filter((n) => n.type === 'generate' && str(n.data?.mode) === 'video')
    .sort(compareBoardReadingOrder);

  const allCast = new Set<string>();
  const cards: StoryboardCard[] = shots.map((shot, i) => {
    const d = shot.data ?? {};
    const incomingEdges = incomingEdgesByTarget.get(shot.id) ?? [];
    // wired sources into this shot's image slots (direct or via the S4 keyframe)
    const refSources = incomingEdges
      .filter((e) => isImageSlot(e.targetHandle))
      .map((e) => byId.get(e.source))
      .filter((n): n is NodeLike => Boolean(n));

    let frameUrl: string | null = null;
    const castNames: string[] = [];
    const visit = (srcs: NodeLike[], depth: number) => {
      for (const s of srcs) {
        if (s.type === 'cast') {
          const name = str(s.data?.name).trim();
          if (name) {
            castNames.push(name);
            allCast.add(name);
          }
        } else if (s.type === 'generate' && str(s.data?.mode) === 'image') {
          // the S4 keyframe: its render IS the storyboard frame
          if (!frameUrl && str(s.data?.resultUrl)) frameUrl = str(s.data?.resultUrl);
          if (depth > 0) {
            const upstream = (incomingEdgesByTarget.get(s.id) ?? [])
              .filter((e) => isImageSlot(e.targetHandle))
              .map((e) => byId.get(e.source))
              .filter((n): n is NodeLike => Boolean(n));
            visit(upstream, depth - 1);
          }
        }
      }
    };
    visit(refSources, 1);

    if (!frameUrl) {
      frameUrl =
        str(d.lastFrameUrl) || (str(d.resultKind) === 'image' ? str(d.resultUrl) : '') || null;
    }

    return {
      index: i + 1,
      prompt: resolveGeneratePrompt(
        shot,
        byId,
        incomingEdges.map((edge) => ({
          source: edge.source,
          targetHandle: edge.targetHandle ?? null,
        })),
      ).trim(),
      grammar: grammarLabel(d.shot),
      durationSeconds: num(d.durationSeconds, 5),
      frameUrl,
      castNames,
    };
  });

  return { cards, castNames: [...allCast] };
}

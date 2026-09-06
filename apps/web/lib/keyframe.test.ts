import { describe, expect, it } from 'vitest';
import { planKeyframeBridge, type EdgeLike } from './keyframe';

const E = (
  id: string,
  source: string,
  target: string,
  targetHandle: string,
  sourceHandle = 'out',
): EdgeLike => ({ id, source, target, sourceHandle, targetHandle });

describe('planKeyframeBridge (previz S4)', () => {
  it('moves ref edges to the keyframe, copies prompt, feeds shot images[0]', () => {
    const edges = [
      E('e1', 'cast-char', 'shot', 'images[0]'),
      E('e2', 'cast-loc', 'shot', 'images[1]'),
      E('e3', 'prompt-1', 'shot', 'prompt'),
      E('e4', 'cast-char', 'other-shot', 'images[0]'), // untouched
    ];
    const plan = planKeyframeBridge('shot', 'kf', edges);
    expect(plan).not.toBeNull();
    expect(plan!.removeEdgeIds).toEqual(['e1', 'e2']); // prompt edge stays
    expect(plan!.addEdges).toEqual([
      { source: 'cast-char', target: 'kf', sourceHandle: 'out', targetHandle: 'images[0]' },
      { source: 'cast-loc', target: 'kf', sourceHandle: 'out', targetHandle: 'images[1]' },
      { source: 'prompt-1', target: 'kf', sourceHandle: 'out', targetHandle: 'prompt' },
      { source: 'kf', target: 'shot', sourceHandle: 'out', targetHandle: 'images[0]' },
    ]);
  });

  it('re-slots sparse/legacy handles into dense keyframe slots', () => {
    const edges = [
      E('e1', 'm1', 'shot', 'images[3]'),
      E('e2', 'm2', 'shot', 'images'), // legacy single-handle
    ];
    const plan = planKeyframeBridge('shot', 'kf', edges)!;
    // legacy 'images' sorts as slot 0, then images[3]
    expect(plan.addEdges[0]).toMatchObject({ source: 'm2', targetHandle: 'images[0]' });
    expect(plan.addEdges[1]).toMatchObject({ source: 'm1', targetHandle: 'images[1]' });
  });

  it('returns null when the shot has no reference wiring', () => {
    expect(planKeyframeBridge('shot', 'kf', [E('e1', 'p', 'shot', 'prompt')])).toBeNull();
    expect(planKeyframeBridge('shot', 'kf', [])).toBeNull();
  });
});

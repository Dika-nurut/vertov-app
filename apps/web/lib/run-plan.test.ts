import { describe, expect, it } from 'vitest';
import { planRunAll, type PlanNode } from './run-plan';

const gen = (id: string, mode: 'video' | 'image', extra: Partial<PlanNode> = {}): PlanNode => ({
  id,
  type: 'generate',
  mode,
  ...extra,
});

describe('planRunAll', () => {
  it('empty board → empty plan', () => {
    expect(planRunAll([], [])).toEqual({
      order: [],
      tasks: [],
      items: [],
      total: null,
      reused: [],
      inFlight: [],
    });
  });

  it('ignores non-generate nodes and leaves prices for server quotes', () => {
    const nodes: PlanNode[] = [
      { id: 'p1', type: 'prompt' },
      { id: 'm1', type: 'media' },
      { id: 'text-1', type: 'text' },
      { id: 'frame-1', type: 'frame' },
      gen('g1', 'video'),
      gen('g2', 'image', { count: 3 }),
    ];
    const plan = planRunAll(nodes, []);
    expect(plan.order).toEqual(['g1', 'g2']);
    expect(plan.total).toBeNull();
    expect(plan.items).toEqual([
      { id: 'g1', mode: 'video' },
      { id: 'g2', mode: 'image', count: 3 },
    ]);
    expect(plan.tasks).toEqual([
      { id: 'g1', dependencies: [] },
      { id: 'g2', dependencies: [] },
    ]);
  });

  it('does not schedule organizer nodes even when they have stray edge records', () => {
    const plan = planRunAll(
      [{ id: 'text-1', type: 'text' }, { id: 'frame-1', type: 'frame' }, gen('shot', 'image')],
      [{ source: 'frame-1', target: 'shot', targetHandle: 'images[0]' }],
    );
    expect(plan.order).toEqual(['shot']);
    expect(plan.items).toEqual([{ id: 'shot', mode: 'image' }]);
  });

  it('orders upstream shots before the shots that reference them', () => {
    // g1 → g2 → g3 (each feeds the next as an image reference)
    const nodes = [gen('g3', 'video'), gen('g1', 'image'), gen('g2', 'image')];
    const edges = [
      { source: 'g2', target: 'g3', targetHandle: 'images[0]' },
      { source: 'g1', target: 'g2', targetHandle: 'images[0]' },
    ];
    expect(planRunAll(nodes, edges).order).toEqual(['g1', 'g2', 'g3']);
  });

  it('respects a diamond dependency', () => {
    // g1 feeds g2 and g3; both feed g4
    const nodes = [gen('g1', 'image'), gen('g2', 'image'), gen('g3', 'image'), gen('g4', 'video')];
    const edges = [
      { source: 'g1', target: 'g2', targetHandle: 'images[0]' },
      { source: 'g1', target: 'g3', targetHandle: 'images[0]' },
      { source: 'g2', target: 'g4', targetHandle: 'images[0]' },
      { source: 'g3', target: 'g4', targetHandle: 'images[1]' },
    ];
    const order = planRunAll(nodes, edges).order;
    expect(order[0]).toBe('g1');
    expect(order[3]).toBe('g4');
    expect(order.indexOf('g2')).toBeLessThan(order.indexOf('g4'));
    expect(order.indexOf('g3')).toBeLessThan(order.indexOf('g4'));
    expect(planRunAll(nodes, edges).tasks).toEqual([
      { id: 'g1', dependencies: [] },
      { id: 'g2', dependencies: ['g1'] },
      { id: 'g3', dependencies: ['g1'] },
      { id: 'g4', dependencies: ['g2', 'g3'] },
    ]);
  });

  it('reuses already-done shots (not re-billed) but keeps deps ordered', () => {
    const nodes = [gen('g1', 'image', { status: 'done' }), gen('g2', 'video')];
    const edges = [{ source: 'g1', target: 'g2', targetHandle: 'images[0]' }];
    const plan = planRunAll(nodes, edges);
    expect(plan.reused).toEqual(['g1']);
    expect(plan.order).toEqual(['g2']);
    expect(plan.tasks).toEqual([{ id: 'g2', dependencies: [] }]);
    expect(plan.total).toBeNull();
  });

  it('waits for a persisted running job without billing or submitting it again', () => {
    const nodes = [
      gen('running', 'image', { status: 'running', jobId: 'job-1' }),
      gen('downstream', 'video'),
    ];
    const edges = [{ source: 'running', target: 'downstream', targetHandle: 'images[0]' }];
    const plan = planRunAll(nodes, edges);
    expect(plan.inFlight).toEqual(['running']);
    expect(plan.order).toEqual(['running', 'downstream']);
    expect(plan.items).toEqual([{ id: 'downstream', mode: 'video' }]);
    expect(plan.total).toBeNull();
    expect(plan.tasks).toEqual([
      { id: 'running', dependencies: [] },
      { id: 'downstream', dependencies: ['running'] },
    ]);
  });

  it('prompt wires do not create run-order dependencies', () => {
    // a prompt→generate edge must not be treated as a gen dependency
    const nodes = [gen('g1', 'video'), { id: 'p1', type: 'prompt' }];
    const edges = [{ source: 'p1', target: 'g1', targetHandle: 'prompt' }];
    expect(planRunAll(nodes, edges).order).toEqual(['g1']);
  });

  it('scene context wires do not create run-order dependencies', () => {
    const nodes = [
      gen('g1', 'video'),
      { id: 'scene', type: 'scene' },
      { id: 'ai', type: 'aiprompt' },
    ];
    const edges = [{ source: 'scene', target: 'ai', targetHandle: 'scene' }];
    expect(planRunAll(nodes, edges).order).toEqual(['g1']);
  });

  it('keeps cast edges out of the hard-coded generate-only run graph', () => {
    const nodes = [
      gen('g1', 'image'),
      { id: 'cast', type: 'cast' },
      { id: 'scene', type: 'scene' },
    ];
    const edges = [
      { source: 'scene', target: 'cast', targetHandle: 'scene' },
      { source: 'cast', target: 'g1', targetHandle: 'images[0]' },
      { source: 'g1', target: 'cast', targetHandle: 'scene' },
    ];
    expect(planRunAll(nodes, edges).tasks).toEqual([{ id: 'g1', dependencies: [] }]);
  });

  it('includes an idle cast-owned reference shot for Run All', () => {
    const plan = planRunAll([gen('reference', 'image', { originCastNodeId: 'cast-1' })], []);
    expect(plan.items).toEqual([{ id: 'reference', mode: 'image' }]);
  });

  it('a dependency cycle still includes every node (no infinite loop)', () => {
    const nodes = [gen('g1', 'video'), gen('g2', 'video')];
    const edges = [
      { source: 'g1', target: 'g2', targetHandle: 'images[0]' },
      { source: 'g2', target: 'g1', targetHandle: 'images[0]' },
    ];
    expect(planRunAll(nodes, edges).order.sort()).toEqual(['g1', 'g2']);
  });
});

import { describe, expect, it } from 'vitest';
import { executeBoardRunPlan, resumePersistedBoardJobs } from './board-runner';
import { createDagRunControl } from './run-scheduler';
import type { RunPlan } from './run-plan';

function plan(tasks: RunPlan['tasks'], reused: string[] = []): RunPlan {
  return { order: tasks.map((task) => task.id), tasks, items: [], total: 0, reused, inFlight: [] };
}

describe('Board runner orchestration', () => {
  it('publishes each DAG output once and satisfies reused dependencies', async () => {
    const started: string[] = [];
    const outputs = new Map<string, string>();
    const result = await executeBoardRunPlan({
      plan: plan(
        [
          { id: 'left', dependencies: ['done'] },
          { id: 'right', dependencies: ['done'] },
          { id: 'leaf', dependencies: ['left', 'right'] },
        ],
        ['done'],
      ),
      control: createDagRunControl(),
      runNode: async (nodeId) => {
        started.push(nodeId);
        return `${nodeId}-output`;
      },
      onOutput: (nodeId, output) => outputs.set(nodeId, output),
    });
    expect(started.filter((nodeId) => nodeId === 'leaf')).toHaveLength(1);
    expect(outputs).toEqual(
      new Map([
        ['left', 'left-output'],
        ['right', 'right-output'],
        ['leaf', 'leaf-output'],
      ]),
    );
    expect(result.tasks.every((task) => task.status === 'succeeded')).toBe(true);
  });

  it('turns a null node result into a failed task and blocks its descendant', async () => {
    const result = await executeBoardRunPlan({
      plan: plan([
        { id: 'upstream', dependencies: [] },
        { id: 'child', dependencies: ['upstream'] },
      ]),
      control: createDagRunControl(),
      runNode: async () => null,
    });
    expect(result.tasks[0]).toMatchObject({ status: 'failed' });
    expect(result.tasks[1]).toMatchObject({ status: 'blocked', blockedBy: ['upstream'] });
  });

  it('rebuilds persisted waiters without submitting unrelated nodes', async () => {
    const resumed: string[] = [];
    const result = await resumePersistedBoardJobs({
      nodeIds: ['running-a', 'running-b'],
      runNode: async (nodeId) => {
        resumed.push(nodeId);
        return `${nodeId}-result`;
      },
    });
    expect(resumed).toEqual(['running-a', 'running-b']);
    expect(result.every((entry) => entry.status === 'fulfilled')).toBe(true);
  });
});

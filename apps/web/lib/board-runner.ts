import type { RunPlan } from './run-plan';
import {
  DEFAULT_DAG_TASK_TIMEOUT_MS,
  runDagScheduler,
  withTaskDeadline,
  type DagRunControl,
  type DagRunResult,
} from './run-scheduler';

export class BoardNodeRunFailedError extends Error {
  constructor(readonly nodeId: string) {
    super(`board_run_failed:${nodeId}`);
    this.name = 'BoardNodeRunFailedError';
  }
}

export async function executeBoardRunPlan(input: {
  plan: RunPlan;
  control: DagRunControl;
  runNode: (nodeId: string) => Promise<string | null>;
  onOutput?: (nodeId: string, output: string) => void;
  concurrency?: number;
  taskTimeoutMs?: number;
}): Promise<DagRunResult<string>> {
  return runDagScheduler({
    tasks: input.plan.tasks,
    completedIds: input.plan.reused,
    control: input.control,
    ...(input.concurrency !== undefined ? { concurrency: input.concurrency } : {}),
    taskTimeoutMs: input.taskTimeoutMs ?? DEFAULT_DAG_TASK_TIMEOUT_MS,
    run: async (nodeId) => {
      const output = await input.runNode(nodeId);
      if (!output) throw new BoardNodeRunFailedError(nodeId);
      input.onOutput?.(nodeId, output);
      return output;
    },
  });
}

/** Recreate bounded waiters for jobs already persisted before a reload. */
export function resumePersistedBoardJobs(input: {
  nodeIds: readonly string[];
  runNode: (nodeId: string) => Promise<string | null>;
  taskTimeoutMs?: number;
}) {
  const timeoutMs = input.taskTimeoutMs ?? DEFAULT_DAG_TASK_TIMEOUT_MS;
  return Promise.allSettled(
    input.nodeIds.map((nodeId) =>
      withTaskDeadline(`resume:${nodeId}`, input.runNode(nodeId), timeoutMs),
    ),
  );
}

export const DEFAULT_DAG_CONCURRENCY = 3;
export const DEFAULT_DAG_TASK_TIMEOUT_MS = 15 * 60_000;

export interface DagTask {
  id: string;
  dependencies?: readonly string[];
}

export type DagTaskStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'stopped';

export interface DagTaskResult<T> {
  id: string;
  status: DagTaskStatus;
  value?: T;
  error?: unknown;
  blockedBy?: string[];
}

export interface DagRunResult<T> {
  tasks: DagTaskResult<T>[];
  stopped: boolean;
  maxConcurrency: number;
}

export interface DagRunControl {
  stop: () => void;
  isStopped: () => boolean;
}

export interface RunDagSchedulerOptions<T> {
  tasks: readonly DagTask[];
  run: (id: string) => Promise<T>;
  completedIds?: Iterable<string>;
  concurrency?: number;
  taskTimeoutMs?: number;
  control?: DagRunControl;
  onTransition?: (task: DagTaskResult<T>) => void;
}

export class DagTaskDeadlineError extends Error {
  constructor(
    readonly taskId: string,
    readonly timeoutMs: number,
  ) {
    super(`DAG task '${taskId}' exceeded ${timeoutMs}ms`);
    this.name = 'DagTaskDeadlineError';
  }
}

export function createDagRunControl(): DagRunControl {
  let stopped = false;
  return {
    stop: () => {
      stopped = true;
    },
    isStopped: () => stopped,
  };
}

export async function withTaskDeadline<T>(
  taskId: string,
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DagTaskDeadlineError(taskId, timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Deadline for cancellable network work; aborts the request on expiry. */
export async function withAbortDeadline<T>(
  taskId: string,
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return run(new AbortController().signal);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw new DagTaskDeadlineError(taskId, timeoutMs);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pure dependency scheduler. It owns ordering/concurrency only; task side
 * effects are injected through `run`. Stopping never aborts work that already
 * started, which lets submitted generation jobs finish in the global tray.
 */
export async function runDagScheduler<T>(
  options: RunDagSchedulerOptions<T>,
): Promise<DagRunResult<T>> {
  const concurrency = Math.floor(options.concurrency ?? DEFAULT_DAG_CONCURRENCY);
  if (!Number.isFinite(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new Error('invalid_dag_concurrency');
  }
  const timeoutMs = options.taskTimeoutMs ?? DEFAULT_DAG_TASK_TIMEOUT_MS;
  const control = options.control ?? createDagRunControl();
  const completed = new Set(options.completedIds ?? []);
  const taskById = new Map<string, DagTask>();
  for (const task of options.tasks) {
    if (!task.id || taskById.has(task.id)) throw new Error('invalid_dag_tasks');
    taskById.set(task.id, {
      id: task.id,
      dependencies: [...new Set(task.dependencies ?? [])],
    });
  }

  const results = new Map<string, DagTaskResult<T>>(
    options.tasks.map((task) => [task.id, { id: task.id, status: 'pending' }]),
  );
  const running = new Map<string, Promise<void>>();
  let maxConcurrency = 0;

  const transition = (next: DagTaskResult<T>) => {
    results.set(next.id, next);
    try {
      options.onTransition?.({ ...next });
    } catch {
      // Observability must not change scheduling semantics.
    }
  };

  const dependencyStatus = (id: string): DagTaskStatus | 'completed' | 'missing' => {
    if (completed.has(id)) return 'completed';
    return results.get(id)?.status ?? 'missing';
  };

  const propagateBlocked = () => {
    let changed = false;
    for (const task of taskById.values()) {
      if (results.get(task.id)?.status !== 'pending') continue;
      const blockedBy = (task.dependencies ?? []).filter((dependency) => {
        const status = dependencyStatus(dependency);
        return status === 'failed' || status === 'blocked';
      });
      if (blockedBy.length > 0) {
        transition({ id: task.id, status: 'blocked', blockedBy });
        changed = true;
      }
    }
    return changed;
  };

  const ready = (task: DagTask) =>
    (task.dependencies ?? []).every((dependency) => {
      const status = dependencyStatus(dependency);
      return status === 'completed' || status === 'succeeded';
    });

  const launch = (task: DagTask) => {
    transition({ id: task.id, status: 'running' });
    const settled = withTaskDeadline(
      task.id,
      Promise.resolve().then(() => options.run(task.id)),
      timeoutMs,
    )
      .then((value) => transition({ id: task.id, status: 'succeeded', value }))
      .catch((error: unknown) => transition({ id: task.id, status: 'failed', error }))
      .then(() => {
        running.delete(task.id);
      });
    running.set(task.id, settled);
    maxConcurrency = Math.max(maxConcurrency, running.size);
  };

  while (true) {
    while (propagateBlocked()) {
      // A blocked task may recursively block its descendants.
    }

    if (!control.isStopped()) {
      for (const task of taskById.values()) {
        if (running.size >= concurrency) break;
        if (results.get(task.id)?.status === 'pending' && ready(task)) launch(task);
      }
    }

    if (running.size > 0) {
      await Promise.race(running.values());
      continue;
    }

    const pending = [...taskById.values()].filter(
      (task) => results.get(task.id)?.status === 'pending',
    );
    if (pending.length === 0) break;
    if (control.isStopped()) {
      for (const task of pending) transition({ id: task.id, status: 'stopped' });
    } else {
      // No runnable work and no task in flight means a cycle or an unknown dep.
      for (const task of pending) {
        transition({
          id: task.id,
          status: 'blocked',
          blockedBy: (task.dependencies ?? []).filter(
            (dependency) => dependencyStatus(dependency) !== 'succeeded',
          ),
        });
      }
    }
    break;
  }

  return {
    tasks: options.tasks.map((task) => results.get(task.id)!),
    stopped: control.isStopped(),
    maxConcurrency,
  };
}

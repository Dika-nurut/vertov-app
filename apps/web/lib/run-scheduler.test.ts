import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DagTaskDeadlineError,
  createDagRunControl,
  runDagScheduler,
  withAbortDeadline,
  type DagTask,
} from './run-scheduler';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

afterEach(() => vi.useRealTimers());

describe('runDagScheduler', () => {
  it('runs independent work with a bounded default concurrency of three', async () => {
    const gates = new Map(['a', 'b', 'c', 'd'].map((id) => [id, deferred<string>()]));
    const started: string[] = [];
    const run = runDagScheduler({
      tasks: [...gates.keys()].map((id) => ({ id })),
      run: async (id) => {
        started.push(id);
        return gates.get(id)!.promise;
      },
    });
    await flush();
    expect(started).toEqual(['a', 'b', 'c']);

    gates.get('b')!.resolve('b-result');
    await flush();
    expect(started).toEqual(['a', 'b', 'c', 'd']);
    gates.get('a')!.resolve('a-result');
    gates.get('c')!.resolve('c-result');
    gates.get('d')!.resolve('d-result');

    const result = await run;
    expect(result.maxConcurrency).toBe(3);
    expect(result.tasks.map((task) => task.status)).toEqual([
      'succeeded',
      'succeeded',
      'succeeded',
      'succeeded',
    ]);
  });

  it('waits only for actual dependencies and unlocks both sides of a diamond', async () => {
    const gates = new Map(['root', 'left', 'right', 'leaf'].map((id) => [id, deferred<string>()]));
    const tasks: DagTask[] = [
      { id: 'root' },
      { id: 'left', dependencies: ['root'] },
      { id: 'right', dependencies: ['root'] },
      { id: 'leaf', dependencies: ['left', 'right'] },
    ];
    const started: string[] = [];
    const run = runDagScheduler({
      tasks,
      run: async (id) => {
        started.push(id);
        return gates.get(id)!.promise;
      },
    });
    await flush();
    expect(started).toEqual(['root']);
    gates.get('root')!.resolve('root');
    await flush();
    expect(started).toEqual(['root', 'left', 'right']);
    gates.get('left')!.resolve('left');
    await flush();
    expect(started).not.toContain('leaf');
    gates.get('right')!.resolve('right');
    await flush();
    expect(started).toContain('leaf');
    gates.get('leaf')!.resolve('leaf');
    expect((await run).tasks.every((task) => task.status === 'succeeded')).toBe(true);
  });

  it('treats completed upstream outputs as satisfied without launching them', async () => {
    const started: string[] = [];
    const result = await runDagScheduler({
      tasks: [{ id: 'downstream', dependencies: ['already-done'] }],
      completedIds: ['already-done'],
      run: async (id) => {
        started.push(id);
        return id;
      },
    });
    expect(started).toEqual(['downstream']);
    expect(result.tasks[0]).toMatchObject({ status: 'succeeded', value: 'downstream' });
  });

  it('blocks descendants of a failed task but lets an independent branch finish', async () => {
    const started: string[] = [];
    const result = await runDagScheduler({
      tasks: [{ id: 'bad' }, { id: 'child', dependencies: ['bad'] }, { id: 'independent' }],
      run: async (id) => {
        started.push(id);
        if (id === 'bad') throw new Error('failed');
        return id;
      },
    });
    expect(started).toEqual(['bad', 'independent']);
    expect(result.tasks).toMatchObject([
      { id: 'bad', status: 'failed' },
      { id: 'child', status: 'blocked', blockedBy: ['bad'] },
      { id: 'independent', status: 'succeeded' },
    ]);
  });

  it('Stop prevents new launches while already-started work settles', async () => {
    const control = createDagRunControl();
    const gates = new Map(['a', 'b'].map((id) => [id, deferred<string>()]));
    const started: string[] = [];
    const run = runDagScheduler({
      tasks: [{ id: 'a' }, { id: 'b' }, { id: 'never' }],
      concurrency: 2,
      control,
      run: async (id) => {
        started.push(id);
        return gates.get(id)!.promise;
      },
    });
    await flush();
    expect(started).toEqual(['a', 'b']);
    control.stop();
    gates.get('a')!.resolve('a');
    gates.get('b')!.resolve('b');
    const result = await run;
    expect(started).toEqual(['a', 'b']);
    expect(result.stopped).toBe(true);
    expect(result.tasks[2]).toMatchObject({ id: 'never', status: 'stopped' });
  });

  it('bounds a task wait with a typed deadline failure', async () => {
    vi.useFakeTimers();
    const run = runDagScheduler({
      tasks: [{ id: 'slow' }, { id: 'dependent', dependencies: ['slow'] }],
      taskTimeoutMs: 50,
      run: async () => new Promise<string>(() => {}),
    });
    await vi.advanceTimersByTimeAsync(51);
    const result = await run;
    expect(result.tasks[0]?.status).toBe('failed');
    expect(result.tasks[0]?.error).toBeInstanceOf(DagTaskDeadlineError);
    expect(result.tasks[1]).toMatchObject({ status: 'blocked', blockedBy: ['slow'] });
  });

  it('aborts a bounded network operation on deadline', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const request = withAbortDeadline('submit', 50, (nextSignal) => {
      signal = nextSignal;
      return new Promise<string>((_resolve, reject) => {
        nextSignal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });
    const settled = request.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(51);
    expect(await settled).toBeInstanceOf(DagTaskDeadlineError);
    expect(signal?.aborted).toBe(true);
  });

  it('fails closed on cycles, missing dependencies, duplicates, and invalid bounds', async () => {
    const blocked = await runDagScheduler({
      tasks: [
        { id: 'a', dependencies: ['b'] },
        { id: 'b', dependencies: ['a'] },
        { id: 'missing', dependencies: ['outside'] },
      ],
      run: async (id) => id,
    });
    expect(blocked.tasks.every((task) => task.status === 'blocked')).toBe(true);
    await expect(
      runDagScheduler({ tasks: [{ id: 'same' }, { id: 'same' }], run: async (id) => id }),
    ).rejects.toThrow('invalid_dag_tasks');
    await expect(
      runDagScheduler({ tasks: [], concurrency: 0, run: async (id) => id }),
    ).rejects.toThrow('invalid_dag_concurrency');
  });
});

/**
 * Graceful worker drain on SIGTERM/SIGINT (INF-12).
 *
 * A rolling deploy or scale-in sends SIGTERM. We want in-flight BullMQ jobs to
 * FINISH (BullMQ's `worker.close()` without force waits for the active job)
 * rather than being killed mid-render. But an ffmpeg render can run for minutes,
 * and the orchestrator will SIGKILL the process once its grace period elapses —
 * so we bound the graceful wait with a deadline: if the drain doesn't complete
 * in `timeoutMs`, force-close the workers and exit cleanly ourselves. Anything
 * stranded by a force-close is recovered by the reapers + the credit outbox, so
 * a rolling restart never strands a job or a reservation.
 *
 * Set the orchestrator grace period (docker `stop -t`, k8s
 * terminationGracePeriodSeconds) LONGER than `timeoutMs` so our clean
 * force-close fires before SIGKILL.
 */
export interface ClosableWorker {
  close(force?: boolean): Promise<void>;
  readonly name?: string;
}

export interface DrainLogger {
  warn(obj: unknown, msg?: string): void;
}

export async function drainWorkers(
  workers: ClosableWorker[],
  timeoutMs: number,
  log?: DrainLogger,
): Promise<'drained' | 'forced'> {
  if (workers.length === 0) return 'drained';

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const graceful = Promise.allSettled(workers.map((w) => w.close())).then(() => 'done' as const);

  const result = await Promise.race([graceful, deadline]);
  if (timer) clearTimeout(timer);

  if (result === 'timeout') {
    log?.warn(
      { timeoutMs, workers: workers.map((w) => w.name) },
      'worker drain exceeded deadline — force-closing; reapers + outbox will recover any stranded job',
    );
    await Promise.allSettled(workers.map((w) => w.close(true)));
    return 'forced';
  }
  return 'drained';
}

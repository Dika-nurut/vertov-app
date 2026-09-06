/**
 * Readiness aggregation (INF-17). A process is *live* if it's running; it's
 * *ready* only if its dependencies (DB, Redis) are reachable. Health-gated
 * rollout (INF-16) routes traffic to a new instance only once /ready is 200.
 *
 * Each probe is a thunk that throws/rejects when its dependency is unreachable.
 * We run them concurrently and never let one probe's rejection escape — the
 * aggregate is `ok` iff every probe resolved.
 */
export interface ReadinessResult {
  ok: boolean;
  checks: Record<string, boolean>;
}

export async function probeReadiness(
  probes: Record<string, () => Promise<unknown>>,
  timeoutMs = 1_500,
): Promise<ReadinessResult> {
  const entries = await Promise.all(
    Object.entries(probes).map(async ([name, fn]) => {
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            fn(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('readiness probe timeout')), timeoutMs);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        return [name, true] as const;
      } catch {
        return [name, false] as const;
      }
    }),
  );
  return {
    ok: entries.every(([, ok]) => ok),
    checks: Object.fromEntries(entries),
  };
}

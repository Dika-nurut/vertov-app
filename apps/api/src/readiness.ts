export const DEFAULT_READINESS_TIMEOUT_MS = 1_500;

/** A readiness dependency must fail quickly enough for a load balancer to
 * remove the instance. The underlying DB/Redis clients may deliberately retry
 * forever for normal request recovery; that policy must not make /ready hang. */
export async function boundedReadinessProbe(
  probe: () => Promise<unknown>,
  timeoutMs = DEFAULT_READINESS_TIMEOUT_MS,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      probe(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('readiness probe timeout')), timeoutMs);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

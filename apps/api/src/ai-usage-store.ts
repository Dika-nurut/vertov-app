import { aiUsageEvents, db, nid } from '@seed/db';
import { derivedCostUsd, type AiCallAttempt, type AiUsageOp } from '@seed/shared';

export async function recordAiUsage(
  attempts: AiCallAttempt[],
  ctx: {
    op: AiUsageOp;
    userId: string | null;
    claimId?: string | null;
    scriptId?: string | null;
    /** Credits actually committed. Omit/undefined for refunded or unbilled requests. */
    creditsCharged?: number | null;
  },
  log?: { warn: (o: unknown, m: string) => void },
): Promise<void> {
  try {
    if (attempts.length === 0) return;
    const lastOk = [...attempts].reverse().find((attempt) => attempt.outcome === 'ok');
    const insert = db.insert(aiUsageEvents).values(
      attempts.map((attempt) => {
        const usage = attempt.usage;
        const providerCost = usage?.costUsd ?? null;
        const derivedCost = usage ? derivedCostUsd(attempt.route, attempt.model, usage) : null;
        return {
          id: nid(),
          userId: ctx.userId,
          op: ctx.op,
          route: attempt.route,
          model: attempt.model,
          attempt: attempt.attempt,
          outcome: attempt.outcome,
          claimId: ctx.claimId ?? null,
          scriptId: ctx.scriptId ?? null,
          inputTokens: usage?.inputTokens ?? null,
          outputTokens: usage?.outputTokens ?? null,
          cacheReadTokens: usage?.cacheReadTokens ?? null,
          cacheWriteTokens: usage?.cacheWriteTokens ?? null,
          reasoningTokens: usage?.reasoningTokens ?? null,
          usageReported: usage !== null,
          costUsd: providerCost ?? derivedCost,
          costSource: providerCost !== null ? 'provider' : derivedCost !== null ? 'derived' : null,
          creditsCharged:
            ctx.creditsCharged != null && attempt === lastOk ? ctx.creditsCharged : null,
          cacheMarkersSent: attempt.cacheMarkersSent ?? false,
          errorMessage: attempt.errorMessage?.slice(0, 300) ?? null,
        };
      }),
    );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      insert.then(() => false),
      new Promise<true>((resolve) => {
        timeout = setTimeout(() => resolve(true), 2_000);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (timedOut) {
      try {
        log?.warn({}, 'ai usage recording timed out');
      } catch {
        // Telemetry must remain unable to fail a request, even with a bad logger.
      }
    }
  } catch (err) {
    try {
      log?.warn({ err }, 'ai usage recording failed');
    } catch {
      // Telemetry must remain unable to fail a request, even with a bad logger.
    }
  }
}

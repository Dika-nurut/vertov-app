import { and, eq } from 'drizzle-orm';
import { db, scriptAssistRequests } from '@seed/db';
import { CREDIT_REFUND_QUEUE, enqueueViaOutbox, paidScriptClaimKey } from '@seed/credits';

/**
 * Recovery shared by every paid Scenario claim (`script_assist_requests`).
 *
 * Lives here — not inside one route — because a second copy of refund logic is a
 * second thing to keep correct, and the two copies drift silently (the money is
 * only wrong once someone crashes).
 */

/**
 * An in_progress claim older than this is a crashed/abandoned request (the
 * longest call deadline is 180s, so 10 min is unambiguously dead). The next paid
 * request of the SAME op reclaims it — refunds its hold and frees the per-user
 * in-flight slot — so a crash mid-request can't block the user's paid features
 * forever.
 */
export const STALE_CLAIM_MS = 10 * 60 * 1000;

/**
 * If `blocker` is a crashed (stale) claim of `op`, reclaim it: in ONE transaction
 * race-safely DELETE it (only the winner of the conditional delete owns it —
 * deleting frees BOTH the in-flight slot and the (user,key) slot) AND enqueue the
 * durable refund of its hold, so a crash can never remove the jobId without
 * scheduling its refund. Returns true so the caller can retry its claim.
 *
 * The in-flight index is PER-OP, so a claim only ever conflicts with another of
 * its own op. The DELETE is still gated on `op` (belt-and-suspenders), so it can
 * NEVER remove another operation's claim (whose hold this op can't refund).
 */
export async function reclaimStaleClaim(input: {
  /** The paid operation that owns the row ('structurize' | 'shot_plan' | …). */
  op: string;
  blocker: { id: string; updatedAt: Date };
  userId: string;
  /** Ledger reason recorded on the refund (per-op, for audit). */
  reason: string;
  /** Refunded only when the stored `amount` is NULL (legacy rows). */
  fallbackAmount: number;
  reqId: string;
}): Promise<boolean> {
  if (Date.now() - input.blocker.updatedAt.getTime() <= STALE_CLAIM_MS) return false;
  return db.transaction(async (tx) => {
    const removed = await tx
      .delete(scriptAssistRequests)
      .where(
        and(
          eq(scriptAssistRequests.id, input.blocker.id),
          eq(scriptAssistRequests.status, 'in_progress'),
          eq(scriptAssistRequests.op, input.op),
        ),
      )
      .returning({
        jobId: scriptAssistRequests.jobId,
        reserved: scriptAssistRequests.reserved,
        amount: scriptAssistRequests.amount,
      });
    if (removed.length === 0) return false; // not ours, or another process won
    // Refund ONLY a confirmed hold, and for the amount ACTUALLY reserved on that
    // claim (not this process's current price) — else a claim crossing a pricing
    // deploy would refund the wrong amount. A claim that crashed before reserving
    // has no ledger hold, so no refund is enqueued.
    if (removed[0]!.reserved && removed[0]!.jobId) {
      const heldJobId = removed[0]!.jobId;
      const heldAmount = removed[0]!.amount ?? input.fallbackAmount;
      await enqueueViaOutbox({
        tx,
        queueName: CREDIT_REFUND_QUEUE,
        payload: {
          userId: input.userId,
          jobId: heldJobId,
          amount: heldAmount,
          reason: input.reason,
          idempotencyKey: paidScriptClaimKey(input.op, heldJobId, 'refund'),
          _reqId: input.reqId,
        },
        jobId: `${input.op}-refund-${heldJobId}`,
      });
    }
    return true;
  });
}

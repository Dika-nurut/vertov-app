import { subscriptionsCatalog } from '../schema/subscriptions-catalog';
import { db as defaultDb } from './index';
import { creditFloorRub } from './price-breakeven';

/**
 * The credit revenue floor, read from the live catalogue.
 *
 * **This is the single source of the number.** Every money-path guard scores
 * revenue at the cheapest ₽-per-credit ANY subscriber can obtain, and "any
 * subscriber" includes the ones still sitting on a DEACTIVATED legacy plan —
 * their credits are as spendable as anyone's. Filtering to `isActive` reads
 * 11699/32500 = 0.359969 ₽/credit where the truth is 1490/4500 = 0.331111 — an
 * **8.72%** overstatement of revenue per credit, which understates a LOSS by
 * much more than that, because the loss is a difference of two larger numbers:
 * on one 4K official-leg image (cost 25.6264 ₽, revenue 50 credits) the real
 * loss is 9.0708 ₽ and the active-only reading is 7.6279 ₽ — **15.91% short**.
 * The official-leg ledger did exactly that until 2026-08-02; the admin cost
 * report and the CI break-even guard did not.
 *
 * Zero is a real answer, and a fail-closed one: a catalogue with no usable tier
 * means we cannot value a credit at all, so a caller must refuse rather than
 * treat revenue as free.
 */

type DbLike = typeof defaultDb;
type Tx = Parameters<Parameters<DbLike['transaction']>[0]>[0];
/** Either the pool or an open transaction — every reader here works in both. */
export type DbRunner = DbLike | Tx;

export async function readConservativeCreditFloorRub(
  runner: DbRunner = defaultDb,
): Promise<number> {
  const rows = await runner
    .select({
      priceRub: subscriptionsCatalog.priceRub,
      creditsPerCycle: subscriptionsCatalog.creditsPerCycle,
    })
    .from(subscriptionsCatalog);
  return creditFloorRub(rows);
}

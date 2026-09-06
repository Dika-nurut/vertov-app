import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  creditBucketAllocations,
  creditBuckets,
  creditTransactions,
  db as defaultDb,
  nid,
  schema,
  usersApp,
} from '@seed/db';
import {
  IdempotencyKeyConflictError,
  InsufficientCreditsError,
  InvalidAmountError,
  UnreservedSpendError,
} from './errors';

/**
 * Sign convention (single source of truth):
 *
 *   - 'subscription_grant' | 'pack_grant' | 'bonus_grant' | 'refund' rows: positive amounts that ADD
 *     to the user's available pool. They double as the audit ledger ("where did
 *     these credits come from?") AND as available-balance entries.
 *   - 'available' rows: only used by `reserve` to write the negative leg that moves
 *     credits OUT of the available pool into a reservation.
 *   - 'pending' rows: positive on `reserve`, negative on `commit`/`refund`.
 *   - 'spend' rows: positive on `commit`, recording credits that have been consumed.
 *
 * Therefore:
 *   available_balance := SUM(amount) WHERE account IN
 *     ('subscription_grant','pack_grant','bonus_grant','refund','available')
 *   pending_balance   := SUM(amount) WHERE account = 'pending'
 *
 * Every mutation runs inside a single db.transaction() — both legs land or neither
 * does. Every mutation is idempotent on `idempotencyKey` (UNIQUE in the DB).
 * Multi-leg ops derive per-leg keys (`${key}:available`, `${key}:pending`, …) so
 * the unique index covers each row individually but a single caller key drives them.
 */

// Legacy-compatible alias for the initial welcome grant. The active welcome
// program's SSOT is WELCOME_GRANT_AMOUNTS.L0 in welcome.ts (210 by default):
// L0 is granted at signup, while the marketing «до 400 токенов» is a DRIP
// (210 now + 70 daily × 3 days + 100 + 100 unlocking under separate
// qualification gates). Keep this export aligned for older callers; do not
// introduce a second amount that can drift from WELCOME_L0_TOKENS. The only
// remaining production caller is the welcome test's alias-parity assertion,
// so the parity test (not a copy) is what keeps this from drifting.
const configuredWelcomeL0 = Number(process.env.WELCOME_L0_TOKENS ?? 210);
export const SIGNUP_BONUS_CREDITS =
  Number.isInteger(configuredWelcomeL0) && configuredWelcomeL0 >= 0 ? configuredWelcomeL0 : 210;

export type GrantSourceAccount = 'subscription_grant' | 'pack_grant' | 'bonus_grant' | 'refund';
export type CreditBucketOrigin =
  | 'legacy'
  | 'subscription'
  | 'pack'
  | 'welcome'
  | 'bonus'
  | 'admin'
  | 'refund'
  | 'clawback';

type DbLike = typeof defaultDb;
type Tx = Parameters<Parameters<DbLike['transaction']>[0]>[0];

export type CreditTransactionRow = typeof creditTransactions.$inferSelect;
export type GrantResult = CreditTransactionRow & { inserted: boolean };

type LedgerLegExpectation = Pick<
  CreditTransactionRow,
  'userId' | 'amount' | 'account' | 'relatedJobId' | 'relatedOrderId'
>;

export interface Balance {
  available: number;
  pending: number;
}

export interface GrantInput {
  userId: string;
  amount: number;
  reason: string;
  idempotencyKey: string;
  account: GrantSourceAccount;
  origin?: Exclude<CreditBucketOrigin, 'legacy' | 'clawback'>;
  expiresAt?: Date | null;
  sourceOrderId?: string;
  sourceSubscriptionId?: string;
  cycleNumber?: number;
  tx?: Tx;
}

export interface ReserveInput {
  userId: string;
  jobId: string;
  amount: number;
  reason: string;
  idempotencyKey: string;
  tx?: Tx;
}

export interface CommitInput {
  userId: string;
  jobId: string;
  amount: number;
  idempotencyKey: string;
  reason?: string;
  tx?: Tx;
}

export interface RefundInput {
  userId: string;
  jobId: string;
  amount: number;
  reason: string;
  idempotencyKey: string;
  tx?: Tx;
}

export interface ClawbackInput {
  userId: string;
  /** Positive number of credits to REMOVE from the available pool. */
  amount: number;
  reason: string;
  idempotencyKey: string;
  sourceOrderId?: string;
  tx?: Tx;
}

export interface TransactionsPage {
  rows: CreditTransactionRow[];
  nextCursor: string | null;
}

export interface CreditServiceOptions {
  db?: DbLike;
}

function assertPositiveInt(amount: number): void {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new InvalidAmountError(amount);
  }
}

function encodeCursor(createdAt: Date, id: string): string {
  return `${createdAt.toISOString()}|${id}`;
}

function decodeCursor(raw: string): { createdAt: Date; id: string } | null {
  const idx = raw.indexOf('|');
  if (idx < 0) return null;
  const iso = raw.slice(0, idx);
  const id = raw.slice(idx + 1);
  const createdAt = new Date(iso);
  if (Number.isNaN(createdAt.getTime()) || !id) return null;
  return { createdAt, id };
}

export class CreditService {
  private readonly db: DbLike;

  constructor(opts: CreditServiceOptions = {}) {
    this.db = opts.db ?? defaultDb;
  }

  async balanceFor(userId: string): Promise<Balance> {
    return this.bucketBalance(this.db, userId);
  }

  private async bucketBalance(runner: DbLike | Tx, userId: string): Promise<Balance> {
    const rows = await runner
      .select({
        available: sql<string>`COALESCE(SUM(CASE WHEN (${creditBuckets.expiresAt} IS NULL OR ${creditBuckets.expiresAt} > now()) THEN ${creditBuckets.granted} - ${creditBuckets.reserved} - ${creditBuckets.consumed} ELSE 0 END), 0)`,
        pending: sql<string>`COALESCE(SUM(${creditBuckets.reserved}), 0)`,
      })
      .from(creditBuckets)
      .where(eq(creditBuckets.userId, userId));
    return {
      available: Number(rows[0]?.available ?? 0),
      pending: Number(rows[0]?.pending ?? 0),
    };
  }

  async transactionsFor(
    userId: string,
    { limit = 50, cursor }: { limit?: number; cursor?: string } = {},
  ): Promise<TransactionsPage> {
    const safeLimit = Math.max(1, Math.min(200, limit));
    // Composite (created_at, id) cursor — nid() is random, so ORDER BY id alone
    // is not time-ordered and identically-timestamped or late-arriving rows
    // could be skipped or duplicated across pages.
    const filters = [eq(creditTransactions.userId, userId)];
    if (cursor) {
      const parsed = decodeCursor(cursor);
      if (parsed) {
        filters.push(
          or(
            sql`${creditTransactions.createdAt} < ${parsed.createdAt}`,
            and(
              eq(creditTransactions.createdAt, parsed.createdAt),
              sql`${creditTransactions.id} < ${parsed.id}`,
            ),
          )!,
        );
      }
    }

    const rows = await this.db
      .select()
      .from(creditTransactions)
      .where(and(...filters))
      .orderBy(desc(creditTransactions.createdAt), desc(creditTransactions.id))
      .limit(safeLimit + 1);

    const hasMore = rows.length > safeLimit;
    const page = hasMore ? rows.slice(0, safeLimit) : rows;
    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? encodeCursor(last.createdAt, last.id) : null;
    return { rows: page, nextCursor };
  }

  async grant(input: GrantInput): Promise<GrantResult> {
    assertPositiveInt(input.amount);
    return this.runIn(input.tx, async (tx) => {
      const leg = await this.upsertLeg(tx, {
        idempotencyKey: input.idempotencyKey,
        userId: input.userId,
        amount: input.amount,
        account: input.account,
        reason: input.reason,
        relatedOrderId: input.sourceOrderId ?? null,
        relatedJobId: null,
      });
      // The ledger's idempotency insert is the only creation gate. A replay
      // returns the existing leg and must not create or attach a bucket.
      if (!leg.inserted) return { ...leg.row, inserted: false };

      const bucketId = nid();
      const origin = input.origin ?? originForAccount(input.account);
      await tx.insert(creditBuckets).values({
        id: bucketId,
        userId: input.userId,
        origin,
        priority: priorityForOrigin(origin),
        granted: input.amount,
        expiresAt: input.expiresAt ?? null,
        grantKey: input.idempotencyKey,
        relatedOrderId: input.sourceOrderId ?? null,
        relatedSubscriptionId: input.sourceSubscriptionId ?? null,
        cycleNumber: input.cycleNumber ?? null,
      });
      const updated = await tx
        .update(creditTransactions)
        .set({ bucketId })
        .where(eq(creditTransactions.id, leg.row.id))
        .returning();
      return { ...updated[0]!, inserted: true };
    });
  }

  async reserve(input: ReserveInput): Promise<{
    available: CreditTransactionRow;
    pending: CreditTransactionRow;
  }> {
    assertPositiveInt(input.amount);
    return this.runIn(input.tx, async (tx) => {
      // Lock before checking idempotency. Otherwise two replays can both see no
      // ledger pair and mutate different buckets after serializing one-by-one.
      await this.lockUser(tx, input.userId);
      const existingPair = await this.findPairByParentKey(
        tx,
        input.idempotencyKey,
        ['available', 'pending'],
        {
          available: {
            userId: input.userId,
            amount: -input.amount,
            account: 'available',
            relatedJobId: input.jobId,
            relatedOrderId: null,
          },
          pending: {
            userId: input.userId,
            amount: input.amount,
            account: 'pending',
            relatedJobId: input.jobId,
            relatedOrderId: null,
          },
        },
      );
      if (existingPair)
        return existingPair as { available: CreditTransactionRow; pending: CreditTransactionRow };

      const allocations = await this.allocateLiveBuckets(tx, input.userId, input.amount);

      const available = await this.upsertLeg(tx, {
        idempotencyKey: `${input.idempotencyKey}:available`,
        userId: input.userId,
        amount: -input.amount,
        account: 'available',
        reason: input.reason,
        relatedJobId: input.jobId,
        relatedOrderId: null,
      });
      const pending = await this.upsertLeg(tx, {
        idempotencyKey: `${input.idempotencyKey}:pending`,
        userId: input.userId,
        amount: input.amount,
        account: 'pending',
        reason: input.reason,
        relatedJobId: input.jobId,
        relatedOrderId: null,
      });
      for (const allocation of allocations) {
        await tx
          .update(creditBuckets)
          .set({ reserved: sql`${creditBuckets.reserved} + ${allocation.amount}` })
          .where(
            and(eq(creditBuckets.id, allocation.bucketId), eq(creditBuckets.userId, input.userId)),
          );
        await tx.insert(creditBucketAllocations).values({
          id: nid(),
          bucketId: allocation.bucketId,
          userId: input.userId,
          jobId: input.jobId,
          kind: 'reserve',
          amount: allocation.amount,
          idempotencyKey: `${input.idempotencyKey}:bucket:${allocation.bucketId}`,
        });
      }
      return { available: available.row, pending: pending.row };
    });
  }

  // SF-10: validate that the job's outstanding reservation covers `amount`
  // before settling, so a buggy enqueuer can't book spend that was never
  // reserved (would otherwise silently corrupt the available/pending balance).
  async commit(input: CommitInput): Promise<{
    pending: CreditTransactionRow;
    spend: CreditTransactionRow;
  }> {
    assertPositiveInt(input.amount);
    const reason = input.reason ?? 'job.commit';
    return this.runIn(input.tx, async (tx) => {
      await this.lockUser(tx, input.userId);
      const existingPair = await this.findPairByParentKey(
        tx,
        input.idempotencyKey,
        ['pending', 'spend'],
        {
          pending: {
            userId: input.userId,
            amount: -input.amount,
            account: 'pending',
            relatedJobId: input.jobId,
            relatedOrderId: null,
          },
          spend: {
            userId: input.userId,
            amount: input.amount,
            account: 'spend',
            relatedJobId: input.jobId,
            relatedOrderId: null,
          },
        },
      );
      if (existingPair)
        return existingPair as { pending: CreditTransactionRow; spend: CreditTransactionRow };

      const allocations = await this.outstandingReservationAllocations(
        tx,
        input.userId,
        input.jobId,
        input.amount,
      );

      const pending = await this.upsertLeg(tx, {
        idempotencyKey: `${input.idempotencyKey}:pending`,
        userId: input.userId,
        amount: -input.amount,
        account: 'pending',
        reason,
        relatedJobId: input.jobId,
        relatedOrderId: null,
      });
      const spend = await this.upsertLeg(tx, {
        idempotencyKey: `${input.idempotencyKey}:spend`,
        userId: input.userId,
        amount: input.amount,
        account: 'spend',
        reason,
        relatedJobId: input.jobId,
        relatedOrderId: null,
      });
      for (const allocation of allocations) {
        await tx
          .update(creditBuckets)
          .set({
            reserved: sql`${creditBuckets.reserved} - ${allocation.amount}`,
            consumed: sql`${creditBuckets.consumed} + ${allocation.amount}`,
          })
          .where(
            and(eq(creditBuckets.id, allocation.bucketId), eq(creditBuckets.userId, input.userId)),
          );
        await tx.insert(creditBucketAllocations).values({
          id: nid(),
          bucketId: allocation.bucketId,
          userId: input.userId,
          jobId: input.jobId,
          kind: 'commit',
          amount: allocation.amount,
          idempotencyKey: `${input.idempotencyKey}:bucket:${allocation.bucketId}`,
        });
      }
      return { pending: pending.row, spend: spend.row };
    });
  }

  // SF-10: same reservation-cover guard as commit — never refund more than the
  // job's outstanding reservation.
  async refund(input: RefundInput): Promise<{
    pending: CreditTransactionRow;
    refund: CreditTransactionRow;
  }> {
    assertPositiveInt(input.amount);
    return this.runIn(input.tx, async (tx) => {
      await this.lockUser(tx, input.userId);
      const existingPair = await this.findPairByParentKey(
        tx,
        input.idempotencyKey,
        ['pending', 'refund'],
        {
          pending: {
            userId: input.userId,
            amount: -input.amount,
            account: 'pending',
            relatedJobId: input.jobId,
            relatedOrderId: null,
          },
          refund: {
            userId: input.userId,
            amount: input.amount,
            account: 'refund',
            relatedJobId: input.jobId,
            relatedOrderId: null,
          },
        },
      );
      if (existingPair)
        return existingPair as { pending: CreditTransactionRow; refund: CreditTransactionRow };

      const allocations = await this.outstandingReservationAllocations(
        tx,
        input.userId,
        input.jobId,
        input.amount,
      );

      const pending = await this.upsertLeg(tx, {
        idempotencyKey: `${input.idempotencyKey}:pending`,
        userId: input.userId,
        amount: -input.amount,
        account: 'pending',
        reason: input.reason,
        relatedJobId: input.jobId,
        relatedOrderId: null,
      });
      const refund = await this.upsertLeg(tx, {
        idempotencyKey: `${input.idempotencyKey}:refund`,
        userId: input.userId,
        amount: input.amount,
        account: 'refund',
        reason: input.reason,
        relatedJobId: input.jobId,
        relatedOrderId: null,
      });
      for (const allocation of allocations) {
        await tx
          .update(creditBuckets)
          .set({ reserved: sql`${creditBuckets.reserved} - ${allocation.amount}` })
          .where(
            and(eq(creditBuckets.id, allocation.bucketId), eq(creditBuckets.userId, input.userId)),
          );
        await tx.insert(creditBucketAllocations).values({
          id: nid(),
          bucketId: allocation.bucketId,
          userId: input.userId,
          jobId: input.jobId,
          kind: 'release',
          amount: allocation.amount,
          idempotencyKey: `${input.idempotencyKey}:bucket:${allocation.bucketId}`,
        });
      }
      return { pending: pending.row, refund: refund.row };
    });
  }

  /**
   * Clawback: remove `amount` credits from the available pool with a single
   * negative `available` leg. Used to reverse a granted purchase on refund/
   * cancel (BL-14). Idempotent on `idempotencyKey`; the balance is allowed to go
   * negative when the user already spent the refunded credits (they no longer
   * own that spending power). NOTE: not a reservation — this is a permanent
   * adjustment, so it writes a single leg, unlike reserve's available+pending pair.
   */
  async clawback(input: ClawbackInput): Promise<CreditTransactionRow> {
    assertPositiveInt(input.amount);
    return this.runIn(input.tx, async (tx) => {
      // Clawback now reads and changes bucket capacity, so it shares the user
      // lock with reserve/commit/refund.
      await this.lockUser(tx, input.userId);
      const leg = await this.upsertLeg(tx, {
        idempotencyKey: input.idempotencyKey,
        userId: input.userId,
        amount: -input.amount,
        account: 'available',
        reason: input.reason,
        relatedJobId: null,
        relatedOrderId: input.sourceOrderId ?? null,
      });
      if (!leg.inserted) return leg.row;

      const buckets = await this.clawbackBuckets(tx, input.userId, input.sourceOrderId ?? null);
      let remaining = input.amount;
      for (const bucket of buckets) {
        if (remaining === 0) break;
        const available = bucket.granted - bucket.reserved - bucket.consumed;
        const amount = Math.min(remaining, Math.max(0, available));
        if (amount === 0) continue;
        await tx
          .update(creditBuckets)
          .set({ granted: sql`${creditBuckets.granted} - ${amount}` })
          .where(and(eq(creditBuckets.id, bucket.id), eq(creditBuckets.userId, input.userId)));
        await tx.insert(creditBucketAllocations).values({
          id: nid(),
          bucketId: bucket.id,
          userId: input.userId,
          jobId: null,
          kind: 'clawback',
          amount,
          idempotencyKey: `${input.idempotencyKey}:bucket:${bucket.id}`,
        });
        remaining -= amount;
      }

      if (remaining === 0) return leg.row;
      const bucketId = nid();
      await tx.insert(creditBuckets).values({
        id: bucketId,
        userId: input.userId,
        origin: 'clawback',
        priority: 3,
        granted: -remaining,
        expiresAt: null,
        grantKey: input.idempotencyKey,
        relatedOrderId: input.sourceOrderId ?? null,
      });
      await tx.insert(creditBucketAllocations).values({
        id: nid(),
        bucketId,
        userId: input.userId,
        jobId: null,
        kind: 'clawback',
        amount: remaining,
        idempotencyKey: `${input.idempotencyKey}:bucket:${bucketId}`,
      });
      const updated = await tx
        .update(creditTransactions)
        .set({ bucketId })
        .where(eq(creditTransactions.id, leg.row.id))
        .returning();
      return updated[0]!;
    });
  }

  /**
   * Sum the positive grant legs tied to an
   * order — i.e. exactly what was credited for that purchase. Drives the refund
   * clawback amount so we reverse precisely what was granted (BL-14).
   */
  async grantedForOrder(orderId: string, runner: DbLike | Tx = this.db): Promise<number> {
    const rows = await runner
      .select({ sum: sql<string>`COALESCE(SUM(${creditTransactions.amount}), 0)` })
      .from(creditTransactions)
      .where(
        and(
          eq(creditTransactions.relatedOrderId, orderId),
          inArray(creditTransactions.account, ['pack_grant', 'subscription_grant', 'bonus_grant']),
        ),
      );
    return Number(rows[0]?.sum ?? 0);
  }

  /**
   * Total credits already clawed back for an order (positive). Clawback legs are
   * the only `available`-account rows tagged with a `relatedOrderId`, so this is
   * an exact per-order tally — used to cap cumulative reversal at the grant and
   * stay correct across partial refunds + retries (BL-14).
   */
  async clawedBackForOrder(orderId: string, runner: DbLike | Tx = this.db): Promise<number> {
    const rows = await runner
      .select({ sum: sql<string>`COALESCE(SUM(${creditTransactions.amount}), 0)` })
      .from(creditTransactions)
      .where(
        and(
          eq(creditTransactions.relatedOrderId, orderId),
          eq(creditTransactions.account, 'available'),
        ),
      );
    return -Number(rows[0]?.sum ?? 0);
  }

  /**
   * Run `fn` inside the supplied transaction if any, otherwise open a new one.
   * Lets callers (e.g. POST /v1/jobs) atomically insert other rows + reserve
   * credits in a single connection, avoiding lock upgrades on shared FK
   * targets (the original deadlock: outer tx held an FK share-lock on
   * users_app, inner tx tried SELECT FOR UPDATE on the same row).
   */
  private runIn<T>(tx: Tx | undefined, fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (tx) return fn(tx);
    return this.db.transaction(fn);
  }

  /**
   * Row-lock the user's `users_app` row for the rest of the tx so concurrent
   * mutations of the same user's balance/reservations serialize. Throws if the
   * user does not exist. Re-locking the same row within one tx is a no-op.
   */
  private async lockUser(tx: Tx, userId: string): Promise<void> {
    const locked = await tx
      .select({ id: usersApp.id })
      .from(usersApp)
      .where(eq(usersApp.id, userId))
      .for('update');
    if (locked.length === 0) {
      throw new Error(`unknown user ${userId}`);
    }
  }

  /**
   * SF-10: the sum of a job's outstanding `pending` legs must cover `amount`
   * before a commit/refund settles against it. Reserve writes +amount pending;
   * commit/refund write −amount. A caller settling more than was reserved (or
   * settling twice) would drive the pending balance negative — we refuse it.
   * The user lock serializes against concurrent commit/refund of the same job
   * so two callers can't both pass the check and over-book.
   */
  private async assertReservationCovers(
    tx: Tx,
    userId: string,
    jobId: string,
    amount: number,
  ): Promise<void> {
    await this.outstandingReservationAllocations(tx, userId, jobId, amount);
  }

  private async upsertLeg(
    tx: Tx,
    row: {
      idempotencyKey: string;
      userId: string;
      amount: number;
      account: (typeof schema.creditAccountEnum.enumValues)[number];
      reason: string;
      relatedJobId: string | null;
      relatedOrderId: string | null;
    },
  ): Promise<{ row: CreditTransactionRow; inserted: boolean }> {
    const inserted = await tx
      .insert(creditTransactions)
      .values({
        id: nid(),
        userId: row.userId,
        amount: row.amount,
        account: row.account,
        reason: row.reason,
        idempotencyKey: row.idempotencyKey,
        relatedJobId: row.relatedJobId,
        relatedOrderId: row.relatedOrderId,
      })
      .onConflictDoNothing({ target: creditTransactions.idempotencyKey })
      .returning();

    if (inserted.length > 0) return { row: inserted[0]!, inserted: true };

    const existing = await tx
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.idempotencyKey, row.idempotencyKey))
      .limit(1);
    if (existing.length === 0) {
      throw new Error(`idempotency race: key ${row.idempotencyKey} neither inserted nor found`);
    }
    const existingRow = existing[0]!;
    // `reason` is descriptive only: callers may default it (for example
    // `job.commit`), so a reason mismatch is not evidence of a different event.
    // relatedJobId/relatedOrderId are also descriptive — the legs for a pair
    // carry the same job, but grant legs legitimately differ in the order they
    // reference. Assert on the identity triple only (main's full leg assertion
    // lives on in findPairByParentKey where all five fields are known).
    if (
      existingRow.userId !== row.userId ||
      existingRow.amount !== row.amount ||
      existingRow.account !== row.account
    ) {
      throw new IdempotencyKeyConflictError(row.idempotencyKey);
    }
    return { row: existingRow, inserted: false };
  }

  private async findPairByParentKey(
    tx: Tx,
    parentKey: string,
    suffixes: readonly string[],
    expected?: Record<string, LedgerLegExpectation>,
  ): Promise<Record<string, CreditTransactionRow> | null> {
    const keys = suffixes.map((s) => `${parentKey}:${s}`);
    const rows = await tx
      .select()
      .from(creditTransactions)
      .where(inArray(creditTransactions.idempotencyKey, keys));
    if (rows.length === 0) return null;
    if (rows.length !== suffixes.length) {
      throw new Error(
        `partial idempotency state for ${parentKey}: found ${rows.length}/${suffixes.length} legs`,
      );
    }
    const out: Record<string, CreditTransactionRow> = {};
    for (const row of rows) {
      const suffix = row.idempotencyKey.slice(parentKey.length + 1);
      out[suffix] = row;
    }
    for (const [suffix, expectation] of Object.entries(expected ?? {})) {
      const row = out[suffix];
      if (!row) throw new Error(`missing idempotency leg ${parentKey}:${suffix}`);
      this.assertLegMatches(row, expectation);
    }
    return out;
  }

  private assertLegMatches(existing: CreditTransactionRow, expected: LedgerLegExpectation): void {
    if (
      existing.userId !== expected.userId ||
      existing.amount !== expected.amount ||
      existing.account !== expected.account ||
      existing.relatedJobId !== expected.relatedJobId ||
      existing.relatedOrderId !== expected.relatedOrderId
    ) {
      throw new IdempotencyKeyConflictError(existing.idempotencyKey);
    }
  }

  private async allocateLiveBuckets(
    tx: Tx,
    userId: string,
    amount: number,
  ): Promise<Array<{ bucketId: string; amount: number }>> {
    const balance = await this.bucketBalance(tx, userId);
    if (balance.available < amount) {
      throw new InsufficientCreditsError(balance.available, amount);
    }
    const buckets = await this.spendableBuckets(tx, userId);
    let remaining = amount;
    const allocations: Array<{ bucketId: string; amount: number }> = [];
    for (const bucket of buckets) {
      if (remaining === 0) break;
      const available = bucket.granted - bucket.reserved - bucket.consumed;
      const taken = Math.min(remaining, Math.max(0, available));
      if (taken === 0) continue;
      allocations.push({ bucketId: bucket.id, amount: taken });
      remaining -= taken;
    }
    if (remaining > 0) throw new InsufficientCreditsError(balance.available - remaining, amount);
    return allocations;
  }

  private spendOrder() {
    return [
      asc(creditBuckets.priority),
      sql`${creditBuckets.expiresAt} ASC NULLS LAST`,
      asc(creditBuckets.createdAt),
    ] as const;
  }

  private async spendableBuckets(tx: Tx, userId: string) {
    return tx
      .select()
      .from(creditBuckets)
      .where(
        and(
          eq(creditBuckets.userId, userId),
          or(isNull(creditBuckets.expiresAt), sql`${creditBuckets.expiresAt} > now()`),
        ),
      )
      .orderBy(...this.spendOrder());
  }

  private async outstandingReservationAllocations(
    tx: Tx,
    userId: string,
    jobId: string,
    amount: number,
  ): Promise<Array<{ bucketId: string; amount: number }>> {
    await this.lockUser(tx, userId);
    const rows = await tx
      .select({
        bucketId: creditBucketAllocations.bucketId,
        kind: creditBucketAllocations.kind,
        amount: creditBucketAllocations.amount,
      })
      .from(creditBucketAllocations)
      .innerJoin(creditBuckets, eq(creditBucketAllocations.bucketId, creditBuckets.id))
      .where(
        and(
          eq(creditBucketAllocations.userId, userId),
          eq(creditBucketAllocations.jobId, jobId),
          inArray(creditBucketAllocations.kind, ['reserve', 'commit', 'release']),
        ),
      )
      .orderBy(...this.spendOrder());
    const outstanding = new Map<string, number>();
    for (const row of rows) {
      const delta = row.kind === 'reserve' ? row.amount : -row.amount;
      outstanding.set(row.bucketId, (outstanding.get(row.bucketId) ?? 0) + delta);
    }
    let remaining = amount;
    const allocations: Array<{ bucketId: string; amount: number }> = [];
    for (const [bucketId, value] of outstanding) {
      if (remaining === 0) break;
      const taken = Math.min(remaining, Math.max(0, value));
      if (taken === 0) continue;
      allocations.push({ bucketId, amount: taken });
      remaining -= taken;
    }
    if (remaining > 0) throw new UnreservedSpendError(amount - remaining, amount);
    return allocations;
  }

  private async clawbackBuckets(tx: Tx, userId: string, orderId: string | null) {
    const buckets = await tx
      .select()
      .from(creditBuckets)
      .where(eq(creditBuckets.userId, userId))
      .orderBy(...this.spendOrder());
    if (!orderId) return buckets;
    return [
      ...buckets.filter((bucket) => bucket.relatedOrderId === orderId),
      ...buckets.filter((bucket) => bucket.relatedOrderId !== orderId),
    ];
  }
}

function priorityForOrigin(origin: Exclude<CreditBucketOrigin, 'legacy' | 'clawback'>): number {
  if (origin === 'welcome' || origin === 'bonus') return 1;
  if (origin === 'subscription') return 2;
  if (origin === 'pack') return 4;
  return 3;
}

function originForAccount(
  account: GrantSourceAccount,
): Exclude<CreditBucketOrigin, 'legacy' | 'clawback'> {
  if (account === 'subscription_grant') return 'subscription';
  if (account === 'pack_grant') return 'pack';
  if (account === 'bonus_grant') return 'bonus';
  return 'refund';
}

export const creditService = new CreditService();

import 'dotenv/config';
import Fastify, { type FastifyInstance } from 'fastify';
import type IORedis from 'ioredis';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import {
  creditTransactions,
  db,
  nid,
  outboxJobs,
  pool,
  scriptAssistRequests,
  usersApp,
  usersPii,
} from '@seed/db';
import { creditService, type CreditService } from '@seed/credits';
import { PROMPT_STUDIO_CREDITS } from '@seed/shared';
import type { PromptStudioAdapter, PromptStudioInput } from '@seed/provider-prompt-enhancer';
import { setupPromptStudioRoutes } from '../src/prompt-studio';

/**
 * The three crash windows on the «AI-промпт» money path. Each test injects a
 * failure INSIDE the window (between two writes that must be atomic), because a
 * happy-path assertion proves nothing about a crash: the defects are all about
 * what survives when the process dies mid-settlement.
 *
 * The contract being asserted is the one the Scenario paid path already honours
 * (`script-assist.ts` / `script-structurize.ts`):
 *   (a) the ledger hold and the claim's `reserved` marker land together, so the
 *       reaper — which settles ONLY `reserved` claims — can always find the hold;
 *   (b) the paid output is persisted in the same transaction that schedules the
 *       charge, so the user is never charged for output that was not stored;
 *   (c) a refund that cannot be made inline is durably owed via the outbox, and
 *       the claim is only ever marked terminal together with that durable debt.
 */

const COST = PROMPT_STUDIO_CREDITS.claude;

const createdUsers: string[] = [];
/** Outbox rows this file created, by BullMQ jobId — cleanup is scoped to these
 * so a parallel test's evidence is never swept up with ours. */
const createdOutboxJobIds: string[] = [];
const trackOutbox = (claimId: string) => {
  createdOutboxJobIds.push(`prompt_studio-commit-${claimId}`, `prompt_studio-refund-${claimId}`);
};

async function makeFundedUser(credits = 100): Promise<string> {
  const id = nid();
  await db.insert(usersApp).values({ id, displayName: 'PromptStudioCrash', locale: 'ru' });
  await db.insert(usersPii).values({ id, email: `prompt-studio-crash+${id}@seed.local` });
  await creditService.grant({
    userId: id,
    amount: credits,
    reason: 'test.grant',
    idempotencyKey: `test:${id}:grant`,
    account: 'pack_grant',
  });
  createdUsers.push(id);
  return id;
}

function okAdapter(prompt: string): PromptStudioAdapter {
  return { mode: 'live', draft: async (_input: PromptStudioInput) => ({ prompt }) };
}

function failingAdapter(): PromptStudioAdapter {
  return {
    mode: 'live',
    draft: async () => {
      throw new Error('provider unavailable');
    },
  };
}

function fakeRedis(): IORedis {
  return {
    eval: async () => 1,
    incr: async () => 1,
    expire: async () => 1,
    get: async () => '1',
    decrby: async () => 0,
  } as unknown as IORedis;
}

function buildApp(
  userId: string,
  adapter: PromptStudioAdapter,
  credits?: Pick<CreditService, 'reserve' | 'commit' | 'refund'>,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  setupPromptStudioRoutes(app, async () => ({ user: { id: userId } }), fakeRedis(), {
    adapter,
    ...(credits ? { credits } : {}),
  });
  return app.ready().then(() => app);
}

const draft = (app: FastifyInstance, idempotencyKey: string) =>
  app.inject({
    method: 'POST',
    url: '/v1/prompt-studio/draft',
    payload: { brief: 'кот в шляпе', idempotencyKey, model: 'claude' },
  });

const claimFor = async (userId: string) =>
  (
    await db
      .select()
      .from(scriptAssistRequests)
      .where(
        and(eq(scriptAssistRequests.userId, userId), eq(scriptAssistRequests.op, 'prompt_studio')),
      )
      .limit(1)
  )[0];

const legsFor = async (userId: string, account: 'pending' | 'spend' | 'refund') =>
  db
    .select({ amount: creditTransactions.amount })
    .from(creditTransactions)
    .where(and(eq(creditTransactions.userId, userId), eq(creditTransactions.account, account)));

const outboxFor = async (claimId: string) =>
  db
    .select()
    .from(outboxJobs)
    .where(
      inArray(outboxJobs.jobId, [
        `prompt_studio-commit-${claimId}`,
        `prompt_studio-refund-${claimId}`,
      ]),
    );

afterAll(async () => {
  if (createdOutboxJobIds.length) {
    await db.delete(outboxJobs).where(inArray(outboxJobs.jobId, createdOutboxJobIds));
  }
  if (createdUsers.length) {
    await db.delete(usersPii).where(inArray(usersPii.id, createdUsers));
    await db.delete(usersApp).where(inArray(usersApp.id, createdUsers));
  }
  await pool.end();
});

describe('(a) crash between the credit reserve and the claim`s reserved marker', () => {
  it('leaves NO stranded hold: the reserve is rolled back with the marker it never got', async () => {
    const userId = await makeFundedUser();
    const before = await creditService.balanceFor(userId);

    // The process dies the instant `credits.reserve` returns — i.e. exactly in
    // the window between the ledger hold and the `reserved=true` marker. When the
    // two are one transaction the hold rolls back with it; when they are separate
    // writes the hold survives on a claim the reaper refuses to settle
    // (reaper.ts skips rows with reserved=false), so the credits are stranded.
    const crashAfterReserve: Pick<CreditService, 'reserve' | 'commit' | 'refund'> = {
      reserve: async (input) => {
        await creditService.reserve(input);
        throw new Error('process crash between reserve and marker');
      },
      commit: (input) => creditService.commit(input),
      refund: (input) => creditService.refund(input),
    };
    const app = await buildApp(userId, okAdapter('готовый промпт'), crashAfterReserve);

    const res = await draft(app, `k-${nid()}`);
    expect(res.statusCode).toBe(503);

    // The money truth: nothing is held, nothing is missing.
    expect(await creditService.balanceFor(userId)).toEqual(before);
    expect(await legsFor(userId, 'pending')).toHaveLength(0);

    await app.close();
  });

  it('a claim reaped mid-flight does not get an orphan hold: the fenced marker rolls the reserve back', async () => {
    const userId = await makeFundedUser();
    const before = await creditService.balanceFor(userId);

    // The reaper sweeps this claim (deleting the row) while we are reserving.
    // Without a fence the marker update silently hits zero rows and the request
    // charges on: a hold, and later a charge, against a claim row that no longer
    // exists — so nothing can ever reconcile or replay it.
    const reaperDeletesClaim: Pick<CreditService, 'reserve' | 'commit' | 'refund'> = {
      reserve: async (input) => {
        await db.delete(scriptAssistRequests).where(eq(scriptAssistRequests.userId, userId));
        return creditService.reserve(input);
      },
      commit: (input) => creditService.commit(input),
      refund: (input) => creditService.refund(input),
    };
    const app = await buildApp(userId, okAdapter('готовый промпт'), reaperDeletesClaim);

    const res = await draft(app, `k-${nid()}`);
    expect(res.statusCode).toBe(503);

    // Neither held nor charged — the reserve rolled back with the failed fence.
    expect(await creditService.balanceFor(userId)).toEqual(before);
    expect(await legsFor(userId, 'spend')).toHaveLength(0);

    await app.close();
  });
});

describe('(b) crash between the charge and the durable store of the paid prompt', () => {
  it('a prompt that cannot be stored is not charged for: no spend leg, hold released', async () => {
    const userId = await makeFundedUser();
    const before = await creditService.balanceFor(userId);

    // A real durable-store failure in exactly that window: Postgres refuses a
    // \u0000 escape inside jsonb, so persisting this draft's result row fails
    // AFTER the provider already produced it. If the charge is committed before
    // the store, the user pays for a prompt no retry can ever recover.
    const app = await buildApp(userId, okAdapter('промпт\u0000с нулевым байтом'));

    await draft(app, `k-${nid()}`);

    // Either the paid output is durably stored AND charged, or neither happened.
    expect(await legsFor(userId, 'spend')).toHaveLength(0);
    expect(await creditService.balanceFor(userId)).toEqual(before);
    const claim = await claimFor(userId);
    expect(claim?.status).not.toBe('completed');
    expect(claim?.result ?? null).toBeNull();

    await app.close();
  });
});

describe('(c) the inline refund fails', () => {
  it('records the refund as durably owed instead of swallowing it into a terminal claim', async () => {
    const userId = await makeFundedUser();

    // The ledger is unreachable for the refund leg (advisory-lock/DB blip). The
    // hold is real and the user is owed it — a log line the reaper can never act
    // on is not a record: once the claim is terminal, nothing revisits it.
    const refundAlwaysFails: Pick<CreditService, 'reserve' | 'commit' | 'refund'> = {
      reserve: (input) => creditService.reserve(input),
      commit: (input) => creditService.commit(input),
      refund: async () => {
        throw new Error('ledger unavailable');
      },
    };
    const app = await buildApp(userId, failingAdapter(), refundAlwaysFails);

    const res = await draft(app, `k-${nid()}`);
    expect(res.statusCode).toBe(503);

    const claim = await claimFor(userId);
    expect(claim).toBeDefined();
    trackOutbox(claim!.id);
    // The claim IS marked terminal here — that is the assist strategy, and it is
    // only safe because the refund below is durably owed in the SAME transaction.
    // (Terminal with no queued refund is the defect; in_progress with one would
    // be the structurize strategy. This pins which one shipped.)
    expect(claim!.status).toBe('failed');
    expect(claim!.reserved).toBe(true);
    // The hold is still outstanding — someone must still settle it.
    expect((await creditService.balanceFor(userId)).pending).toBe(COST);

    // The debt is durably queued with the canonical settlement key, so the
    // credits worker drives it to completion and the ledger dedupes it against
    // any other party (reaper) settling the same hold.
    const queued = await outboxFor(claim!.id);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.queueName).toBe('credits.refund');
    expect(queued[0]!.processedAt).toBeNull();
    expect(queued[0]!.payload).toMatchObject({
      userId,
      jobId: claim!.id,
      amount: COST,
      idempotencyKey: `prompt_studio:${claim!.id}:refund`,
    });

    await app.close();
  });

  it('when even the durable enqueue fails, the claim stays in_progress + reserved for the reaper', async () => {
    const userId = await makeFundedUser();

    // Inline refund fails AND the transaction that would record the debt fails
    // too — a total settlement outage. The one thing that must NOT happen is a
    // terminal claim: the reaper only sweeps in_progress rows, so marking this
    // failed would erase the last pointer to the customer's money.
    const refundAlwaysFails: Pick<CreditService, 'reserve' | 'commit' | 'refund'> = {
      reserve: (input) => creditService.reserve(input),
      commit: (input) => creditService.commit(input),
      refund: async () => {
        throw new Error('ledger unavailable');
      },
    };
    const realTransaction = db.transaction.bind(db);
    let transactions = 0;
    const spy = vi.spyOn(db, 'transaction').mockImplementation((async (fn: never) => {
      transactions += 1;
      // #1 is the reserve; #2 is settleRefund's durable-debt transaction.
      if (transactions === 2) throw new Error('database unavailable');
      return realTransaction(fn);
    }) as typeof db.transaction);

    try {
      const app = await buildApp(userId, failingAdapter(), refundAlwaysFails);
      const res = await draft(app, `k-${nid()}`);
      expect(res.statusCode).toBe(503);
      await app.close();
    } finally {
      spy.mockRestore();
    }

    const claim = await claimFor(userId);
    trackOutbox(claim!.id);
    expect(claim!.status).toBe('in_progress');
    expect(claim!.reserved).toBe(true);
    // Nothing was recorded as owed, so the hold must remain visible to the reaper
    // (which settles exactly this shape: in_progress + reserved + jobId).
    expect(await outboxFor(claim!.id)).toHaveLength(0);
    expect((await creditService.balanceFor(userId)).pending).toBe(COST);
  });
});

describe('(M2) the claim lease covers the provider call', () => {
  it('is refreshed AFTER slow pre-provider work, so the reaper cannot delete a live request', async () => {
    const userId = await makeFundedUser();
    let leaseDuringDraft: Date | null = null;
    let reserveReturnedAt = 0;

    // The reserve transaction writes its `updatedAt` and then takes 200ms to
    // return (row-lock contention). Without a refresh the lease is already 200ms
    // stale when the provider call — itself up to a minute — begins.
    const realTransaction = db.transaction.bind(db);
    let transactions = 0;
    const spy = vi.spyOn(db, 'transaction').mockImplementation((async (fn: never) => {
      const out = await realTransaction(fn);
      transactions += 1;
      if (transactions === 1) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        reserveReturnedAt = Date.now();
      }
      return out;
    }) as typeof db.transaction);

    const leaseReadingAdapter: PromptStudioAdapter = {
      mode: 'live',
      draft: async () => {
        const claim = await claimFor(userId);
        leaseDuringDraft = claim!.updatedAt;
        return { prompt: 'готовый промпт' };
      },
    };

    try {
      const app = await buildApp(userId, leaseReadingAdapter);
      expect((await draft(app, `k-${nid()}`)).statusCode).toBe(200);
      await app.close();
    } finally {
      spy.mockRestore();
    }

    const claim = await claimFor(userId);
    trackOutbox(claim!.id);
    expect(leaseDuringDraft).not.toBeNull();
    // The lease the provider call runs under was minted after the slow reserve
    // returned, not before it.
    expect(new Date(leaseDuringDraft!).getTime()).toBeGreaterThanOrEqual(reserveReturnedAt - 5);
  });
});

describe('(M3) the completion transaction commits but the client never hears back', () => {
  it('does not refund a charge that actually landed — it returns the stored draft', async () => {
    const userId = await makeFundedUser();
    const before = await creditService.balanceFor(userId);

    // Postgres COMMITs the result+charge transaction and the connection then
    // drops before the acknowledgement arrives. An in-process `committed` flag
    // says "not charged"; the database says otherwise, and it is right.
    const realTransaction = db.transaction.bind(db);
    let transactions = 0;
    const spy = vi.spyOn(db, 'transaction').mockImplementation((async (fn: never) => {
      const out = await realTransaction(fn);
      transactions += 1;
      if (transactions === 2) throw new Error('connection lost after COMMIT');
      return out;
    }) as typeof db.transaction);

    let res;
    try {
      const app = await buildApp(userId, okAdapter('готовый промпт'));
      res = await draft(app, `k-${nid()}`);
      await app.close();
    } finally {
      spy.mockRestore();
    }

    // The customer paid for this draft and gets it.
    expect(res!.statusCode).toBe(200);
    expect(res!.json().prompt).toBe('готовый промпт');

    const claim = await claimFor(userId);
    trackOutbox(claim!.id);
    expect(claim!.status).toBe('completed');

    // Exactly one settlement intent exists for this hold, and it is the commit.
    const queued = await outboxFor(claim!.id);
    expect(queued.map((row) => row.queueName)).toEqual(['credits.commit']);
    expect(await legsFor(userId, 'refund')).toHaveLength(0);
    expect((await creditService.balanceFor(userId)).available).toBe(before.available - COST);
  });
});

describe('(M4) the reaper takes the claim while the refund is being settled', () => {
  it('does not queue a second refund for a debt the reaper already owns', async () => {
    const userId = await makeFundedUser();

    // The inline refund fails, and by the time the fallback runs the reaper has
    // deleted this claim — having already queued the refund itself, under the
    // same canonical key. A blind second enqueue would duplicate durable intent.
    const reaperWinsThenRefundFails: Pick<CreditService, 'reserve' | 'commit' | 'refund'> = {
      reserve: (input) => creditService.reserve(input),
      commit: (input) => creditService.commit(input),
      refund: async () => {
        await db.delete(scriptAssistRequests).where(eq(scriptAssistRequests.userId, userId));
        throw new Error('ledger unavailable');
      },
    };
    const app = await buildApp(userId, failingAdapter(), reaperWinsThenRefundFails);

    const res = await draft(app, `k-${nid()}`);
    expect(res.statusCode).toBe(503);

    // The claim is gone (the reaper deleted it) and we added no settlement of
    // our own — the reaper's refund is the single source of the debt.
    expect(await claimFor(userId)).toBeUndefined();
    const stray = await db
      .select()
      .from(outboxJobs)
      .where(eq(outboxJobs.queueName, 'credits.refund'));
    expect(
      stray.filter((row) => (row.payload as { userId?: string }).userId === userId),
    ).toHaveLength(0);

    await app.close();
  });
});

import 'dotenv/config';
import Fastify, { type FastifyInstance } from 'fastify';
import type IORedis from 'ioredis';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import {
  db,
  nid,
  pool,
  creditTransactions,
  outboxJobs,
  scriptAssistRequests,
  usersApp,
  usersPii,
} from '@seed/db';
import { creditService } from '@seed/credits';
import {
  PROMPT_STUDIO_BRIEF_CHAR_LIMIT,
  PROMPT_STUDIO_CREDITS,
  PROMPT_STUDIO_INPUT_TOKEN_LIMIT,
} from '@seed/shared';
import {
  promptStudioProviderInput,
  type PromptStudioAdapter,
  type PromptStudioInput,
} from '@seed/provider-prompt-enhancer';
import {
  estimatePromptStudioInputTokens,
  fitSceneContext,
  promptStudioRequestHash,
  setupPromptStudioRoutes,
} from '../src/prompt-studio';

/**
 * Regression coverage for the reserve→draft→settle money path. The charge is
 * scheduled through the durable outbox in the SAME transaction that stores the
 * paid draft, so the two can never separate: a 200 always leaves both a
 * replayable result row and a queued commit, and a failure before that
 * transaction always leaves the user refunded.
 */

const COST = PROMPT_STUDIO_CREDITS.claude;

const createdUsers: string[] = [];

async function makeFundedUser(credits = 100): Promise<string> {
  const id = nid();
  await db.insert(usersApp).values({ id, displayName: 'PromptStudioTest', locale: 'ru' });
  await db.insert(usersPii).values({ id, email: `prompt-studio-test+${id}@seed.local` });
  if (credits > 0) {
    await creditService.grant({
      userId: id,
      amount: credits,
      reason: 'test.grant',
      idempotencyKey: `test:${id}:grant`,
      account: 'pack_grant',
    });
  }
  createdUsers.push(id);
  return id;
}

function adapterReturning(prompt: string, seen?: PromptStudioInput[]): PromptStudioAdapter {
  return {
    mode: 'live',
    draft: async (input: PromptStudioInput) => {
      seen?.push(input);
      return { prompt };
    },
  };
}

describe('fitSceneContext', () => {
  it('uses a UTF-8 byte upper bound for dense Unicode', () => {
    const latin: PromptStudioInput = { brief: 'a', kind: 'video', model: 'claude' };
    const cyrillic: PromptStudioInput = { brief: 'я', kind: 'video', model: 'claude' };
    expect(estimatePromptStudioInputTokens(latin)).toBe(
      Buffer.byteLength(promptStudioProviderInput(latin), 'utf8'),
    );
    expect(estimatePromptStudioInputTokens(cyrillic)).toBe(
      Buffer.byteLength(promptStudioProviderInput(cyrillic), 'utf8'),
    );
    expect(estimatePromptStudioInputTokens(cyrillic)).toBeGreaterThan(
      estimatePromptStudioInputTokens(latin),
    );
  });

  it('keeps a small context byte-for-byte', () => {
    const input: PromptStudioInput = {
      brief: 'кот',
      kind: 'video',
      model: 'claude',
      sceneContext: 'КАФЕ · Анна',
    };
    expect(fitSceneContext(input, PROMPT_STUDIO_INPUT_TOKEN_LIMIT)).toBe(input);
  });

  it('shortens context while preserving the brief and refs', () => {
    const input: PromptStudioInput = {
      brief: 'a'.repeat(160),
      kind: 'video',
      model: 'claude',
      refMentions: [{ token: '@image1', kind: 'image', label: 'A'.repeat(10) }],
      sceneContext: 'я'.repeat(400),
    };
    const fitted = fitSceneContext(input, 1700);
    expect(fitted.brief).toBe(input.brief);
    expect(fitted.refMentions).toEqual(input.refMentions);
    expect(fitted.sceneContext?.length).toBeGreaterThan(0);
    expect(fitted.sceneContext?.length).toBeLessThan(input.sceneContext.length);
    expect(estimatePromptStudioInputTokens(fitted)).toBeLessThanOrEqual(1700);
  });

  it('leaves an input already over the limit without context unchanged', () => {
    const input: PromptStudioInput = { brief: 'я'.repeat(1000), kind: 'video', model: 'claude' };
    expect(fitSceneContext(input, 1)).toEqual(input);
  });
});

function adapterThatFails(): PromptStudioAdapter {
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

function buildApp(user: { id: string }, adapter: PromptStudioAdapter): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  setupPromptStudioRoutes(app, async () => ({ user }), fakeRedis(), { adapter });
  return app.ready().then(() => app);
}

const balanceOf = async (userId: string) => (await creditService.balanceFor(userId)).available;

/** Outbox rows this file created, by BullMQ jobId — cleanup stays scoped to
 * them so a parallel test's evidence is never swept up with ours. */
const createdOutboxJobIds: string[] = [];
const outboxIdsFor = (claimId: string) => [
  `prompt_studio-commit-${claimId}`,
  `prompt_studio-refund-${claimId}`,
];

/**
 * Do to the queued rows exactly what the credits worker's processors do, then
 * mark them processed. Asserting only that an intent row EXISTS would pass even
 * if the payload were unsettleable; the ledger state after it runs is the real
 * proof. Returns which settlements ran.
 */
async function settleQueued(claimId: string): Promise<string[]> {
  const rows = await db
    .select()
    .from(outboxJobs)
    .where(inArray(outboxJobs.jobId, outboxIdsFor(claimId)));
  const applied: string[] = [];
  for (const row of rows) {
    const payload = row.payload as {
      userId: string;
      jobId: string;
      amount: number;
      reason: string;
      idempotencyKey: string;
    };
    if (row.queueName === 'credits.commit') await creditService.commit(payload);
    else await creditService.refund(payload);
    await db.update(outboxJobs).set({ processedAt: new Date() }).where(eq(outboxJobs.id, row.id));
    applied.push(row.queueName);
  }
  return applied;
}

const legsFor = async (userId: string, account: 'spend' | 'refund' | 'pending') =>
  db
    .select({ amount: creditTransactions.amount })
    .from(creditTransactions)
    .where(and(eq(creditTransactions.userId, userId), eq(creditTransactions.account, account)));

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

describe('POST /v1/prompt-studio/draft — money path after commit', () => {
  it('rejects a brief above the industry-aligned 1,000-character field cap before egress', async () => {
    const userId = await makeFundedUser();
    const seen: PromptStudioInput[] = [];
    const app = await buildApp({ id: userId }, adapterReturning('не должен вызваться', seen));
    const response = await app.inject({
      method: 'POST',
      url: '/v1/prompt-studio/draft',
      payload: {
        brief: 'я'.repeat(PROMPT_STUDIO_BRIEF_CHAR_LIMIT + 1),
        idempotencyKey: `k-${nid()}`,
        model: 'claude',
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('brief_too_long');
    expect(seen).toHaveLength(0);
    await app.close();
  });

  it('rejects reference tokens beyond the board vocabulary before egress', async () => {
    const userId = await makeFundedUser();
    const seen: PromptStudioInput[] = [];
    const app = await buildApp({ id: userId }, adapterReturning('не должен вызваться', seen));
    const response = await app.inject({
      method: 'POST',
      url: '/v1/prompt-studio/draft',
      payload: {
        brief: 'кот в шляпе',
        refMentions: [{ token: '@image1000', kind: 'image', label: 'слишком длинный индекс' }],
        idempotencyKey: `k-${nid()}`,
        model: 'claude',
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('invalid_body');
    expect(seen).toHaveLength(0);
    await app.close();
  });

  it('clamps a provider result to the industry-aligned 1,000-character field cap', async () => {
    const userId = await makeFundedUser();
    const app = await buildApp({ id: userId }, adapterReturning('я'.repeat(2_000)));
    const response = await app.inject({
      method: 'POST',
      url: '/v1/prompt-studio/draft',
      payload: {
        brief: 'кот в шляпе',
        idempotencyKey: `k-${nid()}`,
        model: 'claude',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().prompt).toHaveLength(1_000);
    await app.close();
  });

  it('returns and replays a bounded scene context', async () => {
    const userId = await makeFundedUser();
    const seen: PromptStudioInput[] = [];
    const app = await buildApp({ id: userId }, adapterReturning('готовый промпт', seen));
    const idempotencyKey = `k-${nid()}`;
    const payload = {
      brief: 'a'.repeat(300),
      refMentions: [
        { token: '@image1', kind: 'image', label: 'A'.repeat(40) },
        { token: '@image2', kind: 'image', label: 'B'.repeat(40) },
        { token: '@video1', kind: 'video', label: 'C'.repeat(40) },
      ],
      sceneContext: `${'слово '.repeat(65)}слово`,
      idempotencyKey,
      model: 'claude',
    };
    const expected = fitSceneContext(
      {
        brief: payload.brief,
        kind: 'video',
        model: 'claude',
        refMentions: payload.refMentions,
        sceneContext: payload.sceneContext,
      },
      PROMPT_STUDIO_INPUT_TOKEN_LIMIT,
    ).sceneContext;
    expect(expected).toBeTruthy();
    expect(expected).not.toBe(payload.sceneContext);
    expect(expected!.length).toBeLessThan(payload.sceneContext.length);
    const response = await app.inject({ method: 'POST', url: '/v1/prompt-studio/draft', payload });
    expect(response.statusCode).toBe(200);
    expect(response.json().sceneContext).toBe(expected);
    expect(seen[0]?.sceneContext).toBe(expected);

    const replay = await app.inject({ method: 'POST', url: '/v1/prompt-studio/draft', payload });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().sceneContext).toBe(expected);
    await app.close();
  });

  it('stores and echoes an entirely marker-only context as empty', async () => {
    const userId = await makeFundedUser();
    const seen: PromptStudioInput[] = [];
    const app = await buildApp({ id: userId }, adapterReturning('готовый промпт', seen));
    const payload = {
      brief: 'кот в шляпе',
      sceneContext: '<<<СЦЕНА',
      idempotencyKey: `k-${nid()}`,
      model: 'claude',
    };

    const response = await app.inject({ method: 'POST', url: '/v1/prompt-studio/draft', payload });
    expect(response.statusCode).toBe(200);
    expect(response.json().sceneContext).toBe('');
    expect(seen[0]?.sceneContext).toBe('');
    await app.close();
  });

  it('accepts a byte-safe brief and reference envelope before egress', async () => {
    const userId = await makeFundedUser();
    const seen: PromptStudioInput[] = [];
    const app = await buildApp({ id: userId }, adapterReturning('максимальный промпт', seen));
    const response = await app.inject({
      method: 'POST',
      url: '/v1/prompt-studio/draft',
      payload: {
        brief: 'a'.repeat(500),
        refMentions: Array.from({ length: 6 }, (_, index) => ({
          token: `@image${index + 1}`,
          kind: 'image',
          label: 'A'.repeat(40),
        })),
        sceneContext: '',
        idempotencyKey: `k-${nid()}`,
        model: 'claude',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(seen[0]).toBeDefined();
    expect(estimatePromptStudioInputTokens(seen[0]!)).toBeLessThanOrEqual(
      PROMPT_STUDIO_INPUT_TOKEN_LIMIT,
    );
    await app.close();
  });

  it('replays a legacy completed claim without a sceneContext as empty', async () => {
    const userId = await makeFundedUser(0);
    const idempotencyKey = `k-${nid()}`;
    await db.insert(scriptAssistRequests).values({
      id: nid(),
      userId,
      idempotencyKey,
      op: 'prompt_studio',
      status: 'completed',
      result: { prompt: 'старый промпт', mode: 'live' },
      jobId: nid(),
      amount: COST,
    });
    const app = await buildApp({ id: userId }, adapterReturning('не должен вызваться'));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/prompt-studio/draft',
      payload: { brief: 'кот', idempotencyKey, model: 'claude' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ prompt: 'старый промпт', sceneContext: '' });
    await app.close();
  });

  it('completionLanded returns the stored scene context after an ambiguous commit', async () => {
    const userId = await makeFundedUser();
    const realTransaction = db.transaction.bind(db);
    let transactions = 0;
    const spy = vi.spyOn(db, 'transaction').mockImplementation((async (fn: never) => {
      const result = await realTransaction(fn);
      transactions += 1;
      if (transactions === 2) throw new Error('connection lost after COMMIT');
      return result;
    }) as typeof db.transaction);

    let response;
    try {
      const app = await buildApp({ id: userId }, adapterReturning('готовый промпт'));
      response = await app.inject({
        method: 'POST',
        url: '/v1/prompt-studio/draft',
        payload: {
          brief: 'кот',
          sceneContext: 'КАФЕ · Анна',
          idempotencyKey: `k-${nid()}`,
          model: 'claude',
        },
      });
      await app.close();
    } finally {
      spy.mockRestore();
    }

    expect(response!.statusCode).toBe(200);
    expect(response!.json().sceneContext).toBe('КАФЕ · Анна');
    const [claim] = await db
      .select({ id: scriptAssistRequests.id })
      .from(scriptAssistRequests)
      .where(eq(scriptAssistRequests.userId, userId))
      .limit(1);
    createdOutboxJobIds.push(...outboxIdsFor(claim!.id));
  });

  it('a 200 leaves the paid draft stored AND its charge queued, and replays for the same key without charging twice', async () => {
    const userId = await makeFundedUser();
    const before = await balanceOf(userId);
    const app = await buildApp({ id: userId }, adapterReturning('готовый промпт'));
    const idempotencyKey = `k-${nid()}`;

    const res = await app.inject({
      method: 'POST',
      url: '/v1/prompt-studio/draft',
      payload: { brief: 'кот в шляпе', idempotencyKey, model: 'claude' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().prompt).toBe('готовый промпт');
    // Debited exactly once. (The hold moves pending→spend when the credits
    // worker drains the queued commit; the user's available balance — the only
    // number they see — is already correct.)
    expect(await balanceOf(userId)).toBe(before - COST);

    // The paid draft is durably stored...
    const [claim] = await db
      .select()
      .from(scriptAssistRequests)
      .where(
        and(
          eq(scriptAssistRequests.userId, userId),
          eq(scriptAssistRequests.idempotencyKey, idempotencyKey),
        ),
      );
    expect(claim?.status).toBe('completed');
    expect(claim?.result).toEqual({ prompt: 'готовый промпт', mode: 'live', sceneContext: '' });

    // ...and its charge is queued in the same breath, under the canonical key
    // every other settler (reaper, worker) computes for this claim.
    const queued = await db
      .select()
      .from(outboxJobs)
      .where(eq(outboxJobs.jobId, `prompt_studio-commit-${claim!.id}`));
    expect(queued).toHaveLength(1);
    expect(queued[0]!.queueName).toBe('credits.commit');
    expect(queued[0]!.payload).toMatchObject({
      userId,
      jobId: claim!.id,
      amount: COST,
      idempotencyKey: `prompt_studio:${claim!.id}:commit`,
    });

    createdOutboxJobIds.push(...outboxIdsFor(claim!.id));

    // Run the queued settlement the way the worker would: only then is the
    // charge finished, and it must land exactly once.
    expect(await settleQueued(claim!.id)).toEqual(['credits.commit']);
    expect(await creditService.balanceFor(userId)).toEqual({
      available: before - COST,
      pending: 0,
    });
    expect(await legsFor(userId, 'spend')).toHaveLength(1);
    expect(await legsFor(userId, 'refund')).toHaveLength(0);

    // A retry with the same key replays the stored draft — the output the user
    // paid for is recoverable — without scheduling a second charge.
    const replay = await app.inject({
      method: 'POST',
      url: '/v1/prompt-studio/draft',
      payload: { brief: 'кот в шляпе', idempotencyKey, model: 'claude' },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ prompt: 'готовый промпт', idempotent: true });
    expect(await balanceOf(userId)).toBe(before - COST);
    expect(
      await db
        .select()
        .from(outboxJobs)
        .where(inArray(outboxJobs.jobId, outboxIdsFor(claim!.id))),
    ).toHaveLength(1);
    expect(await legsFor(userId, 'spend')).toHaveLength(1);

    await app.close();
  });

  it('rejects a reused claim key when the paid request changes', async () => {
    const userId = await makeFundedUser();
    const seen: PromptStudioInput[] = [];
    const app = await buildApp({ id: userId }, adapterReturning('готовый промпт', seen));
    const idempotencyKey = `k-${nid()}`;

    const first = await app.inject({
      method: 'POST',
      url: '/v1/prompt-studio/draft',
      payload: { brief: 'кот в шляпе', idempotencyKey, model: 'claude' },
    });
    expect(first.statusCode).toBe(200);

    const [claim] = await db
      .select()
      .from(scriptAssistRequests)
      .where(
        and(
          eq(scriptAssistRequests.userId, userId),
          eq(scriptAssistRequests.idempotencyKey, idempotencyKey),
        ),
      );
    expect(claim?.sourceHash).toBe(
      promptStudioRequestHash({ brief: 'кот в шляпе', kind: 'video', model: 'claude' }),
    );
    createdOutboxJobIds.push(...outboxIdsFor(claim!.id));
    expect(await settleQueued(claim!.id)).toEqual(['credits.commit']);
    const afterFirst = await balanceOf(userId);

    const changed = await app.inject({
      method: 'POST',
      url: '/v1/prompt-studio/draft',
      payload: { brief: 'лиса в шляпе', idempotencyKey, model: 'claude' },
    });
    expect(changed.statusCode).toBe(409);
    expect(changed.json().error).toBe('prompt_studio_idempotency_key_reused');
    expect(await balanceOf(userId)).toBe(afterFirst);
    expect(seen).toHaveLength(1);

    await app.close();
  });

  it('provider failure BEFORE commit is unchanged: refunded exactly once, 503', async () => {
    const userId = await makeFundedUser();
    const before = await balanceOf(userId);
    const app = await buildApp({ id: userId }, adapterThatFails());

    const res = await app.inject({
      method: 'POST',
      url: '/v1/prompt-studio/draft',
      payload: { brief: 'кот в шляпе', idempotencyKey: `k-${nid()}`, model: 'claude' },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('prompt_studio_unavailable');

    // Balance is untouched (reserved, then refunded), with nothing left pending
    // and no charge anywhere ...
    expect(await creditService.balanceFor(userId)).toEqual({ available: before, pending: 0 });
    expect(await legsFor(userId, 'spend')).toHaveLength(0);
    // ... via exactly one refund ledger row.
    const refundRows = await db
      .select({ id: creditTransactions.id })
      .from(creditTransactions)
      .where(and(eq(creditTransactions.userId, userId), eq(creditTransactions.account, 'refund')));
    expect(refundRows).toHaveLength(1);

    await app.close();
  });
});

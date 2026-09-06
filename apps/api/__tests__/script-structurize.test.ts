import 'dotenv/config';
import Fastify, { type FastifyInstance } from 'fastify';
import type IORedis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, like } from 'drizzle-orm';
import {
  db,
  nid,
  pool,
  aiUsageEvents,
  outboxJobs,
  scripts,
  scriptAssistRequests,
  usersApp,
  usersPii,
} from '@seed/db';
import { creditService, CREDIT_COMMIT_QUEUE, CREDIT_REFUND_QUEUE } from '@seed/credits';
import { STRUCTURIZE_CREDITS, STRUCTURIZE_TOKEN_BUDGET } from '@seed/shared';
import { setupScriptStructurizeRoutes } from '../src/script-structurize';

/**
 * Integration tests for POST /v1/scripts/:id/structurize (goal S1). Gateway is
 * ALWAYS mocked (live-spend discipline). Proves: schema-valid output on success,
 * idempotency, one anti-farm-cluster anonymous acquisition call, retry-on-schema-fail,
 * and refund-on-unusable / provider-failure (never charge for an unusable result).
 */

const VALID_OUTPUT = {
  format: 'social',
  brief: { version: 1, goal: 'Научить складывать футболку', durationSeconds: 15 },
  outline: {
    version: 1,
    beats: [
      {
        kind: 'hook',
        title: 'Гора мятых футболок',
        summary: 'Руки над завалом, обещание быстрого способа.',
        durationSeconds: 5,
      },
      {
        kind: 'development',
        title: 'Три точки захвата',
        summary: 'Показываем, где брать ткань пальцами.',
        durationSeconds: 6,
      },
      {
        kind: 'cta',
        title: 'Повтор на скорости',
        summary: 'Пять штук за 10 секунд, призыв сохранить.',
        durationSeconds: 4,
      },
    ],
  },
};
const FILM_OUTPUT = {
  format: 'film',
  brief: { version: 1, goal: 'Киномеханик видит будущее на плёнке и платит за вмешательство.' },
  outline: {
    version: 1,
    beats: [
      {
        kind: 'scene',
        title: 'ИНТ. КИНОБУДКА — НОЧЬ',
        summary: 'Михалыч замечает завтрашние кадры на плёнке.',
      },
      {
        kind: 'scene',
        title: 'НАТ. ПЛОЩАДЬ — ДЕНЬ',
        summary: 'Он бросается предотвратить предсказанную аварию.',
      },
    ],
  },
};

const FOUNTAIN = ['ИНТ. КИНОБУДКА - НОЧЬ', '', 'Тесная будка киномеханика.', ''].join('\n');

const createdUsers: string[] = [];
const createdScripts: string[] = [];

async function makeFundedUser(credits = 100): Promise<string> {
  const id = nid();
  await db.insert(usersApp).values({ id, displayName: 'StructTest', locale: 'ru' });
  await db.insert(usersPii).values({ id, email: `struct-test+${id}@seed.local` });
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

async function makeScript(userId: string, fountain = '') {
  const [row] = await db
    .insert(scripts)
    .values({ id: nid(), userId, title: 'Тест', fountain })
    .returning();
  createdScripts.push(row!.id);
  return row!;
}

/** OpenRouter non-streaming chat mock; returns `contents[callIndex]` (last repeats). */
function mockJsonGateway(
  opts: { contents?: string[]; status?: number; delayMs?: number; usages?: unknown[] } = {},
) {
  const seen: { bodies: Record<string, unknown>[]; calls: number } = { bodies: [], calls: 0 };
  const contents = opts.contents ?? [JSON.stringify(VALID_OUTPUT)];
  const fetchImpl: typeof fetch = async (_url, init) => {
    const call = seen.calls;
    seen.calls += 1;
    seen.bodies.push(JSON.parse(String(init?.body)));
    // Hold the response so the request body is fully consumed while the gateway
    // is still pending — the window a spurious req.raw 'close' abort would hit.
    if (opts.delayMs) await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
    if (opts.status && opts.status !== 200) {
      return new Response('{"error":"boom"}', { status: opts.status });
    }
    const content = contents[Math.min(call, contents.length - 1)]!;
    return new Response(
      JSON.stringify({
        choices: [{ message: { content } }],
        ...(opts.usages?.[Math.min(call, opts.usages.length - 1)]
          ? { usage: opts.usages[Math.min(call, opts.usages.length - 1)] }
          : {}),
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    );
  };
  return { fetchImpl, seen };
}

/**
 * Minimal IORedis stand-in for the spend guard: `eval` (rate-limit + daily
 * reserve Lua) always "allows"; records whether `decrby` (daily-budget release)
 * was called, so a test can assert the daily reservation is retained on failure.
 */
function fakeSpendRedis() {
  const calls = { eval: 0, decrby: 0 };
  const redis = {
    eval: async () => {
      calls.eval += 1;
      return 1; // rate-limit count=1 ≤ max; daily reserve result ≠ -1 → allowed
    },
    decrby: async () => {
      calls.decrby += 1;
      return 0;
    },
    get: async () => '1',
  };
  return { redis: redis as unknown as IORedis, calls };
}

function buildApp(
  user: { id: string; isAnonymous?: boolean },
  fetchImpl: typeof fetch,
  options: Parameters<typeof setupScriptStructurizeRoutes>[2] = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  setupScriptStructurizeRoutes(app, async () => ({ user }), { fetchImpl, ...options });
  return app.ready().then(() => app);
}

const balanceOf = async (userId: string) => (await creditService.balanceFor(userId)).available;

let userId: string;

beforeAll(async () => {
  userId = await makeFundedUser();
});

afterAll(async () => {
  // Durable-settlement outbox rows this suite enqueued (no worker drains them in
  // tests) — clean up so they don't accumulate across runs.
  await db.delete(outboxJobs).where(like(outboxJobs.jobId, 'structurize-%'));
  if (createdScripts.length) await db.delete(scripts).where(inArray(scripts.id, createdScripts));
  if (createdUsers.length) {
    await db.delete(usersPii).where(inArray(usersPii.id, createdUsers));
    await db.delete(usersApp).where(inArray(usersApp.id, createdUsers));
  }
  await pool.end();
});

describe('POST /v1/scripts/:id/structurize', () => {
  it('records both schema-valid transport attempts and charges only the second successful structurize result', async () => {
    const script = await makeScript(userId);
    const { fetchImpl } = mockJsonGateway({
      contents: ['{"format":"film"}', JSON.stringify(VALID_OUTPUT)],
      usages: [
        { prompt_tokens: 10, completion_tokens: 2 },
        { prompt_tokens: 20, completion_tokens: 4 },
      ],
    });
    const app = await buildApp({ id: userId }, fetchImpl, { maxAttempts: 2 });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/structurize`,
      payload: { idempotencyKey: `k-${nid()}`, idea: 'идея' },
    });
    expect(res.statusCode).toBe(200);
    const [saved] = await db
      .select({
        format: scripts.format,
        brief: scripts.brief,
        outline: scripts.outline,
        rev: scripts.rev,
      })
      .from(scripts)
      .where(eq(scripts.id, script.id));
    expect(saved).toMatchObject({
      format: VALID_OUTPUT.format,
      brief: VALID_OUTPUT.brief,
      outline: VALID_OUTPUT.outline,
      rev: script.rev + 1,
    });
    expect(
      await db
        .select({
          attempt: aiUsageEvents.attempt,
          outcome: aiUsageEvents.outcome,
          charged: aiUsageEvents.creditsCharged,
        })
        .from(aiUsageEvents)
        .where(eq(aiUsageEvents.scriptId, script.id))
        .orderBy(aiUsageEvents.attempt),
    ).toEqual([
      { attempt: 1, outcome: 'ok', charged: null },
      { attempt: 2, outcome: 'ok', charged: STRUCTURIZE_CREDITS },
    ]);
    await app.close();
  });

  it('records all schema-miss attempts without a charge when structurize refunds', async () => {
    const script = await makeScript(userId);
    const { fetchImpl } = mockJsonGateway({
      contents: ['{"format":"film"}'],
      usages: [{ prompt_tokens: 10, completion_tokens: 2 }],
    });
    const app = await buildApp({ id: userId }, fetchImpl, { maxAttempts: 2 });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/structurize`,
      payload: { idempotencyKey: `k-${nid()}`, idea: 'идея' },
    });
    expect(res.statusCode).toBe(422);
    expect(
      await db
        .select({ attempt: aiUsageEvents.attempt, charged: aiUsageEvents.creditsCharged })
        .from(aiUsageEvents)
        .where(eq(aiUsageEvents.scriptId, script.id))
        .orderBy(aiUsageEvents.attempt),
    ).toEqual([
      { attempt: 1, charged: null },
      { attempt: 2, charged: null },
    ]);
    await app.close();
  });
  it('structurizes a raw idea into a schema-valid {format, brief, outline} on the economy model, charges once', async () => {
    const script = await makeScript(userId);
    const { fetchImpl, seen } = mockJsonGateway();
    const app = await buildApp({ id: userId }, fetchImpl);
    const before = await balanceOf(userId);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/structurize`,
      payload: { idempotencyKey: `k-${nid()}`, idea: 'Как за 15 секунд сложить футболку.' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.format).toBe('social');
    expect(body.brief.version).toBe(1);
    expect(body.outline.beats).toHaveLength(3);
    expect(body.credits).toBe(STRUCTURIZE_CREDITS);
    // Always the dedicated low-cost structurization model, reasoning disabled, output hard-capped.
    expect(seen.calls).toBe(1);
    expect(seen.bodies[0]!.model).toBe('deepseek/deepseek-v4-flash');
    expect(seen.bodies[0]!.reasoning).toEqual({ enabled: false });
    expect(seen.bodies[0]!.max_tokens).toBe(4_000);
    expect(String((seen.bodies[0]!.messages as { content: string }[])[1]!.content)).toContain(
      'Идея пользователя',
    );

    expect(await balanceOf(userId)).toBe(before - STRUCTURIZE_CREDITS);
    await app.close();
  });

  it("structurizes the script's pasted fountain when no idea is supplied", async () => {
    const script = await makeScript(userId, FOUNTAIN);
    const { fetchImpl, seen } = mockJsonGateway({ contents: [JSON.stringify(FILM_OUTPUT)] });
    const app = await buildApp({ id: userId }, fetchImpl);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/structurize`,
      payload: { idempotencyKey: `k-${nid()}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().format).toBe('film');
    const userMsg = String((seen.bodies[0]!.messages as { content: string }[])[1]!.content);
    expect(userMsg).toContain('Fountain');
    expect(userMsg).toContain('КИНОБУДКА');
    await app.close();
  });

  it('anonymous cluster gets one free structurization, then signup_required, with no charge', async () => {
    const script = await makeScript(userId);
    const { fetchImpl, seen } = mockJsonGateway();
    const app = await buildApp({ id: userId, isAnonymous: true }, fetchImpl);
    const before = await balanceOf(userId);
    const cookie = `seed_did=${nid()}`;
    const guestKey = `guest-${nid()}`;

    const first = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/structurize`,
      headers: { cookie },
      payload: { idempotencyKey: guestKey, idea: 'что-то' },
    });

    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ credits: 0, free: true });
    expect(seen.calls).toBe(1);
    expect(await balanceOf(userId)).toBe(before);

    const replay = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/structurize`,
      headers: { cookie },
      payload: { idempotencyKey: guestKey, idea: 'что-то' },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ credits: 0, free: true });
    expect(seen.calls).toBe(1);

    const second = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/structurize`,
      headers: { cookie },
      payload: { idempotencyKey: `guest-${nid()}`, idea: 'другая идея' },
    });

    expect(second.statusCode).toBe(403);
    expect(second.json()).toMatchObject({
      error: 'signup_required',
      reason: 'free_structurize_used',
    });
    expect(seen.calls).toBe(1);
    expect(await balanceOf(userId)).toBe(before);
    await app.close();
  });

  it('anonymous quote exposes the zero-credit acquisition price without claiming it', async () => {
    const script = await makeScript(userId, FOUNTAIN);
    const { fetchImpl, seen } = mockJsonGateway();
    const app = await buildApp({ id: userId, isAnonymous: true }, fetchImpl);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/structurize/quote`,
      headers: { cookie: `seed_did=${nid()}` },
      payload: { idea: 'короткая гостевая идея' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ credits: 0, free: true, model: expect.any(String) });
    expect(seen.calls).toBe(0);
    await app.close();
  });

  it('idempotency fingerprint covers the WHOLE accepted fountain source', async () => {
    // Two accepted sources that differ only at the tail must be treated as
    // different inputs (no stale replay across a changed revision).
    const shared = 'ИНТ. ДОМ — ДЕНЬ\n' + 'А'.repeat(10_050);
    const script = await makeScript(userId, shared + '\nКОНЕЦ-ВЕРСИЯ-А');
    const key = `k-${nid()}`;

    const first = mockJsonGateway();
    const app1 = await buildApp({ id: userId }, first.fetchImpl);
    const res1 = await app1.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/structurize`,
      payload: { idempotencyKey: key }, // no idea → structurize the fountain
    });
    expect(res1.statusCode).toBe(200);
    await app1.close();

    // Change ONLY the part beyond the provider slice, then retry the SAME key.
    await db
      .update(scripts)
      .set({ fountain: shared + '\nКОНЕЦ-ВЕРСИЯ-Б' })
      .where(eq(scripts.id, script.id));
    const second = mockJsonGateway();
    const app2 = await buildApp({ id: userId }, second.fetchImpl);
    const res2 = await app2.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/structurize`,
      payload: { idempotencyKey: key },
    });
    // The full-text fingerprint differs → must NOT replay the old revision's output.
    expect(res2.statusCode).toBe(409);
    expect(res2.json().error).toBe('idempotency_key_reused');
    expect(second.seen.calls).toBe(0);
    await app2.close();
  });

  it('empty idea + empty fountain → 400 nothing_to_structurize, no gateway call', async () => {
    const script = await makeScript(userId, '');
    const { fetchImpl, seen } = mockJsonGateway();
    const app = await buildApp({ id: userId }, fetchImpl);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/structurize`,
      payload: { idempotencyKey: `k-${nid()}` },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('nothing_to_structurize');
    expect(seen.calls).toBe(0);
    await app.close();
  });

  it('retries once on a schema-failing model reply, then commits on the valid retry (charged once)', async () => {
    const script = await makeScript(userId);
    const { fetchImpl, seen } = mockJsonGateway({
      contents: ['не json, просто болтовня', JSON.stringify(VALID_OUTPUT)],
    });
    const app = await buildApp({ id: userId }, fetchImpl);
    const before = await balanceOf(userId);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/structurize`,
      payload: { idempotencyKey: `k-${nid()}`, idea: 'идея с ретраем' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().format).toBe('social');
    expect(seen.calls).toBe(2); // one miss + one good
    expect(await balanceOf(userId)).toBe(before - STRUCTURIZE_CREDITS); // charged exactly once
    await app.close();
  });

  it('unusable output after all retries → 422 structurize_unusable + full refund (never surfaces raw JSON)', async () => {
    const script = await makeScript(userId);
    const { fetchImpl, seen } = mockJsonGateway({ contents: ['мусор без структуры'] });
    const app = await buildApp({ id: userId }, fetchImpl, { maxAttempts: 2 });
    const before = await balanceOf(userId);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/structurize`,
      payload: { idempotencyKey: `k-${nid()}`, idea: 'безнадёжная идея' },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('structurize_unusable');
    expect(res.json().format).toBeUndefined(); // no raw model text leaks out
    expect(seen.calls).toBe(2); // exhausted the retry budget
    expect(await balanceOf(userId)).toBe(before); // fully refunded
    await app.close();
  });

  it('empty-structure model reply (no beats) is NOT a paid success → retry then 422 + full refund', async () => {
    const script = await makeScript(userId);
    // A degraded reply that is valid JSON but carries no beats must never commit.
    const { fetchImpl, seen } = mockJsonGateway({ contents: ['{"format":"film"}'] });
    const app = await buildApp({ id: userId }, fetchImpl);
    const before = await balanceOf(userId);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/structurize`,
      payload: { idempotencyKey: `k-${nid()}`, idea: 'идея с пустой структурой' },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('structurize_unusable');
    expect(res.json().format).toBeUndefined();
    expect(seen.calls).toBe(2); // empty structure counts as a schema miss → retried
    expect(await balanceOf(userId)).toBe(before); // never charged for an empty result
    await app.close();
  });

  it('never issues more gateway calls than the price covers (attempts clamped to the priced budget)', async () => {
    const script = await makeScript(userId);
    // Ask for more attempts than we priced; the route must clamp to the budget.
    const { fetchImpl, seen } = mockJsonGateway({ contents: ['мусор'] });
    const app = await buildApp({ id: userId }, fetchImpl, { maxAttempts: 5 });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/structurize`,
      payload: { idempotencyKey: `k-${nid()}`, idea: 'идея' },
    });

    expect(res.statusCode).toBe(422);
    expect(seen.calls).toBe(2); // clamped to STRUCTURIZE_MAX_ATTEMPTS, not 5
    await app.close();
  });

  it('provider failure → 502 structurize_failed + full refund', async () => {
    const script = await makeScript(userId);
    const { fetchImpl, seen } = mockJsonGateway({ status: 500 });
    const app = await buildApp({ id: userId }, fetchImpl);
    const before = await balanceOf(userId);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/structurize`,
      payload: { idempotencyKey: `k-${nid()}`, idea: 'идея при падении провайдера' },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('structurize_failed');
    expect(seen.calls).toBe(1); // provider error ends the loop immediately
    expect(await balanceOf(userId)).toBe(before); // refunded
    await app.close();
  });

  it('idempotent retry replays the stored result (lost response recoverable), charges once', async () => {
    const script = await makeScript(userId);
    const key = `k-${nid()}`;
    const first = mockJsonGateway();
    const app1 = await buildApp({ id: userId }, first.fetchImpl);
    const before = await balanceOf(userId);

    const res1 = await app1.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/structurize`,
      payload: { idempotencyKey: key, idea: 'идемпотентная идея' },
    });
    expect(res1.statusCode).toBe(200);
    const firstBody = res1.json();
    await app1.close();

    // The client lost the first response and retries the SAME key. The paid
    // output must come back (not a 409), and no second provider call fires.
    const second = mockJsonGateway();
    const app2 = await buildApp({ id: userId }, second.fetchImpl);
    const res2 = await app2.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/structurize`,
      payload: { idempotencyKey: key, idea: 'идемпотентная идея' },
    });

    expect(res2.statusCode).toBe(200);
    expect(res2.json().format).toBe(firstBody.format);
    expect(res2.json().outline).toEqual(firstBody.outline);
    expect(res2.json().brief).toEqual(firstBody.brief);
    expect(second.seen.calls).toBe(0); // no second provider call
    expect(await balanceOf(userId)).toBe(before - STRUCTURIZE_CREDITS); // charged exactly once
    await app2.close();
  });

  it('reused key with a DIFFERENT input does not replay stale output → 409 idempotency_key_reused', async () => {
    const script = await makeScript(userId);
    const key = `k-${nid()}`;
    const first = mockJsonGateway();
    const app1 = await buildApp({ id: userId }, first.fetchImpl);
    const res1 = await app1.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/structurize`,
      payload: { idempotencyKey: key, idea: 'первая идея про футболки' },
    });
    expect(res1.statusCode).toBe(200);
    await app1.close();

    // Same key, DIFFERENT idea — must not return the first idea's paid output.
    const second = mockJsonGateway();
    const app2 = await buildApp({ id: userId }, second.fetchImpl);
    const res2 = await app2.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/structurize`,
      payload: { idempotencyKey: key, idea: 'совсем другая идея про космос' },
    });
    expect(res2.statusCode).toBe(409);
    expect(res2.json().error).toBe('idempotency_key_reused');
    expect(second.seen.calls).toBe(0);
    await app2.close();
  });

  it('stale in-flight claim is reclaimed so a crashed request cannot block the user forever', async () => {
    const script = await makeScript(userId);
    // Simulate a crashed prior request: an in_progress claim from 20 min ago,
    // holding a reservation, that no terminal transition ever ran.
    const staleJobId = nid();
    await db.insert(scriptAssistRequests).values({
      id: nid(),
      scriptId: script.id,
      userId,
      idempotencyKey: `stale-${nid()}`,
      jobId: staleJobId,
      op: 'structurize',
      reserved: true, // crashed AFTER reserving → its hold must be refunded
      status: 'in_progress',
      createdAt: new Date(Date.now() - 20 * 60 * 1000),
      updatedAt: new Date(Date.now() - 20 * 60 * 1000),
    });

    const { fetchImpl } = mockJsonGateway();
    const app = await buildApp({ id: userId }, fetchImpl);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/structurize`,
      payload: { idempotencyKey: `fresh-${nid()}`, idea: 'новый запрос после краха' },
    });

    // The new request is NOT blocked by the crashed claim.
    expect(res.statusCode).toBe(200);
    // The stale claim was reclaimed (deleted → freed the in-flight slot) ...
    const staleRows = await db
      .select({ id: scriptAssistRequests.id })
      .from(scriptAssistRequests)
      .where(eq(scriptAssistRequests.jobId, staleJobId));
    expect(staleRows).toHaveLength(0);
    // ... and its stranded hold was handed to a durable refund.
    const refunds = await db
      .select({ payload: outboxJobs.payload })
      .from(outboxJobs)
      .where(eq(outboxJobs.queueName, CREDIT_REFUND_QUEUE));
    expect(refunds.some((o) => (o.payload as { jobId?: string }).jobId === staleJobId)).toBe(true);
    await app.close();
  });

  it('stale refund uses the amount ACTUALLY reserved, not the current price (version-skew safe)', async () => {
    const script = await makeScript(userId);
    const staleJobId = nid();
    const reservedAmount = STRUCTURIZE_CREDITS + 7; // an OLD price, different from current
    await db.insert(scriptAssistRequests).values({
      id: nid(),
      scriptId: script.id,
      userId,
      idempotencyKey: `stale-${nid()}`,
      jobId: staleJobId,
      op: 'structurize',
      reserved: true,
      amount: reservedAmount, // reserved at the old price
      status: 'in_progress',
      createdAt: new Date(Date.now() - 20 * 60 * 1000),
      updatedAt: new Date(Date.now() - 20 * 60 * 1000),
    });

    const { fetchImpl } = mockJsonGateway();
    const app = await buildApp({ id: userId }, fetchImpl);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/structurize`,
      payload: { idempotencyKey: `fresh-${nid()}`, idea: 'запрос при смене цены' },
    });

    expect(res.statusCode).toBe(200);
    const refunds = await db
      .select({ payload: outboxJobs.payload })
      .from(outboxJobs)
      .where(eq(outboxJobs.queueName, CREDIT_REFUND_QUEUE));
    const mine = refunds.find((o) => (o.payload as { jobId?: string }).jobId === staleJobId);
    expect(mine, 'the stale hold must be refunded').toBeTruthy();
    // Refund the ORIGINAL reserved amount, not the current STRUCTURIZE_CREDITS.
    expect((mine!.payload as { amount: number }).amount).toBe(reservedAmount);
    await app.close();
  });

  it('reclaims a claim that crashed BEFORE reserving without enqueuing a doomed refund', async () => {
    const script = await makeScript(userId);
    const unreservedJobId = nid();
    // Crashed between claim insert and credits.reserve: in_progress, jobId set, but
    // reserved=false (no ledger hold exists).
    await db.insert(scriptAssistRequests).values({
      id: nid(),
      scriptId: script.id,
      userId,
      idempotencyKey: `unreserved-${nid()}`,
      jobId: unreservedJobId,
      op: 'structurize',
      reserved: false,
      status: 'in_progress',
      createdAt: new Date(Date.now() - 20 * 60 * 1000),
      updatedAt: new Date(Date.now() - 20 * 60 * 1000),
    });

    const { fetchImpl } = mockJsonGateway();
    const app = await buildApp({ id: userId }, fetchImpl);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/structurize`,
      payload: { idempotencyKey: `fresh-${nid()}`, idea: 'запрос после краха до резерва' },
    });

    // Recovered, and the crashed claim removed ...
    expect(res.statusCode).toBe(200);
    const gone = await db
      .select({ id: scriptAssistRequests.id })
      .from(scriptAssistRequests)
      .where(eq(scriptAssistRequests.jobId, unreservedJobId));
    expect(gone).toHaveLength(0);
    // ... but NO refund enqueued for a hold that never existed (would poison the queue).
    const refunds = await db
      .select({ payload: outboxJobs.payload })
      .from(outboxJobs)
      .where(eq(outboxJobs.queueName, CREDIT_REFUND_QUEUE));
    expect(refunds.some((o) => (o.payload as { jobId?: string }).jobId === unreservedJobId)).toBe(
      false,
    );
    await app.close();
  });

  it('a crashed ASSIST claim neither blocks structurize nor is touched by it (per-op in-flight slots)', async () => {
    const assistUser = await makeFundedUser();
    const script = await makeScript(assistUser);
    const assistRowId = nid();
    // A crashed assist request (op defaults to 'assist', jobId NULL, reserves under
    // its own id). Its in-flight slot is the assist slot — separate from structurize.
    await db.insert(scriptAssistRequests).values({
      id: assistRowId,
      scriptId: script.id,
      userId: assistUser,
      idempotencyKey: `assist-${nid()}`,
      jobId: null,
      status: 'in_progress',
      createdAt: new Date(Date.now() - 20 * 60 * 1000),
      updatedAt: new Date(Date.now() - 20 * 60 * 1000),
    });

    const { fetchImpl, seen } = mockJsonGateway();
    const app = await buildApp({ id: assistUser }, fetchImpl);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/structurize`,
      payload: { idempotencyKey: `fresh-${nid()}`, idea: 'структуризация после краха ассиста' },
    });

    // Structurize is NOT blocked by the crashed assist (different in-flight slot).
    expect(res.statusCode).toBe(200);
    expect(seen.calls).toBe(1);
    // And the assist claim is left entirely untouched for assist's own recovery.
    const [assistRow] = await db
      .select({ status: scriptAssistRequests.status })
      .from(scriptAssistRequests)
      .where(eq(scriptAssistRequests.id, assistRowId))
      .limit(1);
    expect(assistRow, 'the assist claim must NOT be deleted').toBeTruthy();
    expect(assistRow!.status).toBe('in_progress');
    // No refund was enqueued against an assist hold structurize does not own.
    const refunds = await db
      .select({ payload: outboxJobs.payload })
      .from(outboxJobs)
      .where(eq(outboxJobs.queueName, CREDIT_REFUND_QUEUE));
    expect(refunds.some((o) => (o.payload as { jobId?: string | null }).jobId == null)).toBe(false);
    await app.close();
  });

  it("reclaims the client's OWN crashed same-key claim so their retry recovers (not stuck 409)", async () => {
    const script = await makeScript(userId);
    const key = `samekey-${nid()}`;
    const staleJobId = nid();
    // The client's earlier request crashed mid-flight: an in_progress row with
    // THIS key, 20 min old, holding a reservation and never settled.
    await db.insert(scriptAssistRequests).values({
      id: nid(),
      scriptId: script.id,
      userId,
      idempotencyKey: key,
      jobId: staleJobId,
      op: 'structurize',
      reserved: true, // crashed AFTER reserving
      status: 'in_progress',
      createdAt: new Date(Date.now() - 20 * 60 * 1000),
      updatedAt: new Date(Date.now() - 20 * 60 * 1000),
    });

    const { fetchImpl } = mockJsonGateway();
    const app = await buildApp({ id: userId }, fetchImpl);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/structurize`,
      payload: { idempotencyKey: key, idea: 'повтор того же ключа после краха' },
    });

    // The correct same-key retry recovers instead of being stuck at 409 forever.
    expect(res.statusCode).toBe(200);
    const refunds = await db
      .select({ payload: outboxJobs.payload })
      .from(outboxJobs)
      .where(eq(outboxJobs.queueName, CREDIT_REFUND_QUEUE));
    expect(refunds.some((o) => (o.payload as { jobId?: string }).jobId === staleJobId)).toBe(true);
    await app.close();
  });

  it('retrying a FAILED request with the same key re-runs it (does not poison the key)', async () => {
    const script = await makeScript(userId);
    const key = `k-${nid()}`;
    const before = await balanceOf(userId);

    // First attempt: provider fails → 502, the claim row is marked failed and its
    // hold refunded.
    const fail = mockJsonGateway({ status: 500 });
    const app1 = await buildApp({ id: userId }, fail.fetchImpl);
    const res1 = await app1.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/structurize`,
      payload: { idempotencyKey: key, idea: 'идея, которую переигрываем' },
    });
    expect(res1.statusCode).toBe(502);
    await app1.close();

    // Correct client retry with the SAME stable key — must re-run, not 409 forever.
    const ok = mockJsonGateway();
    const app2 = await buildApp({ id: userId }, ok.fetchImpl);
    const res2 = await app2.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/structurize`,
      payload: { idempotencyKey: key, idea: 'идея, которую переигрываем' },
    });
    expect(res2.statusCode).toBe(200);
    expect(res2.json().format).toBe('social');
    expect(ok.seen.calls).toBe(1); // it actually re-ran the model
    expect(await balanceOf(userId)).toBe(before - STRUCTURIZE_CREDITS); // charged once, for the retry
    await app2.close();
  });

  it('retrying a failed key with a DIFFERENT input is rejected (409 idempotency_key_reused)', async () => {
    const script = await makeScript(userId);
    const key = `k-${nid()}`;
    const fail = mockJsonGateway({ status: 500 });
    const app1 = await buildApp({ id: userId }, fail.fetchImpl);
    const res1 = await app1.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/structurize`,
      payload: { idempotencyKey: key, idea: 'исходная идея' },
    });
    expect(res1.statusCode).toBe(502);
    await app1.close();

    const second = mockJsonGateway();
    const app2 = await buildApp({ id: userId }, second.fetchImpl);
    const res2 = await app2.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/structurize`,
      payload: { idempotencyKey: key, idea: 'другая идея под тем же ключом' },
    });
    expect(res2.statusCode).toBe(409);
    expect(res2.json().error).toBe('idempotency_key_reused');
    expect(second.seen.calls).toBe(0);
    await app2.close();
  });

  it('success schedules the charge ATOMICALLY: completed + commit enqueued in one tx, no refund leg', async () => {
    const script = await makeScript(userId);
    const { fetchImpl } = mockJsonGateway();
    const app = await buildApp({ id: userId }, fetchImpl);
    const key = `k-${nid()}`;

    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/structurize`,
      payload: { idempotencyKey: key, idea: 'идея для атомарного списания' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().format).toBe('social');
    // The request is completed AND a durable commit was enqueued — there is no
    // window where a replayable completed result exists without a scheduled charge.
    const [row] = await db
      .select({ status: scriptAssistRequests.status, jobId: scriptAssistRequests.jobId })
      .from(scriptAssistRequests)
      .where(
        and(eq(scriptAssistRequests.userId, userId), eq(scriptAssistRequests.idempotencyKey, key)),
      )
      .limit(1);
    expect(row!.status).toBe('completed');
    const commits = await db
      .select({ payload: outboxJobs.payload })
      .from(outboxJobs)
      .where(eq(outboxJobs.queueName, CREDIT_COMMIT_QUEUE));
    const mine = commits.find((o) => (o.payload as { jobId?: string }).jobId === row!.jobId);
    expect(mine, 'a durable commit must be enqueued atomically with completion').toBeTruthy();
    expect((mine!.payload as { amount: number }).amount).toBe(STRUCTURIZE_CREDITS);
    // No contradictory refund leg for the same reservation.
    const refunds = await db
      .select({ payload: outboxJobs.payload })
      .from(outboxJobs)
      .where(eq(outboxJobs.queueName, CREDIT_REFUND_QUEUE));
    expect(refunds.some((o) => (o.payload as { jobId?: string }).jobId === row!.jobId)).toBe(false);
    await app.close();
  });

  it('refund outage → guarantees the refund via a durable outbox refund, still fails the request', async () => {
    const script = await makeScript(userId);
    const { fetchImpl } = mockJsonGateway({ status: 500 }); // provider fails → refund path
    const failingCredits = {
      reserve: creditService.reserve.bind(creditService),
      commit: creditService.commit.bind(creditService),
      refund: async () => {
        throw new Error('refund outage');
      },
    };
    const app = await buildApp({ id: userId }, fetchImpl, { credits: failingCredits });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/structurize`,
      payload: { idempotencyKey: `k-${nid()}`, idea: 'идея при сбое возврата' },
    });

    expect(res.statusCode).toBe(502);
    const outbox = await db
      .select({ payload: outboxJobs.payload })
      .from(outboxJobs)
      .where(eq(outboxJobs.queueName, CREDIT_REFUND_QUEUE));
    expect(
      outbox.some((o) =>
        String((o.payload as { idempotencyKey?: string }).idempotencyKey ?? '').startsWith(
          'structurize:',
        ),
      ),
      'a durable refund must be enqueued when inline refund is exhausted',
    ).toBe(true);
    await app.close();
  });

  it('total settlement outage (inline refund AND outbox both fail) keeps the claim in_progress + jobId for recovery', async () => {
    // Isolated user: this deliberately leaves a lingering in_progress claim (the
    // whole point), which would otherwise block the shared user's later tests.
    const outageUser = await makeFundedUser();
    const script = await makeScript(outageUser);
    const key = `k-${nid()}`;
    const { fetchImpl } = mockJsonGateway({ status: 500 }); // provider fails → refund path
    const failingCredits = {
      reserve: creditService.reserve.bind(creditService),
      commit: creditService.commit.bind(creditService),
      refund: async () => {
        throw new Error('refund down');
      },
    };
    const app = await buildApp({ id: outageUser }, fetchImpl, {
      credits: failingCredits,
      enqueueRefund: async () => {
        throw new Error('outbox down');
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/structurize`,
      payload: { idempotencyKey: key, idea: 'полный отказ расчётов' },
    });

    // The refund could not be confirmed anywhere → the request must NOT be marked
    // terminal (a later same-key retry could delete it, losing the jobId). It stays
    // in_progress with its jobId, so stale-reclaim can settle the hold later.
    expect(res.statusCode).toBe(500);
    const [row] = await db
      .select({ status: scriptAssistRequests.status, jobId: scriptAssistRequests.jobId })
      .from(scriptAssistRequests)
      .where(
        and(
          eq(scriptAssistRequests.userId, outageUser),
          eq(scriptAssistRequests.idempotencyKey, key),
        ),
      )
      .limit(1);
    expect(row!.status).toBe('in_progress');
    expect(row!.jobId).toBeTruthy();
    await app.close();
  });

  it('daily spend cap counts provider attempts: unusable output does NOT release the reservation', async () => {
    const script = await makeScript(userId);
    const { fetchImpl } = mockJsonGateway({ contents: ['мусор'] });
    const { redis, calls } = fakeSpendRedis();
    const app = await buildApp({ id: userId }, fetchImpl, { spend: { redis, cap: 1_000_000 } });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/structurize`,
      payload: { idempotencyKey: `k-${nid()}`, idea: 'идея' },
    });

    expect(res.statusCode).toBe(422);
    expect(calls.eval).toBeGreaterThan(0); // reserved against the daily cap
    // Finding 3: those gateway attempts consumed tokens; the daily reservation
    // must stay counted (never released) even though the USER is refunded.
    expect(calls.decrby).toBe(0);
    await app.close();
  });

  it('daily spend cap IS released when no gateway call happens (insufficient credits)', async () => {
    const broke = await makeFundedUser(0); // funded with nothing
    const script = await makeScript(broke);
    const { fetchImpl, seen } = mockJsonGateway();
    const { redis, calls } = fakeSpendRedis();
    const app = await buildApp({ id: broke }, fetchImpl, { spend: { redis, cap: 1_000_000 } });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/structurize`,
      payload: { idempotencyKey: `k-${nid()}`, idea: 'идея' },
    });

    expect(res.statusCode).toBe(402);
    expect(seen.calls).toBe(0); // never reached the gateway
    expect(calls.decrby).toBe(1); // so the daily reservation is released
    await app.close();
  });

  it('does not abort a healthy in-flight request over a real socket (no spurious 504)', async () => {
    const script = await makeScript(userId);
    // Delay the gateway so the request body is fully consumed while it is pending.
    const { fetchImpl } = mockJsonGateway({ delayMs: 60 });
    const app = await buildApp({ id: userId }, fetchImpl);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const res = await fetch(`http://127.0.0.1:${port}/v1/scripts/${script.id}/structurize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idempotencyKey: `k-${nid()}`, idea: 'здоровый запрос' }),
    });

    expect(res.status).toBe(200); // deadline-bounded, not aborted by request-close
    expect((await res.json()).format).toBe('social');
    await app.close();
  });

  it('missing script → 404', async () => {
    const { fetchImpl } = mockJsonGateway();
    const app = await buildApp({ id: userId }, fetchImpl);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/does-not-exist/structurize`,
      payload: { idempotencyKey: `k-${nid()}`, idea: 'x' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('returns a read-only active workbook quote and rejects a stale submit before claims/provider work', async () => {
    const script = await makeScript(userId, FOUNTAIN);
    const { fetchImpl, seen } = mockJsonGateway();
    const app = await buildApp({ id: userId }, fetchImpl);
    const quoteRes = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/structurize/quote`,
      payload: { idea: 'короткая идея' },
    });
    expect(quoteRes.statusCode).toBe(200);
    const quote = quoteRes.json() as {
      credits: number;
      quoteFingerprint: string;
      maxOutputTokens: number;
    };
    expect(quote.credits).toBe(STRUCTURIZE_CREDITS);
    expect(quote.quoteFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(quote.maxOutputTokens).toBe(STRUCTURIZE_TOKEN_BUDGET.output);
    expect(seen.calls).toBe(0);

    const stale = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/structurize`,
      payload: {
        idempotencyKey: `k-${nid()}`,
        idea: 'короткая идея',
        expectedCredits: quote.credits + 1,
        quoteFingerprint: quote.quoteFingerprint,
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe('quote_stale');
    expect(seen.calls).toBe(0);
    await app.close();
  });

  it('refuses dense/adversarial input instead of silently clipping the screenplay', async () => {
    // A huge dense-Cyrillic + emoji screenplay must not be charged for a
    // prefix while the UI promises a complete source.
    const dense = 'Мама мыла раму 🎬🔥'.repeat(20000).slice(0, 200_000);
    const script = await makeScript(userId, dense);
    const { fetchImpl, seen } = mockJsonGateway({ contents: [JSON.stringify(FILM_OUTPUT)] });
    const app = await buildApp({ id: userId }, fetchImpl);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/structurize`,
      payload: { idempotencyKey: `k-${nid()}` }, // structurize the dense fountain
    });

    expect(res.statusCode).toBe(413);
    expect((res.json() as { error?: string }).error).toBe('structurize_source_too_large');
    expect(seen.bodies).toHaveLength(0);
    await app.close();
  });

  it('a structurize key colliding with assist keys is independent (op-scoped uniqueness)', async () => {
    const user = await makeFundedUser();
    const script = await makeScript(user);
    const sharedKey = `shared-${nid()}`;
    // Pre-existing assist rows (op defaults to 'assist') reusing the SAME client
    // key, in every terminal/in-flight shape — none may poison structurize.
    for (const status of ['completed', 'failed', 'aborted', 'in_progress'] as const) {
      await db.insert(scriptAssistRequests).values({
        id: nid(),
        scriptId: script.id,
        userId: user,
        idempotencyKey: `${sharedKey}-${status}`,
        status,
      });
    }
    // Use the same key as the in_progress assist row — the hardest collision.
    const { fetchImpl } = mockJsonGateway();
    const app = await buildApp({ id: user }, fetchImpl);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/structurize`,
      payload: {
        idempotencyKey: `${sharedKey}-in_progress`,
        idea: 'структуризация с общим ключом',
      },
    });
    // Structurize proceeds on its own op-scoped claim, not blocked by the assist key.
    expect(res.statusCode).toBe(200);
    expect(res.json().format).toBe('social');
    // The assist rows are untouched.
    const assistRows = await db
      .select({ id: scriptAssistRequests.id })
      .from(scriptAssistRequests)
      .where(and(eq(scriptAssistRequests.userId, user), eq(scriptAssistRequests.op, 'assist')));
    expect(assistRows).toHaveLength(4);
    await app.close();
  });

  it('deleting a script does NOT destroy an in-flight paid claim (SET NULL keeps recovery data for the reaper)', async () => {
    const user = await makeFundedUser();
    const script = await makeScript(user);
    const jobId = nid();
    await db.insert(scriptAssistRequests).values({
      id: nid(),
      scriptId: script.id,
      userId: user,
      idempotencyKey: `cascade-${nid()}`,
      jobId,
      amount: STRUCTURIZE_CREDITS,
      reserved: true,
      op: 'structurize',
      status: 'in_progress',
    });

    // Under the old cascade FK this would delete the claim (and its jobId/amount)
    // while the credit hold survived → unrecoverable. SET NULL must detach, not delete.
    await db.delete(scripts).where(eq(scripts.id, script.id));

    const [claim] = await db
      .select({
        scriptId: scriptAssistRequests.scriptId,
        jobId: scriptAssistRequests.jobId,
        amount: scriptAssistRequests.amount,
        reserved: scriptAssistRequests.reserved,
        status: scriptAssistRequests.status,
      })
      .from(scriptAssistRequests)
      .where(eq(scriptAssistRequests.jobId, jobId))
      .limit(1);
    expect(claim, 'the paid claim must survive script deletion').toBeTruthy();
    expect(claim!.scriptId).toBeNull(); // detached from the deleted script
    expect(claim!.jobId).toBe(jobId); // recovery data intact → reaper can refund
    expect(claim!.amount).toBe(STRUCTURIZE_CREDITS);
    expect(claim!.reserved).toBe(true);
    expect(claim!.status).toBe('in_progress');
  });

  it('requires a client idempotency key (paid output must be recoverable) → 400 without one', async () => {
    const script = await makeScript(userId);
    const { fetchImpl, seen } = mockJsonGateway();
    const app = await buildApp({ id: userId }, fetchImpl);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/structurize`,
      payload: { idea: 'идея без ключа' }, // no idempotencyKey
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_body');
    expect(seen.calls).toBe(0);
    await app.close();
  });

  it('fences a claim reclaimed before it reserves: the original cannot charge (409, no hold)', async () => {
    const raceUser = await makeFundedUser();
    const script = await makeScript(raceUser);
    const before = await balanceOf(raceUser);
    const { fetchImpl, seen } = mockJsonGateway();
    // Simulate a concurrent reclaimer deleting our claim mid-reserve (a stall
    // before reservation): the fenced reserved-flag update then hits zero rows.
    const racyCredits = {
      reserve: async (input: Parameters<typeof creditService.reserve>[0]) => {
        await db.delete(scriptAssistRequests).where(eq(scriptAssistRequests.jobId, input.jobId));
        return creditService.reserve(input);
      },
      commit: creditService.commit.bind(creditService),
      refund: creditService.refund.bind(creditService),
    };
    const app = await buildApp({ id: raceUser }, fetchImpl, { credits: racyCredits });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/structurize`,
      payload: { idempotencyKey: `k-${nid()}`, idea: 'гонка с реклеймом' },
    });

    // Ownership lost → the whole reserve tx rolled back: no charge, no gateway call.
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('structurize_in_progress');
    expect(seen.calls).toBe(0);
    expect(await balanceOf(raceUser)).toBe(before); // reservation rolled back
    await app.close();
  });
});

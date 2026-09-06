import 'dotenv/config';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray, like } from 'drizzle-orm';
import {
  db,
  nid,
  pool,
  assistTierStates,
  aiUsageEvents,
  creditTransactions,
  outboxJobs,
  scripts,
  scriptMaterials,
  scriptSnapshots,
  scriptAssistRequests,
  scriptThreadMessages,
  scriptThreads,
  usersApp,
  usersPii,
} from '@seed/db';
import type { ScriptThreadMessage } from '@seed/db';
import { creditService } from '@seed/credits';
import { setupScriptAssistRoutes, compactMaterialText } from '../src/script-assist';
import { invalidateAssistTierStates } from '../src/assist-tier-state';
import { ASSIST_TIERS, MATERIAL_SUMMARY_MIN_RAW_CHARS, assistTier } from '@seed/shared';

/**
 * Assist prices are workbook-derived from route attempts, token ceilings and
 * landed FX. Integration tests read the same generated contract as the route;
 * workbook/import guardrails independently prove its arithmetic and provenance.
 */
const ECONOMY = assistTier('economy')!.creditsPerCall;

/**
 * Phase 2 integration tests — gateway ALWAYS mocked (live-spend discipline:
 * unit/integration mock the gateway; live smokes are a separate one-shot).
 */

// The kie.ai primary/fallback routing for the standard tier is covered by
// script-assist-kie.test.ts; pin it OFF here so these tests exercise the pure
// OpenRouter path regardless of the local .env (dotenv loads the real
// KIE_API_KEY, which would otherwise prepend a kie call and break the
// call-count assertions below).
process.env.KIE_CHAT_DISABLED = '1';

const FOUNTAIN = [
  'ИНТ. КИНОБУДКА - НОЧЬ',
  '',
  'Тесная будка киномеханика.',
  '',
  'МИХАЛЫЧ',
  'Этого не может быть. Плёнка кончилась, я сам видел.',
  '',
  'НАТ. КРЫША - НОЧЬ',
  '',
  'Ветер гонит афиши.',
  '',
].join('\n');
const SPAN = 'Этого не может быть. Плёнка кончилась, я сам видел.';

const createdUsers: string[] = [];
const createdScripts: string[] = [];

async function makeFundedUser(credits = 100): Promise<string> {
  const id = nid();
  await db.insert(usersApp).values({ id, displayName: 'AssistTest', locale: 'ru' });
  await db.insert(usersPii).values({ id, email: `assist-test+${id}@seed.local` });
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

async function makeScript(userId: string, fountain = FOUNTAIN) {
  const [row] = await db
    .insert(scripts)
    .values({ id: nid(), userId, title: 'Тест', fountain })
    .returning();
  createdScripts.push(row!.id);
  return row!;
}

/** OpenRouter-shaped streaming mock; records the request body it received. */
function mockGateway(
  opts: { chunks?: string[]; status?: number; reasoningFirst?: boolean; usage?: unknown } = {},
) {
  const seen: { body?: Record<string, unknown>; calls: number } = { calls: 0 };
  const chunks = opts.chunks ?? ['Обсудим. ', '<rewrite>Всё. Домой.</rewrite>'];
  const fetchImpl: typeof fetch = async (_url, init) => {
    seen.calls += 1;
    seen.body = JSON.parse(String(init?.body));
    if (opts.status && opts.status !== 200) {
      return new Response('{"error":"boom"}', { status: opts.status });
    }
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (opts.reasoningFirst) {
          controller.enqueue(
            enc.encode(
              `data: ${JSON.stringify({ choices: [{ delta: { reasoning_details: [{ type: 'reasoning.text', text: '...' }] } }] })}\n\n`,
            ),
          );
        }
        for (const c of chunks) {
          controller.enqueue(
            enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`),
          );
        }
        if (opts.usage)
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ usage: opts.usage })}\n\n`));
        controller.enqueue(enc.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  };
  return { fetchImpl, seen };
}

function buildApp(
  userId: string,
  fetchImpl: typeof fetch,
  options: Parameters<typeof setupScriptAssistRoutes>[2] = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  setupScriptAssistRoutes(app, async () => ({ user: { id: userId } }), { fetchImpl, ...options });
  return app.ready().then(() => app);
}

const sseFrames = (body: string): Record<string, unknown>[] =>
  body
    .split('\n\n')
    .filter((f) => f.startsWith('data: '))
    .map((f) => JSON.parse(f.slice(6)));

const balanceOf = async (userId: string) => (await creditService.balanceFor(userId)).available;

let userId: string;

beforeAll(async () => {
  // Keep the shared fixture comfortably funded across the whole suite even
  // when a certified model change re-derives tier prices upward.
  userId = await makeFundedUser(1_000);
});

afterAll(async () => {
  // Durable commit/refund outbox rows this suite enqueued (no worker drains them
  // in tests) — clean up so they don't accumulate across runs.
  await db.delete(outboxJobs).where(like(outboxJobs.jobId, 'assist-%'));
  if (createdScripts.length) {
    await db.delete(scripts).where(inArray(scripts.id, createdScripts));
  }
  if (createdUsers.length) {
    // credit rows cascade with users_app
    await db.delete(usersPii).where(inArray(usersPii.id, createdUsers));
    await db.delete(usersApp).where(inArray(usersApp.id, createdUsers));
  }
  await pool.end();
});

describe('POST /v1/scripts/:id/assist — anchored span call', () => {
  it('persists the OpenRouter usage frame and the committed assist charge', async () => {
    const script = await makeScript(userId);
    const { fetchImpl } = mockGateway({
      usage: {
        prompt_tokens: 120,
        completion_tokens: 34,
        prompt_tokens_details: { cached_tokens: 9 },
      },
    });
    const app = await buildApp(userId, fetchImpl);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/assist`,
      payload: { question: 'Ответь коротко.', tier: 'economy' },
    });
    expect(res.statusCode).toBe(200);
    expect(
      await db
        .select({
          input: aiUsageEvents.inputTokens,
          output: aiUsageEvents.outputTokens,
          cached: aiUsageEvents.cacheReadTokens,
          reported: aiUsageEvents.usageReported,
          charged: aiUsageEvents.creditsCharged,
        })
        .from(aiUsageEvents)
        .where(eq(aiUsageEvents.scriptId, script.id)),
    ).toEqual([{ input: 120, output: 34, cached: 9, reported: true, charged: ECONOMY.project }]);
    await app.close();
  });

  it('persists absent OpenRouter usage as usage_reported false rather than zero tokens', async () => {
    const script = await makeScript(userId);
    const { fetchImpl } = mockGateway();
    const app = await buildApp(userId, fetchImpl);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/assist`,
      payload: { question: 'Ответь коротко.', tier: 'economy' },
    });
    expect(res.statusCode).toBe(200);
    expect(
      await db
        .select({
          reported: aiUsageEvents.usageReported,
          input: aiUsageEvents.inputTokens,
          output: aiUsageEvents.outputTokens,
        })
        .from(aiUsageEvents)
        .where(eq(aiUsageEvents.scriptId, script.id)),
    ).toEqual([{ reported: false, input: null, output: null }]);
    await app.close();
  });

  it('keeps a transport-successful usage row but no charge when output is unusable and refunded', async () => {
    const script = await makeScript(userId);
    const { fetchImpl } = mockGateway({
      chunks: ['<rule>hidden</rule>'],
      usage: { prompt_tokens: 8, completion_tokens: 2 },
    });
    const app = await buildApp(userId, fetchImpl);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/assist`,
      payload: { question: 'Ответь коротко.', tier: 'economy' },
    });
    expect(res.statusCode).toBe(200);
    expect(
      await db
        .select({
          reported: aiUsageEvents.usageReported,
          outcome: aiUsageEvents.outcome,
          charged: aiUsageEvents.creditsCharged,
        })
        .from(aiUsageEvents)
        .where(eq(aiUsageEvents.scriptId, script.id)),
    ).toEqual([{ reported: true, outcome: 'ok', charged: null }]);
    await app.close();
  });

  it('still completes and commits exactly once when ai usage recording cannot insert', async () => {
    const script = await makeScript(userId);
    const { fetchImpl } = mockGateway();
    const app = await buildApp(userId, fetchImpl);
    const before = await balanceOf(userId);
    const originalInsert = db.insert.bind(db);
    const insert = vi.spyOn(db, 'insert').mockImplementation(((table) => {
      if (table === aiUsageEvents)
        return {
          values: async () => {
            throw new Error('telemetry down');
          },
        };
      return originalInsert(table);
    }) as typeof db.insert);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/scripts/${script.id}/assist`,
        payload: { question: 'Ответь коротко.', tier: 'economy' },
      });
      expect(res.statusCode).toBe(200);
      expect(await balanceOf(userId)).toBe(before - ECONOMY.project);
    } finally {
      insert.mockRestore();
      await app.close();
    }
  });
  it('streams deltas, persists the thread, extracts the proposal, commits the workbook price', async () => {
    const script = await makeScript(userId);
    const { fetchImpl, seen } = mockGateway();
    const app = await buildApp(userId, fetchImpl);
    const before = await balanceOf(userId);

    const from = FOUNTAIN.indexOf(SPAN);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/assist`,
      payload: {
        question: 'Сожми реплику, оставь страх.',
        anchor: { from, to: from + SPAN.length, rev: 0, quote: SPAN },
        tier: 'economy',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');

    const frames = sseFrames(res.body);
    expect(frames[0]).toMatchObject({ tier: 'economy', credits: ECONOMY.span, detached: false });
    expect(frames.some((f) => f.delta === 'Обсудим. ')).toBe(true);
    expect(frames.map((frame) => frame.delta ?? '').join('')).not.toMatch(/<\/?rewrite>/);
    const done = frames[frames.length - 1]!;
    expect(done.done).toBe(true);
    expect(done.proposal).toEqual({ before: SPAN, after: 'Всё. Домой.' });

    // Bounded context: the span + its scene went to the gateway, NOT scene 2.
    const sent = JSON.stringify(seen.body!.messages);
    expect(sent).toContain('ВЫДЕЛЕННЫЙ ФРАГМЕНТ');
    expect(sent).not.toContain('Ветер гонит афиши');
    expect(seen.body!.model).toBe('qwen/qwen3.5-plus-02-15');

    // Thread persisted with both messages.
    const threads = await db
      .select()
      .from(scriptThreads)
      .where(eq(scriptThreads.scriptId, script.id));
    expect(threads).toHaveLength(1);
    expect(threads[0]!.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(threads[0]!.messages[1]!.proposal!.after).toBe('Всё. Домой.');

    const ledger = await db
      .select()
      .from(scriptThreadMessages)
      .where(eq(scriptThreadMessages.threadId, threads[0]!.id));
    expect(ledger.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(ledger[1]!.proposal).toEqual({ before: SPAN, after: 'Всё. Домой.' });

    expect(await balanceOf(userId)).toBe(before - ECONOMY.span);
    await app.close();
  });

  it('streams honest thinking and typing phases before the answer', async () => {
    const script = await makeScript(userId);
    const { fetchImpl } = mockGateway({ reasoningFirst: true });
    const app = await buildApp(userId, fetchImpl);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/assist`,
      payload: { question: 'Вопрос.', tier: 'max' },
    });

    const phases = sseFrames(res.body).flatMap((frame) =>
      typeof frame.phase === 'string' ? [frame.phase] : [],
    );
    expect(phases).toEqual(['thinking', 'typing']);
    await app.close();
  });

  it('injects the библия into every call (Phase 3 acceptance: visible in the prompt)', async () => {
    const script = await makeScript(userId);
    await db
      .update(scripts)
      .set({
        bible: {
          characters: [{ name: 'МИХАЛЫЧ', description: 'молчун, суеверный' }],
          tone: ['ламповый хоррор'],
          rules: ['никто не произносит слово «призрак»'],
        },
      })
      .where(eq(scripts.id, script.id));
    const { fetchImpl, seen } = mockGateway();
    const app = await buildApp(userId, fetchImpl);
    await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/assist`,
      payload: { question: 'Вопрос.', tier: 'economy' },
    });
    const system = (seen.body!.messages as Array<{ role: string; content: string }>).find(
      (m) => m.role === 'system',
    )!.content;
    expect(system).toContain('БИБЛИЯ ПРОЕКТА');
    expect(system).toContain('молчун, суеверный');
    expect(system).toContain('ламповый хоррор');
    expect(system).toContain('никто не произносит слово «призрак»');
    await app.close();
  });

  it('re-locates a drifted anchor by quote (rev moved on) and stays span-priced', async () => {
    const shifted = 'НОВАЯ СЦЕНА ВСТАВЛЕНА.\n\n' + FOUNTAIN;
    const script = await makeScript(userId, shifted);
    await db.update(scripts).set({ rev: 5 }).where(eq(scripts.id, script.id));
    const { fetchImpl, seen } = mockGateway();
    const app = await buildApp(userId, fetchImpl);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/assist`,
      payload: {
        question: 'Вопрос.',
        // Offsets from the OLD rev 0 — text has since shifted right.
        anchor: { from: 40, to: 40 + SPAN.length, rev: 0, quote: SPAN },
        tier: 'economy',
      },
    });
    const frames = sseFrames(res.body);
    expect(frames[0]).toMatchObject({ credits: ECONOMY.span, detached: false });
    expect(JSON.stringify(seen.body!.messages)).toContain(SPAN);
    await app.close();
  });

  it('detached anchor (quote gone): bounded fallback context, thread marked detached', async () => {
    const script = await makeScript(userId);
    // Rev moved on since the anchor was made — offsets are no longer
    // authoritative, and the quoted text no longer exists anywhere.
    await db.update(scripts).set({ rev: 2 }).where(eq(scripts.id, script.id));
    const { fetchImpl, seen } = mockGateway({ chunks: ['Понимаю.'] });
    const app = await buildApp(userId, fetchImpl);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/assist`,
      payload: {
        question: 'Что с этим фрагментом?',
        anchor: { from: 10, to: 30, rev: 0, quote: 'ТЕКСТ КОТОРОГО БОЛЬШЕ НЕТ' },
        tier: 'economy',
      },
    });
    const frames = sseFrames(res.body);
    expect(frames[0]).toMatchObject({ detached: true, credits: ECONOMY.span });
    const sent = JSON.stringify(seen.body!.messages);
    expect(sent).toContain('изменился или удалён');
    expect(sent).not.toContain('=== СЦЕНАРИЙ ==='); // never the whole script at span price

    const threads = await db
      .select()
      .from(scriptThreads)
      .where(eq(scriptThreads.scriptId, script.id));
    expect(threads[0]!.status).toBe('detached');
    await app.close();
  });
});

describe('whole-script scope and failure paths', () => {
  it('rate-limits repeated Scenario assists per user before provider or credits', async () => {
    const script = await makeScript(userId);
    const { fetchImpl, seen } = mockGateway({ chunks: ['Готово.'] });
    let count = 0;
    const app = await buildApp(userId, fetchImpl, {
      rateLimit: {
        redis: { eval: async () => ++count } as never,
        max: 1,
        windowSeconds: 60,
      },
    });
    const first = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/assist`,
      payload: { question: 'Первый.', tier: 'economy' },
    });
    const second = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/assist`,
      payload: { question: 'Второй.', tier: 'economy' },
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);
    expect(second.json()).toEqual({ error: 'assist_rate_limited' });
    expect(second.headers['retry-after']).toBe('60');
    expect(seen.calls).toBe(1);
    await app.close();
  });

  it('daily platform cap rejects assist before any provider call or credit reservation', async () => {
    const script = await makeScript(userId);
    const { fetchImpl, seen } = mockGateway();
    const app = await buildApp(userId, fetchImpl, {
      spend: {
        cap: 1,
        redis: { eval: async () => -1, get: async () => '1' } as never,
      },
    });
    const before = await balanceOf(userId);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/assist`,
      payload: { question: 'Вопрос.', tier: 'economy' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'daily_spend_cap_exceeded', cap: 1 });
    expect(seen.calls).toBe(0);
    expect(await balanceOf(userId)).toBe(before);
    await app.close();
  });

  it('an explicitly confirmed full-read message reads the whole script at the script price', async () => {
    const script = await makeScript(userId);
    const { fetchImpl, seen } = mockGateway({ chunks: ['Структура ок.'] });
    const app = await buildApp(userId, fetchImpl);
    const before = await balanceOf(userId);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/assist`,
      payload: {
        question: 'Разбери структуру.',
        tier: 'economy',
        scope: 'script',
        confirmFullScript: true,
      },
    });
    const frames = sseFrames(res.body);
    expect(frames[0]).toMatchObject({ credits: ECONOMY.script, scope: 'script' });
    expect(JSON.stringify(seen.body!.messages)).toContain('=== СЦЕНАРИЙ ===');
    expect(await balanceOf(userId)).toBe(before - ECONOMY.script);
    await app.close();
  });

  it('rejects an unconfirmed full raw-script escalation before charging', async () => {
    const script = await makeScript(userId);
    const { fetchImpl, seen } = mockGateway();
    const app = await buildApp(userId, fetchImpl);
    const before = await balanceOf(userId);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/assist`,
      payload: { question: 'Прочти всё.', tier: 'economy', scope: 'script' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'full_script_confirmation_required' });
    expect(seen.calls).toBe(0);
    expect(await balanceOf(userId)).toBe(before);
    await app.close();
  });

  it('gateway failure → SSE error frame + full refund', async () => {
    const script = await makeScript(userId);
    const { fetchImpl, seen } = mockGateway({ status: 500 });
    const app = await buildApp(userId, fetchImpl);
    const before = await balanceOf(userId);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/assist`,
      payload: { question: 'Вопрос.', tier: 'standard' },
    });
    const frames = sseFrames(res.body);
    expect(frames[frames.length - 1]!.error).toBe('assist_failed');
    expect(seen.calls).toBe(2); // one bounded pre-token retry, then terminal failure
    expect(await balanceOf(userId)).toBe(before); // refunded
    await app.close();
  });

  it('retries one transient pre-token provider failure and completes without a user-visible error', async () => {
    const script = await makeScript(userId);
    const success = mockGateway({ chunks: ['Готово.'] });
    let calls = 0;
    const fetchImpl: typeof fetch = async (url, init) => {
      calls += 1;
      if (calls === 1) return new Response('{"error":"temporary"}', { status: 502 });
      return success.fetchImpl(url, init);
    };
    const app = await buildApp(userId, fetchImpl);
    const before = await balanceOf(userId);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/assist`,
      payload: { question: 'Вопрос.', tier: 'economy' },
    });
    const frames = sseFrames(res.body);
    expect(calls).toBe(2);
    expect(frames.some((frame) => frame.error)).toBe(false);
    expect(frames[frames.length - 1]!.done).toBe(true);
    expect(await balanceOf(userId)).toBe(before - ECONOMY.project);
    await app.close();
  });

  it('does not retry a provider contract 4xx and refunds', async () => {
    const script = await makeScript(userId);
    const { fetchImpl, seen } = mockGateway({ status: 400 });
    const app = await buildApp(userId, fetchImpl);
    const before = await balanceOf(userId);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/assist`,
      payload: { question: 'Вопрос.', tier: 'economy' },
    });
    const frames = sseFrames(res.body);
    expect(seen.calls).toBe(1);
    expect(frames[frames.length - 1]!.error).toBe('assist_failed');
    expect(await balanceOf(userId)).toBe(before);
    await app.close();
  });

  it('provider timeout records an aborted terminal state and refunds exactly once', async () => {
    const script = await makeScript(userId);
    const fetchImpl: typeof fetch = async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    const app = await buildApp(userId, fetchImpl, { deadlineMs: 10 });
    const before = await balanceOf(userId);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/assist`,
      payload: {
        question: 'Зависший запрос.',
        tier: 'economy',
        idempotencyKey: `timeout-${nid()}`,
      },
    });
    expect(sseFrames(res.body).at(-1)).toMatchObject({ error: 'assist_timeout' });
    expect(await balanceOf(userId)).toBe(before);
    const [request] = await db
      .select()
      .from(scriptAssistRequests)
      .where(eq(scriptAssistRequests.scriptId, script.id));
    expect(request).toMatchObject({ status: 'aborted', failure: 'aborted' });
    await app.close();
  });

  it('empty or protocol-only provider output → retryable failure, no assistant turn, full refund', async () => {
    const script = await makeScript(userId);
    const { fetchImpl } = mockGateway({ chunks: ['  \n', '<rule>Не объяснять финал.</rule>'] });
    const app = await buildApp(userId, fetchImpl);
    const before = await balanceOf(userId);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/assist`,
      payload: { question: 'Вопрос.', tier: 'economy' },
    });

    const frames = sseFrames(res.body);
    expect(frames[frames.length - 1]).toMatchObject({ error: 'assist_unusable' });
    expect(await balanceOf(userId)).toBe(before);

    const [thread] = await db
      .select()
      .from(scriptThreads)
      .where(eq(scriptThreads.scriptId, script.id));
    expect(thread!.messages).toHaveLength(1);
    expect(thread!.messages[0]!.role).toBe('user');
    await app.close();
  });

  it('accepts a protocol-only rewrite when an anchor makes it an actionable proposal', async () => {
    const script = await makeScript(userId);
    const { fetchImpl } = mockGateway({ chunks: ['<rewrite>Новый текст.</rewrite>'] });
    const app = await buildApp(userId, fetchImpl);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/assist`,
      payload: {
        question: 'Перепиши.',
        tier: 'economy',
        anchor: { from: 0, to: 3, rev: script.rev, quote: script.fountain.slice(0, 3) },
      },
    });
    const frames = sseFrames(res.body);
    expect(frames.at(-1)?.done).toBe(true);
    expect(frames.at(-1)?.proposal?.after).toBe('Новый текст.');
    await app.close();
  });

  it('malformed internal protocol output is rejected and refunded', async () => {
    const script = await makeScript(userId);
    const { fetchImpl } = mockGateway({ chunks: ['<rewrite>Незакрытый внутренний блок'] });
    const app = await buildApp(userId, fetchImpl);
    const before = await balanceOf(userId);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/assist`,
      payload: { question: 'Вопрос.', tier: 'economy' },
    });
    expect(sseFrames(res.body).at(-1)).toMatchObject({ error: 'assist_unusable' });
    expect(await balanceOf(userId)).toBe(before);
    await app.close();
  });

  it('replaying a client idempotency key never starts a second paid provider call', async () => {
    const script = await makeScript(userId);
    const { fetchImpl, seen } = mockGateway({ chunks: ['Готово.'] });
    const app = await buildApp(userId, fetchImpl);
    const before = await balanceOf(userId);
    const payload = {
      question: 'Вопрос.',
      tier: 'economy',
      idempotencyKey: `assist-retry-${nid()}`,
    };

    const first = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/assist`,
      payload,
    });
    expect(sseFrames(first.body).at(-1)).toMatchObject({ done: true });

    const replay = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/assist`,
      payload,
    });
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toMatchObject({ error: 'assist_already_completed' });
    expect(seen.calls).toBe(1);
    expect(await balanceOf(userId)).toBe(before - ECONOMY.project);

    const [request] = await db
      .select()
      .from(scriptAssistRequests)
      .where(eq(scriptAssistRequests.scriptId, script.id));
    expect(request).toMatchObject({ status: 'completed', idempotencyKey: payload.idempotencyKey });
    await app.close();
  });

  it('legacy requests without a key derive a stable claim and cannot double-charge on retry', async () => {
    const script = await makeScript(userId);
    const { fetchImpl, seen } = mockGateway({ chunks: ['Готово.'] });
    const app = await buildApp(userId, fetchImpl);
    const before = await balanceOf(userId);
    const payload = { question: 'Повтори безопасно.', tier: 'economy' as const };

    const first = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/assist`,
      payload,
    });
    expect(sseFrames(first.body).at(-1)).toMatchObject({ done: true });

    const replay = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/assist`,
      payload,
    });
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toMatchObject({ error: 'assist_already_completed' });
    expect(seen.calls).toBe(1);
    expect(await balanceOf(userId)).toBe(before - ECONOMY.project);

    const [request] = await db
      .select({ idempotencyKey: scriptAssistRequests.idempotencyKey })
      .from(scriptAssistRequests)
      .where(eq(scriptAssistRequests.scriptId, script.id));
    expect(request?.idempotencyKey).toMatch(/^legacy:[a-f0-9]{64}$/);
    await app.close();
  });

  it('fences the reserve: a reaper deletion mid-flight rolls back — no hold committed (409)', async () => {
    const user = await makeFundedUser();
    const script = await makeScript(user);
    const before = await balanceOf(user);
    const { fetchImpl, seen } = mockGateway();
    // Simulate the reaper deleting our aged claim exactly during reservation
    // (pre-provider work isn't bounded by the 120s deadline).
    const racyCredits = {
      reserve: async (input: Parameters<typeof creditService.reserve>[0]) => {
        await db.delete(scriptAssistRequests).where(eq(scriptAssistRequests.userId, user));
        return creditService.reserve(input);
      },
      commit: creditService.commit.bind(creditService),
      refund: creditService.refund.bind(creditService),
    };
    const app = await buildApp(user, fetchImpl, { credits: racyCredits });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/assist`,
      payload: { question: 'Вопрос.', tier: 'economy', idempotencyKey: `k-${nid()}` },
    });

    // Ownership lost → the reserve tx rolled back: no hold, no gateway call.
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('assist_in_progress');
    expect(seen.calls).toBe(0);
    expect(await balanceOf(user)).toBe(before); // reservation rolled back
    await app.close();
  });

  it('durably refunds even when the inline refund fails — never a swallowed strand', async () => {
    const user = await makeFundedUser();
    const script = await makeScript(user);
    const { fetchImpl } = mockGateway({ status: 500 }); // provider fails → refund path
    const failingRefund = {
      reserve: creditService.reserve.bind(creditService),
      commit: creditService.commit.bind(creditService),
      refund: async () => {
        throw new Error('refund down');
      },
    };
    const app = await buildApp(user, fetchImpl, { credits: failingRefund });
    const key = `k-${nid()}`;

    await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/assist`,
      payload: { question: 'Вопрос.', tier: 'economy', idempotencyKey: key },
    });

    // The claim reaches a terminal state AND a durable refund is enqueued — the
    // failure is NOT swallowed into a stranded hold the reaper can't see.
    const [claim] = await db
      .select({ status: scriptAssistRequests.status, jobId: scriptAssistRequests.jobId })
      .from(scriptAssistRequests)
      .where(
        and(eq(scriptAssistRequests.userId, user), eq(scriptAssistRequests.idempotencyKey, key)),
      )
      .limit(1);
    expect(['failed', 'aborted']).toContain(claim!.status);
    const refunds = await db
      .select({ payload: outboxJobs.payload })
      .from(outboxJobs)
      .where(eq(outboxJobs.queueName, 'credits.refund'));
    expect(
      refunds.some(
        (o) =>
          (o.payload as { idempotencyKey?: string }).idempotencyKey ===
          `assist:${claim!.jobId}:refund`,
      ),
      'a durable refund must be enqueued when the inline refund fails',
    ).toBe(true);
    await db.delete(outboxJobs).where(eq(outboxJobs.jobId, `assist-refund-${claim!.jobId}`));
    await app.close();
  });

  it('fences completion: a reaper deletion during the provider call publishes no paid output and charges nothing', async () => {
    const user = await makeFundedUser();
    const script = await makeScript(user);
    // Gateway mock that streams a valid answer BUT deletes the claim mid-call
    // (simulating the reaper reaping an aged claim during the provider request).
    const fetchImpl: typeof fetch = async () => {
      await db.delete(scriptAssistRequests).where(eq(scriptAssistRequests.userId, user));
      const enc = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(
            enc.encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: 'Готово.' } }] })}\n\n`,
            ),
          );
          c.enqueue(enc.encode('data: [DONE]\n\n'));
          c.close();
        },
      });
      return new Response(stream, { status: 200 });
    };
    const app = await buildApp(user, fetchImpl);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/assist`,
      payload: { question: 'Вопрос.', tier: 'economy', idempotencyKey: `k-${nid()}` },
    });

    const frames = sseFrames(res.body);
    expect(frames.some((f) => f.done)).toBe(false); // completion fenced → no done frame
    expect(frames.some((f) => f.error === 'assist_failed')).toBe(true);
    // No assistant turn persisted (the completion tx rolled back).
    const threads = await db
      .select()
      .from(scriptThreads)
      .where(eq(scriptThreads.scriptId, script.id));
    expect(threads.some((t) => t.messages.some((m) => m.role === 'assistant'))).toBe(false);
    // And no commit was enqueued — the handler charged nothing for the reaped claim.
    const commits = await db
      .select({ payload: outboxJobs.payload })
      .from(outboxJobs)
      .where(eq(outboxJobs.queueName, 'credits.commit'));
    expect(commits.some((o) => (o.payload as { userId?: string }).userId === user)).toBe(false);
    await app.close();
  });

  it('op-scoped keys: a structurize row sharing the key never confuses assist idempotency', async () => {
    const script = await makeScript(userId);
    const { fetchImpl } = mockGateway({ chunks: ['Готово.'] });
    const app = await buildApp(userId, fetchImpl);
    const key = `shared-op-${nid()}`;
    // A structurize row (op='structurize') reuses the SAME client key, in a
    // DIFFERENT status than the assist request will end in.
    await db.insert(scriptAssistRequests).values({
      id: nid(),
      scriptId: script.id,
      userId,
      idempotencyKey: key,
      op: 'structurize',
      jobId: nid(),
      status: 'in_progress',
    });
    const payload = { question: 'Вопрос.', tier: 'economy', idempotencyKey: key };

    // Assist proceeds on its own op-scoped claim (not blocked by the structurize key).
    const first = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/assist`,
      payload,
    });
    expect(sseFrames(first.body).at(-1)).toMatchObject({ done: true });

    // The replay reports the ASSIST row's completed status, NOT the structurize
    // row's in_progress — assist idempotency is deterministic across the collision.
    const replay = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/assist`,
      payload,
    });
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toMatchObject({ error: 'assist_already_completed' });
    await app.close();
  });

  it('allows only one in-flight paid assist per user, even with a different request key', async () => {
    const script = await makeScript(userId);
    let release!: () => void;
    let started!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      if (calls > 1) {
        const enc = new TextEncoder();
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                enc.encode(
                  `data: ${JSON.stringify({ choices: [{ delta: { content: 'Лишний ответ.' } }] })}\n\n`,
                ),
              );
              controller.enqueue(enc.encode('data: [DONE]\n\n'));
              controller.close();
            },
          }),
          { status: 200 },
        );
      }
      const enc = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          started();
          release = () => {
            controller.enqueue(
              enc.encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: 'Готово.' } }] })}\n\n`,
              ),
            );
            controller.enqueue(enc.encode('data: [DONE]\n\n'));
            controller.close();
          };
        },
      });
      return new Response(stream, { status: 200 });
    };
    const app = await buildApp(userId, fetchImpl);
    const first = app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/assist`,
      payload: {
        question: 'Первый вопрос.',
        tier: 'economy',
        idempotencyKey: `assist-first-${nid()}`,
      },
    });
    await providerStarted;

    const second = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/assist`,
      payload: {
        question: 'Второй вопрос.',
        tier: 'economy',
        idempotencyKey: `assist-second-${nid()}`,
      },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: 'assist_in_progress' });

    release();
    expect((await first).statusCode).toBe(200);
    await app.close();
  });

  it('insufficient credits → 402, nothing streamed, no thread', async () => {
    const poorUser = await makeFundedUser(0);
    const script = await makeScript(poorUser);
    const { fetchImpl } = mockGateway();
    const app = await buildApp(poorUser, fetchImpl);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/assist`,
      payload: { question: 'Вопрос.', tier: 'max' },
    });
    expect(res.statusCode).toBe(402);
    expect(res.json()).toEqual({
      error: 'insufficient_credits',
      required: assistTier('max')!.creditsPerCall.project,
    });
    const threads = await db
      .select()
      .from(scriptThreads)
      .where(eq(scriptThreads.scriptId, script.id));
    expect(threads).toHaveLength(0);
    await app.close();
  });

  it("IDOR: assisting another user's script → 404, nothing charged", async () => {
    const script = await makeScript(userId);
    const { fetchImpl } = mockGateway();
    const intruder = await makeFundedUser();
    const app = await buildApp(intruder, fetchImpl);
    const before = await balanceOf(intruder);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/assist`,
      payload: { question: 'Дай чужой сценарий.' },
    });
    expect(res.statusCode).toBe(404);
    expect(await balanceOf(intruder)).toBe(before);
    await app.close();
  });
});

describe('chat scope (pinned project conversation)', () => {
  it('returns a read-only band quote and rejects a stale signed submit before provider/credits', async () => {
    const script = await makeScript(userId);
    const { fetchImpl, seen } = mockGateway({ chunks: ['Готово.'] });
    const app = await buildApp(userId, fetchImpl);
    const quoteRes = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/assist/quote`,
      payload: { question: 'О чём эта история?', tier: 'economy', scope: 'project' },
    });
    expect(quoteRes.statusCode).toBe(200);
    const quote = quoteRes.json() as {
      credits: number;
      inputBand: string;
      maxOutputTokens: number;
      quoteFingerprint: string;
      scope: string;
    };
    expect(quote).toMatchObject({ scope: 'project', maxOutputTokens: 2_000 });
    expect(quote.credits).toBeGreaterThan(0);
    expect(quote.inputBand).toMatch(/^(8k|16k|24k)$/);
    expect(quote.quoteFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(seen.calls).toBe(0);

    const stale = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/assist`,
      payload: {
        question: 'О чём эта история?',
        tier: 'economy',
        scope: 'project',
        expectedCredits: quote.credits + 1,
        quoteFingerprint: quote.quoteFingerprint,
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe('quote_stale');
    expect(seen.calls).toBe(0);

    const accepted = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/assist`,
      payload: {
        question: 'О чём эта история?',
        tier: 'economy',
        scope: 'project',
        expectedCredits: quote.credits,
        quoteFingerprint: quote.quoteFingerprint,
        idempotencyKey: `signed-${nid()}`,
      },
    });
    expect(accepted.statusCode).toBe(200);
    expect(sseFrames(accepted.body)[0]).toMatchObject({
      credits: quote.credits,
      scope: 'project',
      inputBand: quote.inputBand,
    });
    expect(seen.calls).toBe(1);
    await app.close();
  });

  it('default no-anchor call is bounded project context and reuses one pinned thread', async () => {
    const script = await makeScript(userId);
    const { fetchImpl, seen } = mockGateway({ chunks: ['Поговорим.'] });
    const app = await buildApp(userId, fetchImpl);
    const before = await balanceOf(userId);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/assist`,
      payload: { question: 'О чём вообще эта история?', tier: 'economy' },
    });
    const frames = sseFrames(res.body);
    expect(frames[0]).toMatchObject({
      credits: ECONOMY.project,
      scope: 'project',
      materials: false,
    });
    const sent = JSON.stringify(seen.body!.messages);
    expect(sent).toContain('КАРТА ПРОЕКТА');
    expect(sent).not.toContain('=== СЦЕНАРИЙ ===');
    expect(await balanceOf(userId)).toBe(before - ECONOMY.project);

    // A second chat call reuses the SAME pinned kind=chat thread.
    await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/assist`,
      payload: { question: 'А тон?', tier: 'economy' },
    });
    const threads = await db
      .select()
      .from(scriptThreads)
      .where(eq(scriptThreads.scriptId, script.id));
    expect(threads).toHaveLength(1);
    expect(threads[0]!.kind).toBe('chat');
    expect(threads[0]!.messages).toHaveLength(4); // 2 user + 2 assistant
    await app.close();
  });
});

describe('explicit scene scope', () => {
  it('sends one scene plus the global project map and never the full raw document', async () => {
    const script = await makeScript(userId);
    const { fetchImpl, seen } = mockGateway({ chunks: ['Сцена работает.'] });
    const app = await buildApp(userId, fetchImpl);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/assist`,
      payload: { question: 'Проверь сцену.', tier: 'economy', scope: 'scene', sceneOrdinal: 1 },
    });
    expect(sseFrames(res.body)[0]).toMatchObject({ scope: 'scene', credits: ECONOMY.scene });
    const sent = JSON.stringify(seen.body!.messages);
    expect(sent).toContain('КАРТА ПРОЕКТА');
    expect(sent).toContain('ТЕКУЩАЯ СЦЕНА 1');
    expect(sent).not.toContain('=== СЦЕНАРИЙ ===');
    await app.close();
  });
});

describe('materials in context (baked into the base price, no separate surcharge)', () => {
  it('injects «Материалы» into the prompt WITHOUT changing the price', async () => {
    const script = await makeScript(userId);
    await db.insert(scriptMaterials).values({
      id: nid(),
      scriptId: script.id,
      userId,
      name: 'лор-мира.md',
      content: 'Кинотеатр закрыт с 1993 года. Плёнку никто не менял.',
      chars: 52,
    });
    const { fetchImpl, seen } = mockGateway({ chunks: ['Учту.'] });
    const app = await buildApp(userId, fetchImpl);
    const before = await balanceOf(userId);

    const from = FOUNTAIN.indexOf(SPAN);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/assist`,
      payload: {
        question: 'Сожми реплику.',
        anchor: { from, to: from + SPAN.length, rev: 0, quote: SPAN },
        tier: 'standard', // materials add nothing (baked in)
      },
    });
    const frames = sseFrames(res.body);
    expect(frames[0]).toMatchObject({
      credits: assistTier('standard')!.creditsPerCall.span,
      materials: true,
    });
    const sent = JSON.stringify(seen.body!.messages);
    expect(sent).toContain('МАТЕРИАЛЫ ПРОЕКТА');
    expect(sent).toContain('Кинотеатр закрыт с 1993 года');
    expect(await balanceOf(userId)).toBe(before - assistTier('standard')!.creditsPerCall.span);
    await app.close();
  });

  it('economy span with materials is still just the workbook base span price', async () => {
    const script = await makeScript(userId);
    await db.insert(scriptMaterials).values({
      id: nid(),
      scriptId: script.id,
      userId,
      name: 'заметка.txt',
      content: 'Лида — не отвечает прямо.',
      chars: 25,
    });
    const { fetchImpl } = mockGateway({ chunks: ['Ок.'] });
    const app = await buildApp(userId, fetchImpl);
    const from = FOUNTAIN.indexOf(SPAN);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/assist`,
      payload: {
        question: 'Сожми.',
        anchor: { from, to: from + SPAN.length, rev: 0, quote: SPAN },
        tier: 'economy',
      },
    });
    expect(sseFrames(res.body)[0]).toMatchObject({ credits: ECONOMY.span, materials: true });
    await app.close();
  });
});

describe('thread memory (window + rolling conспект)', () => {
  it('includes the verbatim window and the stored conспект in the prompt', async () => {
    const script = await makeScript(userId);
    const history: ScriptThreadMessage[] = [
      { role: 'user', content: 'Первый вопрос про финал.', at: new Date().toISOString() },
      { role: 'assistant', content: 'Первый ответ про финал.', at: new Date().toISOString() },
    ];
    const [chat] = await db
      .insert(scriptThreads)
      .values({
        id: nid(),
        scriptId: script.id,
        userId,
        kind: 'chat',
        anchor: null,
        messages: history,
        conspect: 'РАНЕЕ: договорились, что Михалыч не объясняет финал.',
        conspectUpto: 0,
      })
      .returning();
    const { fetchImpl, seen } = mockGateway({ chunks: ['Продолжаю.'] });
    const app = await buildApp(userId, fetchImpl);
    await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/assist`,
      payload: { threadId: chat!.id, question: 'Новый вопрос.', tier: 'economy' },
    });
    const sent = JSON.stringify(seen.body!.messages);
    expect(sent).toContain('ПРЕДЫСТОРИЯ ОБСУЖДЕНИЯ'); // conспект section
    expect(sent).toContain('Михалыч не объясняет финал'); // conспект content
    expect(sent).toContain('ПОСЛЕДНИЕ СООБЩЕНИЯ'); // window section
    expect(sent).toContain('Первый вопрос про финал'); // window content
    expect(sent).toContain('Новый вопрос.'); // the question
    await app.close();
  });

  it('folds evicted messages into the conспект via the economy model', async () => {
    const script = await makeScript(userId);
    // A long back-and-forth that overflows the ~9k-char verbatim window.
    const big = 'а'.repeat(3_000);
    const history: ScriptThreadMessage[] = Array.from({ length: 8 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `Сообщение ${i}: ${big}`,
      at: new Date().toISOString(),
    }));
    const [chat] = await db
      .insert(scriptThreads)
      .values({
        id: nid(),
        scriptId: script.id,
        userId,
        kind: 'chat',
        anchor: null,
        messages: history,
      })
      .returning();

    // Distinguish the fold (2nd) call's output from the assist (1st) call's.
    const bodies: Record<string, unknown>[] = [];
    let call = 0;
    const fetchImpl: typeof fetch = async (_u, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      const text = call++ === 0 ? 'Отвечаю по делу.' : 'КОНСПЕКТ: обсудили восемь длинных реплик.';
      const enc = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(
            enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`),
          );
          c.enqueue(enc.encode('data: [DONE]\n\n'));
          c.close();
        },
      });
      return new Response(stream, { status: 200 });
    };
    const app = await buildApp(userId, fetchImpl);
    await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/assist`,
      payload: { threadId: chat!.id, question: 'Короткий вопрос.', tier: 'economy' },
    });

    expect(bodies.length).toBe(2); // assist + conспект-fold
    const t = await db.select().from(scriptThreads).where(eq(scriptThreads.id, chat!.id));
    expect(t[0]!.conspect).toContain('КОНСПЕКТ');
    expect(t[0]!.conspectUpto).toBeGreaterThan(0);
    await app.close();
  });
});

describe('POST /v1/scripts/:id/threads/:threadId/apply', () => {
  async function assistedThread(script: { id: string }) {
    const { fetchImpl } = mockGateway();
    const app = await buildApp(userId, fetchImpl);
    const from = FOUNTAIN.indexOf(SPAN);
    await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/assist`,
      payload: {
        question: 'Сожми.',
        anchor: { from, to: from + SPAN.length, rev: 0, quote: SPAN },
        tier: 'economy',
      },
    });
    const threads = await db
      .select()
      .from(scriptThreads)
      .where(eq(scriptThreads.scriptId, script.id));
    return { app, thread: threads[0]! };
  }

  it('applies the proposal: text replaced, rev+1, snapshot cause=apply, thread applied', async () => {
    const script = await makeScript(userId);
    const { app, thread } = await assistedThread(script);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/threads/${thread.id}/apply`,
      payload: { baseRev: 0 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, rev: 1 });

    const after = await db.select().from(scripts).where(eq(scripts.id, script.id));
    expect(after[0]!.fountain).toContain('Всё. Домой.');
    expect(after[0]!.fountain).not.toContain('я сам видел');
    expect(after[0]!.rev).toBe(1);

    const snaps = await db
      .select()
      .from(scriptSnapshots)
      .where(eq(scriptSnapshots.scriptId, script.id));
    expect(snaps.map((s) => s.cause)).toContain('apply');

    const t = await db.select().from(scriptThreads).where(eq(scriptThreads.id, thread.id));
    expect(t[0]!.status).toBe('applied');
    await app.close();
  });

  it('apply-conflict: stale baseRev → 409 rev_conflict, text untouched', async () => {
    const script = await makeScript(userId);
    const { app, thread } = await assistedThread(script);
    await db.update(scripts).set({ rev: 7 }).where(eq(scripts.id, script.id));

    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/threads/${thread.id}/apply`,
      payload: { baseRev: 0 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'rev_conflict', rev: 7 });
    const after = await db.select().from(scripts).where(eq(scripts.id, script.id));
    expect(after[0]!.fountain).toContain('я сам видел');
    await app.close();
  });

  it('apply after the span was rewritten → 409 anchor_detached, thread detached', async () => {
    const script = await makeScript(userId);
    const { app, thread } = await assistedThread(script);
    await db
      .update(scripts)
      .set({ fountain: FOUNTAIN.replace(SPAN, 'Совсем другой текст.'), rev: 1 })
      .where(eq(scripts.id, script.id));

    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/threads/${thread.id}/apply`,
      payload: { baseRev: 1 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'anchor_detached' });
    const t = await db.select().from(scriptThreads).where(eq(scriptThreads.id, thread.id));
    expect(t[0]!.status).toBe('detached');
    await app.close();
  });
});

describe('POST /v1/scripts/:id/threads/:threadId/revert', () => {
  /** Apply a proposal first, returning the app and thread ready for revert. */
  async function appliedThread(script: { id: string }) {
    const { fetchImpl } = mockGateway();
    const app = await buildApp(userId, fetchImpl);
    const from = FOUNTAIN.indexOf(SPAN);
    await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/assist`,
      payload: {
        question: 'Сожми.',
        anchor: { from, to: from + SPAN.length, rev: 0, quote: SPAN },
        tier: 'economy',
      },
    });
    const threads = await db
      .select()
      .from(scriptThreads)
      .where(eq(scriptThreads.scriptId, script.id));
    const thread = threads[0]!;
    // Apply it so revert has something to undo.
    await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/threads/${thread.id}/apply`,
      payload: { baseRev: 0 },
    });
    return { app, thread };
  }

  it('reverts the applied proposal: before-text restored, rev+1, snapshot cause=revert, thread dismissed', async () => {
    const script = await makeScript(userId);
    const { app, thread } = await appliedThread(script);

    // Confirm apply landed.
    let rows = await db.select().from(scripts).where(eq(scripts.id, script.id));
    expect(rows[0]!.fountain).toContain('Всё. Домой.');
    expect(rows[0]!.rev).toBe(1);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/threads/${thread.id}/revert`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, rev: 2 });

    rows = await db.select().from(scripts).where(eq(scripts.id, script.id));
    expect(rows[0]!.fountain).toContain(SPAN); // original text back
    expect(rows[0]!.fountain).not.toContain('Всё. Домой.');
    expect(rows[0]!.rev).toBe(2);

    const snaps = await db
      .select()
      .from(scriptSnapshots)
      .where(eq(scriptSnapshots.scriptId, script.id));
    expect(snaps.map((s) => s.cause)).toContain('revert');

    const t = await db.select().from(scriptThreads).where(eq(scriptThreads.id, thread.id));
    expect(t[0]!.status).toBe('dismissed');
    await app.close();
  });

  it('reverts only once: second revert -> 409 not_applied', async () => {
    const script = await makeScript(userId);
    const { app, thread } = await appliedThread(script);
    await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/threads/${thread.id}/revert`,
      payload: {},
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/threads/${thread.id}/revert`,
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'not_applied' });
    await app.close();
  });

  it("IDOR: reverting another user's thread -> 404", async () => {
    const script = await makeScript(userId);
    const { app, thread } = await appliedThread(script);

    const otherUserId = await makeFundedUser();
    const otherApp = await buildApp(otherUserId, mockGateway().fetchImpl);
    const res = await otherApp.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/threads/${thread.id}/revert`,
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    await otherApp.close();
    await app.close();
  });

  it('revert after manual edits moved past the span (after-text gone) -> 409 revert_detached', async () => {
    const script = await makeScript(userId);
    const { app, thread } = await appliedThread(script);
    // Overwrite the whole fountain - the applied after-text is nowhere.
    await db
      .update(scripts)
      .set({ fountain: 'СОВСЕМ ДРУГОЙ СЦЕНАРИЙ\n\nКОНЕЦ.', rev: 5 })
      .where(eq(scripts.id, script.id));

    const res = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/threads/${thread.id}/revert`,
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'revert_detached' });
    await app.close();
  });
});

describe('GET /v1/assist/tiers', () => {
  it('lists the three tiers with per-scope prices; materials are baked in (surcharge 0)', async () => {
    const { fetchImpl } = mockGateway();
    const app = await buildApp(userId, fetchImpl);
    const res = await app.inject({ method: 'GET', url: '/v1/assist/tiers' });
    const items = res.json().items as Array<{
      id: string;
      materialsSurcharge: number;
      isActive: boolean;
      creditsPerCall: { project: number; span: number; scene: number; script: number };
    }>;
    expect(items.map((t) => t.id)).toEqual(['economy', 'standard', 'max']);
    // The endpoint must publish exactly what the calculator derives — not a
    // matrix typed in beside it, which is only ever right until an input moves.
    expect(items.map((t) => t.creditsPerCall)).toEqual(ASSIST_TIERS.map((t) => t.creditsPerCall));
    expect(items.map((t) => t.materialsSurcharge)).toEqual([0, 0, 0]);
    // Untoggled tiers read as active (missing row ⇒ active, fail-open by design).
    expect(items.map((t) => t.isActive)).toEqual([true, true, true]);
    await app.close();
  });
});

describe('compactMaterialText — background МИР ПРОЕКТА memory compaction', () => {
  const bigRaw = 'СЫРОЙ материал проекта. '.repeat(200); // well over the min

  it('summarizes a large file with the economy model, always shorter than raw', async () => {
    const { fetchImpl, seen } = mockGateway({ chunks: ['Марк — механик, немногословен.'] });
    const summary = await compactMaterialText(fetchImpl, 'заявка.docx', bigRaw);
    expect(summary).toBe('Марк — механик, немногословен.');
    expect(summary!.length).toBeLessThan(bigRaw.length);
    // Economy tier always uses its certified primary with reasoning disabled.
    expect(seen.body?.model).toBe('qwen/qwen3.5-plus-02-15');
    expect(seen.body?.reasoning).toEqual({ enabled: false });
  });

  it('skips small files (returns null → raw content kept)', async () => {
    const { fetchImpl, seen } = mockGateway({ chunks: ['unused'] });
    const summary = await compactMaterialText(fetchImpl, 'note.txt', 'коротко');
    expect(summary).toBeNull();
    expect(seen.body).toBeUndefined(); // no gateway call for a tiny file
  });

  it('returns null (keeps raw) when the summary would not be shorter', async () => {
    // Raw exactly at the min; a summary that fills the cap is not shorter → null.
    const raw = 'я'.repeat(MATERIAL_SUMMARY_MIN_RAW_CHARS);
    const { fetchImpl } = mockGateway({ chunks: ['x'.repeat(raw.length + 500)] });
    expect(await compactMaterialText(fetchImpl, 'a', raw)).toBeNull();
  });

  it('returns null on a gateway error (best-effort, never throws)', async () => {
    const { fetchImpl } = mockGateway({ status: 500 });
    expect(await compactMaterialText(fetchImpl, 'a', bigRaw)).toBeNull();
  });
});

describe('POST /v1/scripts/:id/assist — tier admin kill-switch (assist_tier_states)', () => {
  it('rejects a disabled tier with tier_disabled BEFORE any claim/credit movement; re-enabled works', async () => {
    const user = await makeFundedUser(50);
    const script = await makeScript(user);
    const { fetchImpl, seen } = mockGateway();
    const app = await buildApp(user, fetchImpl);
    const [beforeRow] = await db
      .select()
      .from(assistTierStates)
      .where(eq(assistTierStates.tierId, 'economy'))
      .limit(1);
    try {
      // What PATCH /v1/admin/text-tiers/economy {isActive:false} persists.
      await db
        .insert(assistTierStates)
        .values({ tierId: 'economy', isActive: false, updatedAt: new Date(), updatedBy: 'test' })
        .onConflictDoUpdate({
          target: assistTierStates.tierId,
          set: { isActive: false, updatedAt: new Date(), updatedBy: 'test' },
        });
      invalidateAssistTierStates();

      const balanceBefore = await balanceOf(user);
      const res = await app.inject({
        method: 'POST',
        url: `/v1/scripts/${script.id}/assist`,
        payload: { question: 'Вопрос.', tier: 'economy' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'tier_disabled' });
      // Fail closed BEFORE any side effect: no provider call, no claim row,
      // no credit hold — the balance must not move.
      expect(seen.calls).toBe(0);
      expect(await balanceOf(user)).toBe(balanceBefore);
      const claims = await db
        .select()
        .from(scriptAssistRequests)
        .where(
          and(eq(scriptAssistRequests.userId, user), eq(scriptAssistRequests.scriptId, script.id)),
        );
      expect(claims).toHaveLength(0);
      const assistTxns = await db
        .select()
        .from(creditTransactions)
        .where(
          and(
            eq(creditTransactions.userId, user),
            like(creditTransactions.reason, 'script.assist%'),
          ),
        );
      expect(assistTxns).toHaveLength(0);

      // Switched back ON → the same call streams and commits normally.
      await db
        .update(assistTierStates)
        .set({ isActive: true, updatedAt: new Date() })
        .where(eq(assistTierStates.tierId, 'economy'));
      invalidateAssistTierStates();
      const ok = await app.inject({
        method: 'POST',
        url: `/v1/scripts/${script.id}/assist`,
        payload: { question: 'Вопрос.', tier: 'economy' },
      });
      expect(ok.statusCode).toBe(200);
      const frames = sseFrames(ok.body);
      expect(frames[frames.length - 1]).toMatchObject({ done: true });
    } finally {
      // Restore shared state (seed ships all ACTIVE; a missing row also reads ACTIVE).
      if (beforeRow) {
        await db
          .update(assistTierStates)
          .set({
            isActive: beforeRow.isActive,
            updatedAt: beforeRow.updatedAt,
            updatedBy: beforeRow.updatedBy,
          })
          .where(eq(assistTierStates.tierId, 'economy'));
      } else {
        await db.delete(assistTierStates).where(eq(assistTierStates.tierId, 'economy'));
      }
      invalidateAssistTierStates();
      await app.close();
    }
  });
});

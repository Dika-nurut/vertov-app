import 'dotenv/config';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, like } from 'drizzle-orm';
import { aiUsageEvents, db, nid, pool, outboxJobs, scripts, usersApp, usersPii } from '@seed/db';
import { creditService } from '@seed/credits';
import { assistTier } from '@seed/shared';
import { setupScriptAssistRoutes } from '../src/script-assist';

/**
 * kie.ai primary / OpenRouter fallback routing for the standard tier
 * (google/gemini-3-flash-preview, OpenAI-shaped kie chat endpoint) AND the max
 * tier (anthropic/claude-sonnet-5, Anthropic-shaped kie claude endpoint) —
 * owner decisions 2026-07-24. Gateway ALWAYS mocked; the injected fetchImpl
 * discriminates legs by URL substring ('claude' → kie claude, 'kie' → kie
 * gemini, else OpenRouter). KIE_API_KEY / KIE_CHAT_DISABLED are read per call
 * by the router, so each test sets the exact env it needs (saved + restored
 * around every test — dotenv loads the developer's real KIE_API_KEY from .env).
 */

const FOUNTAIN = [
  'ИНТ. КИНОБУДКА - НОЧЬ',
  '',
  'Тесная будка киномеханика.',
  '',
  'МИХАЛЫЧ',
  'Этого не может быть. Плёнка кончилась, я сам видел.',
  '',
].join('\n');

const createdUsers: string[] = [];
const createdScripts: string[] = [];

async function makeFundedUser(credits = 1_000): Promise<string> {
  const id = nid();
  await db.insert(usersApp).values({ id, displayName: 'KieRouteTest', locale: 'ru' });
  await db.insert(usersPii).values({ id, email: `kie-test+${id}@seed.local` });
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

async function makeScript(userId: string) {
  const [row] = await db
    .insert(scripts)
    .values({ id: nid(), userId, title: 'Тест', fountain: FOUNTAIN })
    .returning();
  createdScripts.push(row!.id);
  return row!;
}

const isKieUrl = (url: unknown) => String(url).includes('kie') && !String(url).includes('claude');
const isKieClaudeUrl = (url: unknown) => String(url).includes('claude');

/** OpenAI-shaped SSE success response (shared shape across both OR + kie-gemini legs). */
function sseOk(chunks: string[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(
          enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`),
        );
      }
      controller.enqueue(enc.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

/** Anthropic-shaped SSE event frame (`event:` + `data:` pair). */
function anthropicFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Full Anthropic event stream around the given text fragments. */
function anthropicEvents(chunks: string[], opts: { thinkingFirst?: boolean } = {}): string[] {
  return [
    anthropicFrame('message_start', {
      type: 'message_start',
      message: { id: 'msg_1', role: 'assistant' },
    }),
    anthropicFrame('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
    ...(opts.thinkingFirst
      ? [
          anthropicFrame('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: 'думаю…' },
          }),
        ]
      : []),
    ...chunks.map((c) =>
      anthropicFrame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: c },
      }),
    ),
    anthropicFrame('content_block_stop', { type: 'content_block_stop', index: 0 }),
    anthropicFrame('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
    }),
    anthropicFrame('message_stop', { type: 'message_stop' }),
  ];
}

/** Anthropic-shaped SSE success response (kie claude leg). */
function anthropicSseOk(chunks: string[], opts: { thinkingFirst?: boolean } = {}): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of anthropicEvents(chunks, opts)) controller.enqueue(enc.encode(frame));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

/** Emits the chunks, then dies mid-stream (no [DONE], transport error). */
function sseDiesAfter(chunks: string[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(
          enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`),
        );
      }
      // Defer the error past the enqueued frames: erroring SYNCHRONOUSLY resets
      // the stream queue and the reader never sees the deltas (spec behavior) —
      // that would simulate a pre-token drop, not a mid-stream death.
      setTimeout(() => controller.error(new Error('kie stream died mid-flight')), 0);
    },
  });
  return new Response(stream, { status: 200 });
}

/** Anthropic variant of sseDiesAfter (one text_delta delivered, then dead). */
function anthropicSseDiesAfter(chunks: string[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(anthropicFrame('message_start', { type: 'message_start' })));
      for (const c of chunks) {
        controller.enqueue(
          enc.encode(
            anthropicFrame('content_block_delta', {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: c },
            }),
          ),
        );
      }
      // See sseDiesAfter — the error must land AFTER the reader consumed the frames.
      setTimeout(() => controller.error(new Error('kie claude stream died mid-flight')), 0);
    },
  });
  return new Response(stream, { status: 200 });
}

interface SeenCall {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

/** Records calls per leg; `respond` picks each leg's behavior. */
function mockLegs(respond: {
  kie?: (call: number) => Response;
  claude?: (call: number) => Response;
  or?: (call: number) => Response;
}) {
  const seen: { kie: SeenCall[]; claude: SeenCall[]; or: SeenCall[] } = {
    kie: [],
    claude: [],
    or: [],
  };
  const fetchImpl: typeof fetch = async (url, init) => {
    const leg = isKieClaudeUrl(url) ? 'claude' : isKieUrl(url) ? 'kie' : 'or';
    const bucket = seen[leg];
    bucket.push({
      url: String(url),
      body: JSON.parse(String(init?.body)),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const handler =
      respond[leg] ??
      (() => {
        throw new Error(`unexpected ${leg} call`);
      });
    return handler(bucket.length);
  };
  return { fetchImpl, seen };
}

function buildApp(userId: string, fetchImpl: typeof fetch): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  setupScriptAssistRoutes(app, async () => ({ user: { id: userId } }), { fetchImpl });
  return app.ready().then(() => app);
}

const sseFrames = (body: string): Record<string, unknown>[] =>
  body
    .split('\n\n')
    .filter((f) => f.startsWith('data: '))
    .map((f) => JSON.parse(f.slice(6)));

const balanceOf = async (userId: string) => (await creditService.balanceFor(userId)).available;

/** One standard-tier chat call (project scope) against the mocked legs. */
function askStandard(app: FastifyInstance, scriptId: string) {
  return app.inject({
    method: 'POST',
    url: `/v1/scripts/${scriptId}/assist`,
    payload: { question: 'Как усилить сцену?', tier: 'standard' },
  });
}

/** One max-tier chat call (project scope) against the mocked legs. */
function askMax(app: FastifyInstance, scriptId: string) {
  return app.inject({
    method: 'POST',
    url: `/v1/scripts/${scriptId}/assist`,
    payload: { question: 'Как усилить сцену?', tier: 'max' },
  });
}

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['KIE_API_KEY', 'KIE_CHAT_DISABLED'] as const;

function setKieEnv(patch: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>) {
  for (const key of ENV_KEYS) {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key];
    const value = patch[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
    delete savedEnv[key];
  }
});

let userId: string;

beforeAll(async () => {
  userId = await makeFundedUser();
});

afterAll(async () => {
  // Durable commit/refund outbox rows this suite enqueued (no worker drains
  // them in tests) — clean up so they don't accumulate across runs.
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

describe('kie.ai primary leg for the standard tier (google/gemini-3-flash-preview)', () => {
  it('(a) kie success — SSE deltas parsed, OpenAI-parts body, no model field, OR untouched', async () => {
    setKieEnv({ KIE_API_KEY: 'test-kie-key', KIE_CHAT_DISABLED: undefined });
    const script = await makeScript(userId);
    const { fetchImpl, seen } = mockLegs({ kie: () => sseOk(['Смотри. ', 'Так сильнее.']) });
    const app = await buildApp(userId, fetchImpl);
    const before = await balanceOf(userId);

    const res = await askStandard(app, script.id);
    expect(res.statusCode).toBe(200);
    const frames = sseFrames(res.body);
    expect(frames[0]).toMatchObject({ tier: 'standard' });
    // Deltas pass through the route's ProtocolStreamFilter, which holds back a
    // 10-char tail until flush — assert on the JOINED visible text, not chunks.
    const visible = frames.map((f) => f.delta ?? '').join('');
    expect(visible).toContain('Смотри. Так сильнее.');
    expect(frames[frames.length - 1]!.done).toBe(true);

    // kie served; OpenRouter was never called.
    expect(seen.kie).toHaveLength(1);
    expect(seen.or).toHaveLength(0);

    // kie contract: model in the PATH (no body field), content as parts arrays,
    // tier's disableReasoning → include_thoughts:false + reasoning_effort:'low'.
    const kie = seen.kie[0]!;
    expect(kie.headers['Authorization']).toBe('Bearer test-kie-key');
    expect(kie.body).not.toHaveProperty('model');
    expect(kie.body.stream).toBe(true);
    expect(kie.body.include_thoughts).toBe(false);
    expect(kie.body.reasoning_effort).toBe('low');
    const messages = kie.body.messages as Array<{ role: string; content: unknown }>;
    for (const m of messages) {
      expect(Array.isArray(m.content)).toBe(true);
      expect((m.content as Array<{ type: string; text: string }>)[0]!.type).toBe('text');
    }

    expect(await balanceOf(userId)).toBeLessThan(before); // committed, not refunded
    await app.close();
  });

  it('(b) kie 500 pre-token → falls back to OpenRouter, text served by OR', async () => {
    setKieEnv({ KIE_API_KEY: 'test-kie-key', KIE_CHAT_DISABLED: undefined });
    const script = await makeScript(userId);
    const { fetchImpl, seen } = mockLegs({
      kie: () => new Response('{"error":"boom"}', { status: 500 }),
      or: () => sseOk(['Фолбэк сработал.']),
    });
    const app = await buildApp(userId, fetchImpl);
    const before = await balanceOf(userId);

    const res = await askStandard(app, script.id);
    const frames = sseFrames(res.body);
    expect(frames.some((f) => f.error)).toBe(false);
    expect(frames.map((f) => f.delta ?? '').join('')).toContain('Фолбэк сработал.');
    expect(frames[frames.length - 1]!.done).toBe(true);

    // One kie attempt, then exactly one OR call (success — no retry needed).
    expect(seen.kie).toHaveLength(1);
    expect(seen.or).toHaveLength(1);
    // The OR leg keeps the OpenRouter slug + the tier's reasoning kill.
    expect(seen.or[0]!.body.model).toBe('google/gemini-3-flash-preview');
    expect(seen.or[0]!.body.reasoning).toEqual({ enabled: false });

    expect(await balanceOf(userId)).toBeLessThan(before);
    await app.close();
  });

  it('(c) kie stream dies AFTER the first delta → no fallback, error propagates, refunded', async () => {
    setKieEnv({ KIE_API_KEY: 'test-kie-key', KIE_CHAT_DISABLED: undefined });
    const script = await makeScript(userId);
    const { fetchImpl, seen } = mockLegs({ kie: () => sseDiesAfter(['Первый токен.']) });
    const app = await buildApp(userId, fetchImpl);
    const before = await balanceOf(userId);

    const res = await askStandard(app, script.id);
    const frames = sseFrames(res.body);
    // A visible delta already went out (the filter's 10-char holdback still
    // releases the head of 'Первый токен.'); a replay on OR would duplicate
    // it — so the failure surfaces instead, and OR is never touched.
    expect(frames.some((f) => typeof f.delta === 'string' && (f.delta as string).length > 0)).toBe(
      true,
    );
    expect(frames[frames.length - 1]!.error).toBe('assist_failed');
    expect(seen.kie).toHaveLength(1);
    expect(seen.or).toHaveLength(0);
    expect(await balanceOf(userId)).toBe(before); // refunded
    await app.close();
  });

  it('(d) no KIE_API_KEY → straight to OpenRouter, kie never called', async () => {
    setKieEnv({ KIE_API_KEY: undefined, KIE_CHAT_DISABLED: undefined });
    const script = await makeScript(userId);
    const { fetchImpl, seen } = mockLegs({
      kie: () => {
        throw new Error('kie must not be called without a key');
      },
      or: () => sseOk(['Прямой OR.']),
    });
    const app = await buildApp(userId, fetchImpl);

    const res = await askStandard(app, script.id);
    const frames = sseFrames(res.body);
    expect(frames[frames.length - 1]!.done).toBe(true);
    expect(seen.kie).toHaveLength(0);
    expect(seen.or).toHaveLength(1);
    expect(seen.or[0]!.body.model).toBe('google/gemini-3-flash-preview');
    await app.close();
  });

  it('KIE_CHAT_DISABLED=1 kill-switch → OpenRouter even with the key set', async () => {
    setKieEnv({ KIE_API_KEY: 'test-kie-key', KIE_CHAT_DISABLED: '1' });
    const script = await makeScript(userId);
    const { fetchImpl, seen } = mockLegs({
      kie: () => {
        throw new Error('kie must not be called while disabled');
      },
      or: () => sseOk(['Kill-switch OR.']),
    });
    const app = await buildApp(userId, fetchImpl);

    const res = await askStandard(app, script.id);
    const frames = sseFrames(res.body);
    expect(frames[frames.length - 1]!.done).toBe(true);
    expect(seen.kie).toHaveLength(0);
    expect(seen.or).toHaveLength(1);
    await app.close();
  });

  it('kie empty stream (200, zero content) → treated as pre-token failure, OR serves', async () => {
    setKieEnv({ KIE_API_KEY: 'test-kie-key', KIE_CHAT_DISABLED: undefined });
    const script = await makeScript(userId);
    const { fetchImpl, seen } = mockLegs({
      kie: () => sseOk([]),
      or: () => sseOk(['Пустой kie.']),
    });
    const app = await buildApp(userId, fetchImpl);

    const res = await askStandard(app, script.id);
    const frames = sseFrames(res.body);
    expect(frames.map((f) => f.delta ?? '').join('')).toContain('Пустой kie.');
    expect(frames[frames.length - 1]!.done).toBe(true);
    expect(seen.kie).toHaveLength(1);
    expect(seen.or).toHaveLength(1);
    await app.close();
  });
});

describe('kie.ai Claude leg for the max tier (anthropic/claude-sonnet-5)', () => {
  it('(a) kie claude success — Anthropic SSE parsed, model+system in body, OR untouched', async () => {
    setKieEnv({ KIE_API_KEY: 'test-kie-key', KIE_CHAT_DISABLED: undefined });
    const script = await makeScript(userId);
    const { fetchImpl, seen } = mockLegs({
      claude: () => anthropicSseOk(['Смотри. ', 'Так сильнее.'], { thinkingFirst: true }),
    });
    const app = await buildApp(userId, fetchImpl);
    const before = await balanceOf(userId);

    const res = await askMax(app, script.id);
    expect(res.statusCode).toBe(200);
    const frames = sseFrames(res.body);
    expect(frames[0]).toMatchObject({ tier: 'max' });
    // The thinking_delta surfaces as the «thinking» phase before visible text.
    expect(frames.some((f) => f.phase === 'thinking')).toBe(true);
    const visible = frames.map((f) => f.delta ?? '').join('');
    expect(visible).toContain('Смотри. Так сильнее.');
    expect(frames[frames.length - 1]!.done).toBe(true);

    // kie claude served; the Gemini chat leg and OpenRouter were never called.
    expect(seen.claude).toHaveLength(1);
    expect(seen.kie).toHaveLength(0);
    expect(seen.or).toHaveLength(0);

    // Anthropic contract: model IN the body, top-level system string, user-only
    // messages with plain-string content, anthropic-version header, and NO
    // thinkingFlag / reasoning field (the max tier keeps provider defaults).
    const call = seen.claude[0]!;
    expect(call.headers['Authorization']).toBe('Bearer test-kie-key');
    expect(call.headers['anthropic-version']).toBe('2023-06-01');
    expect(call.body.model).toBe('claude-sonnet-5');
    expect(typeof call.body.system).toBe('string');
    expect((call.body.system as string).length).toBeGreaterThan(0);
    expect(call.body.stream).toBe(true);
    expect(typeof call.body.max_tokens).toBe('number');
    expect(call.body).not.toHaveProperty('thinkingFlag');
    expect(call.body).not.toHaveProperty('reasoning');
    const messages = call.body.messages as Array<{ role: string; content: unknown }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe('user');
    expect(typeof messages[0]!.content).toBe('string');

    expect(await balanceOf(userId)).toBeLessThan(before); // committed, not refunded
    await app.close();
  });

  it('(b) kie claude 500 pre-token → falls back to OpenRouter, text served by OR', async () => {
    setKieEnv({ KIE_API_KEY: 'test-kie-key', KIE_CHAT_DISABLED: undefined });
    const script = await makeScript(userId);
    const { fetchImpl, seen } = mockLegs({
      claude: () => new Response('{"error":"boom"}', { status: 500 }),
      or: () => sseOk(['Фолбэк сработал.']),
    });
    const app = await buildApp(userId, fetchImpl);
    const before = await balanceOf(userId);

    const res = await askMax(app, script.id);
    const frames = sseFrames(res.body);
    expect(frames.some((f) => f.error)).toBe(false);
    expect(frames.map((f) => f.delta ?? '').join('')).toContain('Фолбэк сработал.');
    expect(frames[frames.length - 1]!.done).toBe(true);

    // One kie claude attempt, then exactly one OR call (success — no retry).
    expect(seen.claude).toHaveLength(1);
    expect(seen.or).toHaveLength(1);
    // The OR leg keeps the OpenAI shape with the OpenRouter slug; the max tier
    // has no disableReasoning, so no reasoning kill goes out.
    expect(seen.or[0]!.body.model).toBe('anthropic/claude-sonnet-5');
    expect(seen.or[0]!.body).not.toHaveProperty('reasoning');

    expect(
      await db
        .select({
          attempt: aiUsageEvents.attempt,
          route: aiUsageEvents.route,
          outcome: aiUsageEvents.outcome,
          charged: aiUsageEvents.creditsCharged,
        })
        .from(aiUsageEvents)
        .where(eq(aiUsageEvents.scriptId, script.id))
        .orderBy(aiUsageEvents.attempt),
    ).toEqual([
      { attempt: 1, route: 'kie_claude', outcome: 'error', charged: null },
      {
        attempt: 2,
        route: 'openrouter',
        outcome: 'ok',
        charged: assistTier('max')!.creditsPerCall.project,
      },
    ]);

    expect(await balanceOf(userId)).toBeLessThan(before);
    await app.close();
  });

  it('(c) kie claude stream dies AFTER the first delta → no fallback, error propagates, refunded', async () => {
    setKieEnv({ KIE_API_KEY: 'test-kie-key', KIE_CHAT_DISABLED: undefined });
    const script = await makeScript(userId);
    const { fetchImpl, seen } = mockLegs({
      claude: () => anthropicSseDiesAfter(['Первый токен.']),
    });
    const app = await buildApp(userId, fetchImpl);
    const before = await balanceOf(userId);

    const res = await askMax(app, script.id);
    const frames = sseFrames(res.body);
    // A visible delta already went out; a replay on OR would duplicate it — so
    // the failure surfaces instead, and OR is never touched.
    expect(frames.some((f) => typeof f.delta === 'string' && (f.delta as string).length > 0)).toBe(
      true,
    );
    expect(frames[frames.length - 1]!.error).toBe('assist_failed');
    expect(seen.claude).toHaveLength(1);
    expect(seen.or).toHaveLength(0);
    expect(await balanceOf(userId)).toBe(before); // refunded
    await app.close();
  });

  it('(d) no KIE_API_KEY → straight to OpenRouter, kie claude never called', async () => {
    setKieEnv({ KIE_API_KEY: undefined, KIE_CHAT_DISABLED: undefined });
    const script = await makeScript(userId);
    const { fetchImpl, seen } = mockLegs({
      or: () => sseOk(['Прямой OR.']),
    });
    const app = await buildApp(userId, fetchImpl);

    const res = await askMax(app, script.id);
    const frames = sseFrames(res.body);
    expect(frames[frames.length - 1]!.done).toBe(true);
    expect(seen.claude).toHaveLength(0);
    expect(seen.kie).toHaveLength(0);
    expect(seen.or).toHaveLength(1);
    expect(seen.or[0]!.body.model).toBe('anthropic/claude-sonnet-5');
    await app.close();
  });

  it('KIE_CHAT_DISABLED=1 kill-switch covers the claude leg too', async () => {
    setKieEnv({ KIE_API_KEY: 'test-kie-key', KIE_CHAT_DISABLED: '1' });
    const script = await makeScript(userId);
    const { fetchImpl, seen } = mockLegs({
      or: () => sseOk(['Kill-switch OR.']),
    });
    const app = await buildApp(userId, fetchImpl);

    const res = await askMax(app, script.id);
    const frames = sseFrames(res.body);
    expect(frames[frames.length - 1]!.done).toBe(true);
    expect(seen.claude).toHaveLength(0);
    expect(seen.or).toHaveLength(1);
    await app.close();
  });

  it('kie claude empty stream (message_stop, zero text) → pre-token failure, OR serves', async () => {
    setKieEnv({ KIE_API_KEY: 'test-kie-key', KIE_CHAT_DISABLED: undefined });
    const script = await makeScript(userId);
    const { fetchImpl, seen } = mockLegs({
      claude: () => anthropicSseOk([]),
      or: () => sseOk(['Пустой kie.']),
    });
    const app = await buildApp(userId, fetchImpl);

    const res = await askMax(app, script.id);
    const frames = sseFrames(res.body);
    expect(frames.map((f) => f.delta ?? '').join('')).toContain('Пустой kie.');
    expect(frames[frames.length - 1]!.done).toBe(true);
    expect(seen.claude).toHaveLength(1);
    expect(seen.or).toHaveLength(1);
    await app.close();
  });
});

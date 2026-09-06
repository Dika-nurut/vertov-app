import 'dotenv/config';
import Fastify, { type FastifyInstance } from 'fastify';
import type IORedis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, like } from 'drizzle-orm';
import {
  db,
  nid,
  pool,
  boards,
  outboxJobs,
  projects,
  scripts,
  scriptAssistRequests,
  usersApp,
  usersPii,
} from '@seed/db';
import { creditService, CREDIT_COMMIT_QUEUE, CREDIT_REFUND_QUEUE } from '@seed/credits';
import {
  shotPlanSourceHash,
  SHOT_PLAN_BUDGET,
  SHOT_PLAN_CEILING_CREDITS,
  SHOT_PLAN_VERSION,
} from '@seed/shared/shot-plan';
import { setupShotPlanRoutes } from '../src/shot-plan';

/**
 * Integration tests for POST /v1/boards/:id/shot-plan (contract §3, §4, §6).
 * The gateway is ALWAYS mocked (live-spend discipline). What they pin down:
 * every pre-charge rejection, the DERIVED idempotency key (a free replay that
 * is re-validated against today's board), the three records one successful
 * batch writes, and the refund-before-terminal ordering the reaper depends on.
 */

const SCENE_TEXT = [
  'ИНТ. КВАРТИРА — НОЧЬ',
  '',
  'PUSH IN. Мария роняет ключи и замирает у двери.',
  '',
  'МАРИЯ',
  'Я не вернусь.',
].join('\n');

const createdUsers: string[] = [];

async function makeFundedUser(credits = 200): Promise<string> {
  const id = nid();
  await db.insert(usersApp).values({ id, displayName: 'ShotPlanTest', locale: 'ru' });
  await db.insert(usersPii).values({ id, email: `shot-plan+${id}@seed.local` });
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

async function makeScript(userId: string, projectId: string | null = null) {
  const [row] = await db
    .insert(scripts)
    .values({ id: nid(), userId, projectId, title: 'Тест', fountain: SCENE_TEXT })
    .returning();
  return row!;
}

async function makeProject(userId: string) {
  const id = nid();
  await db.insert(projects).values({ id, userId, title: 'Проект' });
  return id;
}

const sceneNode = (
  id: string,
  data: { sourceScriptId?: string; sourceHash?: string; sourceText?: string },
) => ({
  id,
  type: 'scene',
  position: { x: 0, y: 0 },
  data: {
    title: 'ИНТ. КВАРТИРА — НОЧЬ',
    sourceText: data.sourceText ?? SCENE_TEXT,
    ...(data.sourceScriptId ? { sourceScriptId: data.sourceScriptId } : {}),
    ...(data.sourceHash ? { sourceHash: data.sourceHash } : {}),
  },
});

const castNode = (id: string, castKind: 'character' | 'location', name: string) => ({
  id,
  type: 'cast',
  position: { x: 400, y: 0 },
  data: { castKind, name },
});

async function makeBoard(
  userId: string,
  input: { nodes: unknown[]; rev?: number; projectId?: string | null },
) {
  const id = nid();
  await db.insert(boards).values({
    id,
    userId,
    projectId: input.projectId ?? null,
    title: 'Доска',
    state: {
      schemaVersion: 1,
      nodes: input.nodes,
      edges: [],
      tray: [],
      __rev: input.rev ?? 0,
    },
  });
  return id;
}

/** OpenRouter non-streaming chat mock; returns `contents[callIndex]` (last repeats). */
function mockJsonGateway(opts: { contents?: string[]; status?: number; usages?: unknown[] } = {}) {
  const seen: { bodies: Record<string, unknown>[]; calls: number } = { bodies: [], calls: 0 };
  const contents = opts.contents ?? ['{}'];
  const fetchImpl: typeof fetch = async (_url, init) => {
    const call = seen.calls;
    seen.calls += 1;
    seen.bodies.push(JSON.parse(String(init?.body)));
    if (opts.status && opts.status !== 200) {
      return new Response('{"error":"boom"}', { status: opts.status });
    }
    const usage = opts.usages?.[Math.min(call, opts.usages.length - 1)] ?? {
      prompt_tokens: 1_200,
      completion_tokens: 400,
    };
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: contents[Math.min(call, contents.length - 1)]! } }],
        usage,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  return { fetchImpl, seen };
}

/** Minimal IORedis stand-in: rate limit + daily reserve always allow. */
function fakeSpendRedis() {
  const calls = { eval: 0, decrby: 0 };
  const redis = {
    eval: async () => {
      calls.eval += 1;
      return 1;
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
  options: Parameters<typeof setupShotPlanRoutes>[2] = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  setupShotPlanRoutes(app, async () => ({ user }), { fetchImpl, ...options });
  return app.ready().then(() => app);
}

const balanceOf = async (userId: string) => (await creditService.balanceFor(userId)).available;

const planFor = (
  sceneNodeId: string,
  refs: { castNodeIds?: string[]; locationNodeId?: string } = {},
) =>
  JSON.stringify({
    scenes: [
      {
        sceneNodeId,
        complete: true,
        shots: [
          {
            action: 'Мария роняет ключи и замирает',
            prompt: 'Средний план. Женщина у двери, ключи падают на пол.',
            castNodeIds: refs.castNodeIds ?? [],
            ...(refs.locationNodeId ? { locationNodeId: refs.locationNodeId } : {}),
            durationSeconds: 6,
            dialogue: 'Я не вернусь.',
            cue: 'PUSH IN',
          },
        ],
      },
    ],
  });

/** The key the server derives (§6) — no client ever supplies one. */
const derivedKey = (input: {
  boardId: string;
  scriptId: string;
  maxShotsPerScene: number;
  scenes: { id: string; hash: string }[];
}) => `shot_plan:${shotPlanSourceHash({ version: SHOT_PLAN_VERSION, ...input })}`;

let userId: string;

beforeAll(async () => {
  userId = await makeFundedUser();
});

afterAll(async () => {
  await db.delete(outboxJobs).where(like(outboxJobs.jobId, 'shot_plan-%'));
  for (const id of createdUsers) {
    await db.delete(boards).where(eq(boards.userId, id));
    await db.delete(scripts).where(eq(scripts.userId, id));
    await db.delete(projects).where(eq(projects.userId, id));
  }
  if (createdUsers.length) {
    await db.delete(usersPii).where(inArray(usersPii.id, createdUsers));
    await db.delete(usersApp).where(inArray(usersApp.id, createdUsers));
  }
  await pool.end();
});

describe('POST /v1/boards/:id/shot-plan — access checks (contract §3)', () => {
  it('anonymous session → 403 signup_required, no gateway call', async () => {
    const script = await makeScript(userId);
    const sceneId = nid();
    const boardId = await makeBoard(userId, {
      nodes: [sceneNode(sceneId, { sourceScriptId: script.id, sourceHash: 'h1' })],
    });
    const { fetchImpl, seen } = mockJsonGateway({ contents: [planFor(sceneId)] });
    const app = await buildApp({ id: userId, isAnonymous: true }, fetchImpl);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/boards/${boardId}/shot-plan`,
      payload: { boardRev: 0, sceneNodeIds: [sceneId], maxShotsPerScene: 6 },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('signup_required');
    expect(seen.calls).toBe(0);
    await app.close();
  });

  it("another user's board → 404 (never leaks that it exists)", async () => {
    const stranger = await makeFundedUser(0);
    const script = await makeScript(stranger);
    const sceneId = nid();
    const boardId = await makeBoard(stranger, {
      nodes: [sceneNode(sceneId, { sourceScriptId: script.id, sourceHash: 'h1' })],
    });
    const { fetchImpl, seen } = mockJsonGateway({ contents: [planFor(sceneId)] });
    const app = await buildApp({ id: userId }, fetchImpl);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/boards/${boardId}/shot-plan`,
      payload: { boardRev: 0, sceneNodeIds: [sceneId], maxShotsPerScene: 6 },
    });

    expect(res.statusCode).toBe(404);
    expect(seen.calls).toBe(0);
    await app.close();
  });

  it("a scene linked to another user's script → 404", async () => {
    const stranger = await makeFundedUser(0);
    const foreignScript = await makeScript(stranger);
    const sceneId = nid();
    const boardId = await makeBoard(userId, {
      nodes: [sceneNode(sceneId, { sourceScriptId: foreignScript.id, sourceHash: 'h1' })],
    });
    const { fetchImpl, seen } = mockJsonGateway({ contents: [planFor(sceneId)] });
    const app = await buildApp({ id: userId }, fetchImpl);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/boards/${boardId}/shot-plan`,
      payload: { boardRev: 0, sceneNodeIds: [sceneId], maxShotsPerScene: 6 },
    });

    expect(res.statusCode).toBe(404);
    expect(seen.calls).toBe(0);
    await app.close();
  });

  it("a board in a different project than the scene's script → 409 project_mismatch", async () => {
    const boardProject = await makeProject(userId);
    const scriptProject = await makeProject(userId);
    const script = await makeScript(userId, scriptProject);
    const sceneId = nid();
    const boardId = await makeBoard(userId, {
      projectId: boardProject,
      nodes: [sceneNode(sceneId, { sourceScriptId: script.id, sourceHash: 'h1' })],
    });
    const { fetchImpl, seen } = mockJsonGateway({ contents: [planFor(sceneId)] });
    const app = await buildApp({ id: userId }, fetchImpl);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/boards/${boardId}/shot-plan`,
      payload: { boardRev: 0, sceneNodeIds: [sceneId], maxShotsPerScene: 6 },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: 'project_mismatch',
      scriptProjectId: scriptProject,
      boardProjectId: boardProject,
    });
    expect(seen.calls).toBe(0);
    await app.close();
  });

  it('scenes from two different scripts in one batch → 400 mixed_scripts', async () => {
    const first = await makeScript(userId);
    const second = await makeScript(userId);
    const sceneA = nid();
    const sceneB = nid();
    const boardId = await makeBoard(userId, {
      nodes: [
        sceneNode(sceneA, { sourceScriptId: first.id, sourceHash: 'h1' }),
        sceneNode(sceneB, { sourceScriptId: second.id, sourceHash: 'h2' }),
      ],
    });
    const { fetchImpl, seen } = mockJsonGateway({ contents: [planFor(sceneA)] });
    const app = await buildApp({ id: userId }, fetchImpl);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/boards/${boardId}/shot-plan`,
      payload: { boardRev: 0, sceneNodeIds: [sceneA, sceneB], maxShotsPerScene: 6 },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('mixed_scripts');
    expect(seen.calls).toBe(0);
    await app.close();
  });

  it('a hand-made scene without sourceHash → 400 scene_not_linked (nothing to key it by)', async () => {
    const script = await makeScript(userId);
    const linked = nid();
    const handMade = nid();
    const boardId = await makeBoard(userId, {
      nodes: [
        sceneNode(linked, { sourceScriptId: script.id, sourceHash: 'h1' }),
        sceneNode(handMade, { sourceScriptId: script.id }), // no sourceHash
      ],
    });
    const { fetchImpl, seen } = mockJsonGateway({ contents: [planFor(linked)] });
    const app = await buildApp({ id: userId }, fetchImpl);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/boards/${boardId}/shot-plan`,
      payload: { boardRev: 0, sceneNodeIds: [linked, handMade], maxShotsPerScene: 6 },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'scene_not_linked', sceneNodeId: handMade });
    expect(seen.calls).toBe(0);
    await app.close();
  });

  it('a stale boardRev → 409 board_revision_conflict with the live revision', async () => {
    const script = await makeScript(userId);
    const sceneId = nid();
    const boardId = await makeBoard(userId, {
      rev: 41,
      nodes: [sceneNode(sceneId, { sourceScriptId: script.id, sourceHash: 'h1' })],
    });
    const { fetchImpl, seen } = mockJsonGateway({ contents: [planFor(sceneId)] });
    const app = await buildApp({ id: userId }, fetchImpl);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/boards/${boardId}/shot-plan`,
      payload: { boardRev: 40, sceneNodeIds: [sceneId], maxShotsPerScene: 6 },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'board_revision_conflict', rev: 41 });
    expect(seen.calls).toBe(0);
    await app.close();
  });

  it('a client-supplied idempotency key is rejected — the key is DERIVED (§6)', async () => {
    const script = await makeScript(userId);
    const sceneId = nid();
    const boardId = await makeBoard(userId, {
      nodes: [sceneNode(sceneId, { sourceScriptId: script.id, sourceHash: 'h1' })],
    });
    const { fetchImpl, seen } = mockJsonGateway({ contents: [planFor(sceneId)] });
    const app = await buildApp({ id: userId }, fetchImpl);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/boards/${boardId}/shot-plan`,
      payload: {
        boardRev: 0,
        sceneNodeIds: [sceneId],
        maxShotsPerScene: 6,
        idempotencyKey: 'client-chosen-key',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_body');
    expect(seen.calls).toBe(0);
    await app.close();
  });
});

describe('POST /v1/boards/:id/shot-plan — money (contract §4)', () => {
  it('success writes ONE transaction: the completed plan, the commit of what was spent, and the return of the rest', async () => {
    const planUser = await makeFundedUser();
    const script = await makeScript(planUser);
    const sceneId = nid();
    const characterId = nid();
    const locationId = nid();
    const boardId = await makeBoard(planUser, {
      nodes: [
        sceneNode(sceneId, { sourceScriptId: script.id, sourceHash: 'scene-hash-1' }),
        castNode(characterId, 'character', 'Мария'),
        castNode(locationId, 'location', 'Квартира'),
      ],
    });
    const { fetchImpl, seen } = mockJsonGateway({
      contents: [planFor(sceneId, { castNodeIds: [characterId], locationNodeId: locationId })],
      usages: [{ prompt_tokens: 1_200, completion_tokens: 400 }],
    });
    const app = await buildApp({ id: planUser }, fetchImpl);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/boards/${boardId}/shot-plan`,
      payload: { boardRev: 0, sceneNodeIds: [sceneId], maxShotsPerScene: 6 },
    });

    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.version).toBe(SHOT_PLAN_VERSION);
    expect(body.scenes[0].sceneNodeId).toBe(sceneId);
    expect(body.scenes[0].shots[0]).toMatchObject({
      castNodeIds: [characterId],
      locationNodeId: locationId,
      dialogue: 'Я не вернусь.',
      cue: 'PUSH IN',
      durationSeconds: 6,
    });
    // Settled on what the provider actually reported, far under the held ceiling.
    const spent = body.credits;
    expect(spent).toBeGreaterThanOrEqual(1);
    expect(spent).toBeLessThan(SHOT_PLAN_CEILING_CREDITS);

    // The prompt was assembled by the SERVER from the stored board.
    expect(seen.bodies[0]!.model).toBe('google/gemini-3-flash-preview');
    expect(seen.bodies[0]!.max_tokens).toBe(SHOT_PLAN_BUDGET.output);
    expect(seen.bodies[0]!.reasoning).toEqual({ enabled: false });
    const userMessage = String((seen.bodies[0]!.messages as { content: string }[])[1]!.content);
    expect(userMessage).toContain('Мария роняет ключи');
    expect(userMessage).toContain(characterId);
    expect(userMessage).toContain(locationId);

    const [row] = await db
      .select({
        status: scriptAssistRequests.status,
        amount: scriptAssistRequests.amount,
        jobId: scriptAssistRequests.jobId,
        result: scriptAssistRequests.result,
      })
      .from(scriptAssistRequests)
      .where(
        and(eq(scriptAssistRequests.userId, planUser), eq(scriptAssistRequests.op, 'shot_plan')),
      )
      .limit(1);
    expect(row!.status).toBe('completed');
    // `amount` keeps the RESERVED ceiling (recovery must return what was held);
    // what we charged lives inside the stored result.
    expect(row!.amount).toBe(SHOT_PLAN_CEILING_CREDITS);
    expect(row!.result).toMatchObject({ version: SHOT_PLAN_VERSION, creditsSpent: spent });

    const commits = await db
      .select({ payload: outboxJobs.payload })
      .from(outboxJobs)
      .where(eq(outboxJobs.queueName, CREDIT_COMMIT_QUEUE));
    const commit = commits.find((o) => (o.payload as { jobId?: string }).jobId === row!.jobId);
    expect(commit, 'a durable commit must be enqueued atomically with completion').toBeTruthy();
    expect(commit!.payload).toMatchObject({
      amount: spent,
      idempotencyKey: `shot_plan:${row!.jobId}:commit`,
    });

    const refunds = await db
      .select({ payload: outboxJobs.payload })
      .from(outboxJobs)
      .where(eq(outboxJobs.queueName, CREDIT_REFUND_QUEUE));
    const partial = refunds.find((o) => (o.payload as { jobId?: string }).jobId === row!.jobId);
    expect(partial, 'the unspent remainder must be returned in the same transaction').toBeTruthy();
    expect(partial!.payload).toMatchObject({
      amount: SHOT_PLAN_CEILING_CREDITS - spent,
      reason: 'shot.plan.unused',
      // A DIFFERENT key from the reaper's full `…:refund` — a partial return and
      // a full one must never settle as the same leg.
      idempotencyKey: `shot_plan:${row!.jobId}:refund-partial`,
    });
    await app.close();
  });

  it('refunds the hold BEFORE marking the request failed (the reaper only sweeps in_progress)', async () => {
    const orderUser = await makeFundedUser();
    const script = await makeScript(orderUser);
    const sceneId = nid();
    const boardId = await makeBoard(orderUser, {
      nodes: [sceneNode(sceneId, { sourceScriptId: script.id, sourceHash: 'h1' })],
    });
    const { fetchImpl } = mockJsonGateway({ status: 500 }); // provider fails → refund path
    const statusWhenRefunded: string[] = [];
    const orderedCredits = {
      reserve: creditService.reserve.bind(creditService),
      commit: creditService.commit.bind(creditService),
      refund: async (input: Parameters<typeof creditService.refund>[0]) => {
        const [row] = await db
          .select({ status: scriptAssistRequests.status })
          .from(scriptAssistRequests)
          .where(
            and(
              eq(scriptAssistRequests.userId, orderUser),
              eq(scriptAssistRequests.op, 'shot_plan'),
            ),
          )
          .limit(1);
        statusWhenRefunded.push(row!.status);
        return creditService.refund(input);
      },
    };
    const app = await buildApp({ id: orderUser }, fetchImpl, { credits: orderedCredits });
    const before = await balanceOf(orderUser);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/boards/${boardId}/shot-plan`,
      payload: { boardRev: 0, sceneNodeIds: [sceneId], maxShotsPerScene: 6 },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('shot_plan_failed');
    // The row was still in_progress when the refund ran: had we marked it failed
    // first and then failed to refund, the hold would be beyond every recovery.
    expect(statusWhenRefunded).toEqual(['in_progress']);
    const [row] = await db
      .select({ status: scriptAssistRequests.status })
      .from(scriptAssistRequests)
      .where(
        and(eq(scriptAssistRequests.userId, orderUser), eq(scriptAssistRequests.op, 'shot_plan')),
      )
      .limit(1);
    expect(row!.status).toBe('failed');
    expect(await balanceOf(orderUser)).toBe(before); // fully refunded
    await app.close();
  });

  it('total settlement outage leaves the claim in_progress with its jobId, for the reaper', async () => {
    // Isolated user: this deliberately strands an in_progress claim (the point).
    const outageUser = await makeFundedUser();
    const script = await makeScript(outageUser);
    const sceneId = nid();
    const boardId = await makeBoard(outageUser, {
      nodes: [sceneNode(sceneId, { sourceScriptId: script.id, sourceHash: 'h1' })],
    });
    const { fetchImpl } = mockJsonGateway({ status: 500 });
    const app = await buildApp({ id: outageUser }, fetchImpl, {
      credits: {
        reserve: creditService.reserve.bind(creditService),
        commit: creditService.commit.bind(creditService),
        refund: async () => {
          throw new Error('refund down');
        },
      },
      enqueueRefund: async () => {
        throw new Error('outbox down');
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/boards/${boardId}/shot-plan`,
      payload: { boardRev: 0, sceneNodeIds: [sceneId], maxShotsPerScene: 6 },
    });

    expect(res.statusCode).toBe(500);
    const [row] = await db
      .select({ status: scriptAssistRequests.status, jobId: scriptAssistRequests.jobId })
      .from(scriptAssistRequests)
      .where(
        and(eq(scriptAssistRequests.userId, outageUser), eq(scriptAssistRequests.op, 'shot_plan')),
      )
      .limit(1);
    expect(row!.status).toBe('in_progress');
    expect(row!.jobId).toBeTruthy();
    await app.close();
  });

  it('keeps the daily platform reservation when the provider burned tokens', async () => {
    const capUser = await makeFundedUser();
    const script = await makeScript(capUser);
    const sceneId = nid();
    const boardId = await makeBoard(capUser, {
      nodes: [sceneNode(sceneId, { sourceScriptId: script.id, sourceHash: 'h1' })],
    });
    const { fetchImpl } = mockJsonGateway({ contents: ['не json, просто болтовня'] });
    const { redis, calls } = fakeSpendRedis();
    const app = await buildApp({ id: capUser }, fetchImpl, { spend: { redis, cap: 1_000_000 } });
    const before = await balanceOf(capUser);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/boards/${boardId}/shot-plan`,
      payload: { boardRev: 0, sceneNodeIds: [sceneId], maxShotsPerScene: 6 },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('shot_plan_unusable');
    expect(calls.eval).toBeGreaterThan(0); // reserved against the daily cap
    expect(calls.decrby).toBe(0); // those attempts burned tokens — never released
    expect(await balanceOf(capUser)).toBe(before); // the USER is still made whole
    await app.close();
  });
});

describe('POST /v1/boards/:id/shot-plan — idempotency (contract §6)', () => {
  it('the derived key makes an identical request a free replay — no provider call, no second charge', async () => {
    const replayUser = await makeFundedUser();
    const script = await makeScript(replayUser);
    const sceneId = nid();
    const boardId = await makeBoard(replayUser, {
      nodes: [sceneNode(sceneId, { sourceScriptId: script.id, sourceHash: 'scene-hash-1' })],
    });
    const first = mockJsonGateway({ contents: [planFor(sceneId)] });
    const app1 = await buildApp({ id: replayUser }, first.fetchImpl);
    const before = await balanceOf(replayUser);

    const res1 = await app1.inject({
      method: 'POST',
      url: `/v1/boards/${boardId}/shot-plan`,
      payload: { boardRev: 0, sceneNodeIds: [sceneId], maxShotsPerScene: 6 },
    });
    expect(res1.statusCode, res1.body).toBe(200);
    await app1.close();

    const second = mockJsonGateway({ contents: [planFor(sceneId)] });
    const app2 = await buildApp({ id: replayUser }, second.fetchImpl);
    const res2 = await app2.inject({
      method: 'POST',
      url: `/v1/boards/${boardId}/shot-plan`,
      payload: { boardRev: 0, sceneNodeIds: [sceneId], maxShotsPerScene: 6 },
    });

    expect(res2.statusCode).toBe(200);
    expect(second.seen.calls).toBe(0); // the plan came from the stored result
    expect(res2.json().scenes).toEqual(res1.json().scenes);
    expect(res2.json().credits).toBe(res1.json().credits); // what was ACTUALLY charged
    // The hold was reserved once; only the first request settled it.
    expect(await balanceOf(replayUser)).toBe(before - SHOT_PLAN_CEILING_CREDITS);
    await app2.close();
  });

  it('a replay drops a cast id that has since changed castKind (wiring is re-checked, not trusted)', async () => {
    const roleUser = await makeFundedUser();
    const script = await makeScript(roleUser);
    const sceneId = nid();
    const castId = nid();
    const boardId = await makeBoard(roleUser, {
      nodes: [
        sceneNode(sceneId, { sourceScriptId: script.id, sourceHash: 'scene-hash-1' }),
        castNode(castId, 'character', 'Мария'),
      ],
    });
    const first = mockJsonGateway({ contents: [planFor(sceneId, { castNodeIds: [castId] })] });
    const app1 = await buildApp({ id: roleUser }, first.fetchImpl);
    const res1 = await app1.inject({
      method: 'POST',
      url: `/v1/boards/${boardId}/shot-plan`,
      payload: { boardRev: 0, sceneNodeIds: [sceneId], maxShotsPerScene: 6 },
    });
    expect(res1.statusCode, res1.body).toBe(200);
    expect(res1.json().scenes[0].shots[0].castNodeIds).toEqual([castId]);
    await app1.close();

    // The author turned that module into a LOCATION. Replaying the paid plan as
    // stored would wire a location pack into a character slot.
    await db
      .update(boards)
      .set({
        state: {
          schemaVersion: 1,
          nodes: [
            sceneNode(sceneId, { sourceScriptId: script.id, sourceHash: 'scene-hash-1' }),
            castNode(castId, 'location', 'Мария'),
          ],
          edges: [],
          tray: [],
          __rev: 0,
        },
      })
      .where(eq(boards.id, boardId));

    const second = mockJsonGateway({ contents: [planFor(sceneId, { castNodeIds: [castId] })] });
    const app2 = await buildApp({ id: roleUser }, second.fetchImpl);
    const res2 = await app2.inject({
      method: 'POST',
      url: `/v1/boards/${boardId}/shot-plan`,
      payload: { boardRev: 0, sceneNodeIds: [sceneId], maxShotsPerScene: 6 },
    });

    expect(res2.statusCode).toBe(200);
    expect(second.seen.calls).toBe(0); // still a free replay
    expect(res2.json().scenes[0].shots[0].castNodeIds).toEqual([]); // the stale wiring is gone
    await app2.close();
  });

  it('a completed claim whose result is unreadable is quarantined, never replayed or re-run', async () => {
    const auditUser = await makeFundedUser();
    const script = await makeScript(auditUser);
    const sceneId = nid();
    const boardId = await makeBoard(auditUser, {
      nodes: [sceneNode(sceneId, { sourceScriptId: script.id, sourceHash: 'scene-hash-1' })],
    });
    // A settled row whose result is missing: the charge already happened and we
    // cannot tell what it was. Neither replaying nor re-charging is honest.
    const key = derivedKey({
      boardId,
      scriptId: script.id,
      maxShotsPerScene: 6,
      scenes: [{ id: sceneId, hash: 'scene-hash-1' }],
    });
    const quarantinedId = nid();
    await db.insert(scriptAssistRequests).values({
      id: quarantinedId,
      scriptId: script.id,
      userId: auditUser,
      idempotencyKey: key,
      jobId: nid(),
      sourceHash: key.slice('shot_plan:'.length),
      op: 'shot_plan',
      amount: SHOT_PLAN_CEILING_CREDITS,
      reserved: true,
      status: 'completed',
      result: null,
    });

    const { fetchImpl, seen } = mockJsonGateway({ contents: [planFor(sceneId)] });
    const app = await buildApp({ id: auditUser }, fetchImpl);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/boards/${boardId}/shot-plan`,
      payload: { boardRev: 0, sceneNodeIds: [sceneId], maxShotsPerScene: 6 },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('shot_plan_unreconcilable');
    expect(seen.calls).toBe(0); // never re-run: that would charge blind
    const [row] = await db
      .select({ status: scriptAssistRequests.status })
      .from(scriptAssistRequests)
      .where(eq(scriptAssistRequests.id, quarantinedId))
      .limit(1);
    expect(row, 'the row is kept for manual reconciliation, never deleted').toBeTruthy();
    expect(row!.status).toBe('completed');
    await app.close();
  });

  it('a crashed in-flight batch is reclaimed (and its hold refunded) so the next batch is not blocked forever', async () => {
    const staleUser = await makeFundedUser();
    const script = await makeScript(staleUser);
    const sceneId = nid();
    const boardId = await makeBoard(staleUser, {
      nodes: [sceneNode(sceneId, { sourceScriptId: script.id, sourceHash: 'scene-hash-1' })],
    });
    const staleJobId = nid();
    await db.insert(scriptAssistRequests).values({
      id: nid(),
      scriptId: script.id,
      userId: staleUser,
      idempotencyKey: `shot_plan:stale-${nid()}`,
      jobId: staleJobId,
      op: 'shot_plan',
      amount: SHOT_PLAN_CEILING_CREDITS,
      reserved: true,
      status: 'in_progress',
      createdAt: new Date(Date.now() - 20 * 60 * 1000),
      updatedAt: new Date(Date.now() - 20 * 60 * 1000),
    });

    const { fetchImpl } = mockJsonGateway({ contents: [planFor(sceneId)] });
    const app = await buildApp({ id: staleUser }, fetchImpl);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/boards/${boardId}/shot-plan`,
      payload: { boardRev: 0, sceneNodeIds: [sceneId], maxShotsPerScene: 6 },
    });

    expect(res.statusCode, res.body).toBe(200);
    const gone = await db
      .select({ id: scriptAssistRequests.id })
      .from(scriptAssistRequests)
      .where(eq(scriptAssistRequests.jobId, staleJobId));
    expect(gone).toHaveLength(0);
    const refunds = await db
      .select({ payload: outboxJobs.payload })
      .from(outboxJobs)
      .where(eq(outboxJobs.queueName, CREDIT_REFUND_QUEUE));
    const stranded = refunds.find((o) => (o.payload as { jobId?: string }).jobId === staleJobId);
    expect(stranded, 'the crashed hold must be handed to a durable refund').toBeTruthy();
    expect(stranded!.payload).toMatchObject({
      amount: SHOT_PLAN_CEILING_CREDITS,
      idempotencyKey: `shot_plan:${staleJobId}:refund`,
    });
    await app.close();
  });
});

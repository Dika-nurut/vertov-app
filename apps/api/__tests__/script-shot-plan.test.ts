import 'dotenv/config';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, like } from 'drizzle-orm';
import {
  db,
  nid,
  outboxJobs,
  pool,
  scriptAssistRequests,
  scriptSceneTimings,
  scriptShotPlans,
  scripts,
  usersApp,
  usersPii,
} from '@seed/db';
import { creditService } from '@seed/credits';
import {
  SCENARIO_SHOT_PLAN_CREDITS,
  SCENARIO_SHOT_PLAN_VERSION,
} from '@seed/shared/scenario-shot-plan';
import { setupScriptShotPlanRoutes } from '../src/script-shot-plan';
import {
  scenarioTimingSourceRevisionId,
  SCENARIO_TIMING_POLICY_VERSION,
} from '../src/scenario-timing';

const SOURCE = ['ИНТ. КВАРТИРА — НОЧЬ', '', 'Мария открывает дверь и видит пустую комнату.'].join(
  '\n',
);
const createdUsers: string[] = [];

async function makeUser(credits = 40): Promise<string> {
  const id = nid();
  await db.insert(usersApp).values({ id, displayName: 'ScenarioShotPlanTest', locale: 'ru' });
  await db.insert(usersPii).values({ id, email: `scenario-shot-plan+${id}@seed.local` });
  if (credits > 0) {
    await creditService.grant({
      userId: id,
      amount: credits,
      reason: 'test.grant',
      idempotencyKey: `scenario-shot-plan:test:${id}`,
      account: 'pack_grant',
    });
  }
  createdUsers.push(id);
  return id;
}

async function makeScript(userId: string, durationSeconds = 12) {
  const [script] = await db
    .insert(scripts)
    .values({ id: nid(), userId, title: 'Тестовый shot plan', fountain: SOURCE })
    .returning();
  const sourceUnitId = 'scene:1';
  await db.insert(scriptSceneTimings).values({
    id: nid(),
    scriptId: script!.id,
    sourceUnitId,
    durationSeconds,
    owner: 'user',
    sourceRevisionId: scenarioTimingSourceRevisionId(SOURCE),
    estimatorPolicyVersion: SCENARIO_TIMING_POLICY_VERSION,
  });
  return script!;
}

function gateway(content: string) {
  const state = { calls: 0 };
  const fetchImpl: typeof fetch = async () => {
    state.calls += 1;
    return new Response(
      JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 900, completion_tokens: 300 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  return { fetchImpl, state };
}

function validPlan() {
  return JSON.stringify({
    sceneId: 'scene:1',
    shots: [
      {
        order: 1,
        title: 'Дверь открывается',
        durationSec: 6,
        dramaticBeat: 'Мария ожидает ответ и не получает его.',
        promptDraft: 'Средний план: Мария открывает дверь в пустую комнату.',
        shotGrammar: { size: 'medium', move: 'static', lens: '50mm' },
        requiredLocks: [],
        unresolvedAssets: [],
      },
      {
        order: 2,
        title: 'Пустота за дверью',
        durationSec: 6,
        dramaticBeat: 'Ожидание превращается в тревогу.',
        promptDraft: 'Медленный наезд на пустую комнату, ночной контрастный свет.',
        requiredLocks: [],
        unresolvedAssets: [],
      },
    ],
  });
}

function badPlan() {
  return JSON.stringify({
    sceneId: 'scene:1',
    shots: [
      {
        order: 1,
        title: 'Вся сцена одним кадром',
        durationSec: 12,
        dramaticBeat: 'Слишком общая декомпозиция.',
        promptDraft: 'Один общий кадр всей сцены.',
        requiredLocks: [],
        unresolvedAssets: [],
      },
    ],
  });
}

async function buildApp(
  user: { id: string; isAnonymous?: boolean },
  fetchImpl: typeof fetch,
  options: Parameters<typeof setupScriptShotPlanRoutes>[2] = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  setupScriptShotPlanRoutes(app, async () => ({ user }), { fetchImpl, ...options });
  await app.ready();
  return app;
}

describe('Scenario shot planner M3', () => {
  let userId: string;

  beforeAll(async () => {
    userId = await makeUser();
  });

  afterAll(async () => {
    await db.delete(outboxJobs).where(like(outboxJobs.jobId, 'scenario_shot_plan-%'));
    for (const id of createdUsers) {
      await db.delete(scripts).where(eq(scripts.userId, id));
      await db.delete(usersPii).where(eq(usersPii.id, id));
      await db.delete(usersApp).where(eq(usersApp.id, id));
    }
    await pool.end();
  });

  it('anonymous request is signup-gated before provider context or calls', async () => {
    const script = await makeScript(userId);
    const { fetchImpl, state } = gateway(validPlan());
    const app = await buildApp({ id: userId, isAnonymous: true }, fetchImpl);

    const response = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/scenes/scene%3A1/shot-plan`,
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'signup_required' });
    expect(state.calls).toBe(0);
    await app.close();
  });

  it('requires current author-approved timing', async () => {
    const [script] = await db
      .insert(scripts)
      .values({ id: nid(), userId, title: 'Без timing', fountain: SOURCE })
      .returning();
    const { fetchImpl, state } = gateway(validPlan());
    const app = await buildApp({ id: userId }, fetchImpl);

    const response = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script!.id}/scenes/scene%3A1/shot-plan`,
      payload: {},
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('scene_timing_required');
    expect(state.calls).toBe(0);
    await app.close();
  });

  it('persists a normalized paid plan and replays it from cache with zero calls', async () => {
    const script = await makeScript(userId);
    const { fetchImpl, state } = gateway(validPlan());
    const app = await buildApp({ id: userId }, fetchImpl);
    const url = `/v1/scripts/${script.id}/scenes/scene%3A1/shot-plan`;

    const first = await app.inject({ method: 'POST', url, payload: {} });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      cacheHit: false,
      credits: SCENARIO_SHOT_PLAN_CREDITS,
      plan: {
        version: SCENARIO_SHOT_PLAN_VERSION,
        sceneId: 'scene:1',
        targetDurationSeconds: 12,
      },
    });
    expect(
      first.json().plan.shots.map((shot: { durationSec: number }) => shot.durationSec),
    ).toEqual([6, 6]);
    expect(state.calls).toBe(1);

    const second = await app.inject({ method: 'POST', url, payload: {} });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ cacheHit: true, credits: 0, cachedCredits: 4 });
    expect(state.calls).toBe(1);

    const rows = await db
      .select()
      .from(scriptShotPlans)
      .where(
        and(eq(scriptShotPlans.scriptId, script.id), eq(scriptShotPlans.sourceSceneId, 'scene:1')),
      );
    expect(rows).toHaveLength(1);
    await app.close();
  });

  it('refunds forced bad duration output and persists no plan', async () => {
    const badUserId = await makeUser();
    const script = await makeScript(badUserId);
    const { fetchImpl, state } = gateway(badPlan());
    const app = await buildApp({ id: badUserId }, fetchImpl);

    const response = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/scenes/scene%3A1/shot-plan`,
      payload: {},
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe('shot_plan_unusable');
    expect(state.calls).toBe(2);
    const plans = await db
      .select()
      .from(scriptShotPlans)
      .where(eq(scriptShotPlans.scriptId, script.id));
    expect(plans).toHaveLength(0);
    const claims = await db
      .select()
      .from(scriptAssistRequests)
      .where(
        and(
          eq(scriptAssistRequests.scriptId, script.id),
          eq(scriptAssistRequests.op, 'scenario_shot_plan'),
        ),
      );
    expect(claims[0]?.status).toBe('failed');
    expect((await creditService.balanceFor(badUserId)).pending).toBe(0);
    await app.close();
  });
});

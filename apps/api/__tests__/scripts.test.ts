import 'dotenv/config';
import Fastify, { type FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import {
  db,
  nid,
  pool,
  boards,
  scripts,
  scriptMaterials,
  scriptSnapshots,
  scriptSceneTimings,
  scriptShotPlans,
  scriptThreadMessages,
  scriptThreads,
  usersApp,
  usersPii,
} from '@seed/db';
import { MATERIAL_SUMMARY_MIN_RAW_CHARS } from '@seed/shared';
import {
  SCENARIO_SHOT_PLAN_CREDITS,
  SCENARIO_SHOT_PLAN_MODEL,
  SCENARIO_SHOT_PLAN_VERSION,
} from '@seed/shared/scenario-shot-plan';
import { setupScriptRoutes, type ScriptRoutesOptions } from '../src/scripts';
import { scenarioTimingSourceRevisionId } from '../src/scenario-timing';

const RU_FOUNTAIN = readFileSync(
  new URL('../../../packages/screenplay/fixtures/fountain/ru-sample.fountain', import.meta.url),
  'utf-8',
);
const SAMPLE_FDX = readFileSync(
  new URL('../../../packages/screenplay/fixtures/fdx/sample.fdx', import.meta.url),
  'utf-8',
);

const createdUsers: string[] = [];
const createdScripts: string[] = [];
const createdBoards: string[] = [];

async function makeUser(): Promise<string> {
  const id = nid();
  await db.insert(usersApp).values({ id, displayName: 'ScriptTest', locale: 'ru' });
  await db.insert(usersPii).values({ id, email: `script-test+${id}@seed.local` });
  createdUsers.push(id);
  return id;
}

function buildApp(userId: string, options: ScriptRoutesOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: 52_428_800 },
    (_req, body, done) => done(null, body),
  );
  setupScriptRoutes(app, async () => ({ user: { id: userId } }), options);
  return app.ready().then(() => app);
}

let owner: string;
let intruder: string;
let app: FastifyInstance;
let intruderApp: FastifyInstance;

async function createScript(fountain = RU_FOUNTAIN, title = 'Последний сеанс') {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/scripts',
    payload: { title, fountain },
  });
  expect(res.statusCode).toBe(201);
  const row = res.json();
  createdScripts.push(row.id);
  return row as { id: string; rev: number; fountain: string; title: string };
}

beforeAll(async () => {
  owner = await makeUser();
  intruder = await makeUser();
  app = await buildApp(owner);
  intruderApp = await buildApp(intruder);
});

afterAll(async () => {
  await app.close();
  await intruderApp.close();
  if (createdBoards.length) {
    await db.delete(boards).where(inArray(boards.id, createdBoards));
  }
  if (createdScripts.length) {
    await db.delete(scripts).where(inArray(scripts.id, createdScripts));
  }
  if (createdUsers.length) {
    await db.delete(usersPii).where(inArray(usersPii.id, createdUsers));
    await db.delete(usersApp).where(inArray(usersApp.id, createdUsers));
  }
  await pool.end();
});

describe('Boards pulls scenes from Scenario', () => {
  const scene = (ordinal: number, action = `Действие сцены ${ordinal}.`) =>
    `ИНТ. ЛОКАЦИЯ ${ordinal} - ДЕНЬ\n= Синопсис ${ordinal}.\n\n${action}\n`;

  it('previews and transfers naturally typed scenes followed directly by action', async () => {
    const script = await createScript(
      'ИНТ. КВАРТИРА — ДЕНЬ\nМаша смотрит в окно.\n\nНАТ. ДВОР — ВЕЧЕР\nМаша выходит из дома.\n',
      'Две сцены',
    );

    const preview = await app.inject({
      method: 'GET',
      url: `/v1/scripts/${script.id}/board-handoff`,
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().scenes).toEqual([
      {
        ordinal: 1,
        heading: 'ИНТ. КВАРТИРА — ДЕНЬ',
        synopsis: 'Маша смотрит в окно.',
      },
      {
        ordinal: 2,
        heading: 'НАТ. ДВОР — ВЕЧЕР',
        synopsis: 'Маша выходит из дома.',
      },
    ]);

    const transferred = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/board-handoff`,
      payload: { ordinals: [1, 2], destination: 'new', fullSync: true },
    });
    expect(transferred.statusCode).toBe(201);
    createdBoards.push(transferred.json().boardId);
    expect(transferred.json()).toMatchObject({ added: 2 });
    const [board] = await db.select().from(boards).where(eq(boards.id, transferred.json().boardId));
    const state = board!.state as {
      nodes: Array<{ type: string; data: { sourceOrdinal: number; title: string } }>;
    };
    expect(
      state.nodes
        .filter((node) => node.type === 'scene')
        .map((node) => ({
          ordinal: node.data.sourceOrdinal,
          heading: node.data.title,
        })),
    ).toEqual([
      { ordinal: 1, heading: 'ИНТ. КВАРТИРА — ДЕНЬ' },
      { ordinal: 2, heading: 'НАТ. ДВОР — ВЕЧЕР' },
    ]);
  });

  it('lets an existing Board pull selected scenes from a Scenario', async () => {
    const script = await createScript([scene(1), scene(2), scene(3)].join('\n'), 'Источник');
    const boardId = nid();
    createdBoards.push(boardId);
    await db.insert(boards).values({
      id: boardId,
      userId: owner,
      title: 'Текущая доска',
      state: {
        schemaVersion: 1,
        nodes: [],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
        tray: [],
        __rev: 0,
      },
    });

    const pulled = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/board-handoff`,
      payload: { ordinals: [1, 3], destination: 'board', boardId, fullSync: false },
    });
    expect(pulled.statusCode).toBe(200);
    expect(pulled.json()).toMatchObject({
      boardId,
      created: false,
      added: 2,
      state: { __rev: 1 },
    });
    expect(
      pulled
        .json()
        .state.nodes.filter((node: { type: string }) => node.type === 'scene')
        .map((node: { data: { sourceOrdinal: number } }) => node.data.sourceOrdinal),
    ).toEqual([1, 3]);
  });

  it('creates and safely re-syncs a linked Board without overwriting user work', async () => {
    const original = [scene(1), scene(2), scene(3)].join('\n');
    const script = await createScript(original, 'Три сцены');

    const preview = await app.inject({
      method: 'GET',
      url: `/v1/scripts/${script.id}/board-handoff`,
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().scenes).toHaveLength(3);
    expect(preview.json().linkedBoards).toEqual([]);

    const created = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/board-handoff`,
      payload: { ordinals: [1, 2, 3], destination: 'new', fullSync: true },
    });
    expect(created.statusCode).toBe(201);
    const boardId = created.json().boardId as string;
    createdBoards.push(boardId);

    const [initialBoard] = await db.select().from(boards).where(eq(boards.id, boardId));
    const initialState = initialBoard!.state as {
      nodes: Array<
        Record<string, unknown> & { id: string; type: string; data: Record<string, unknown> }
      >;
      __rev: number;
    };
    expect(initialState.nodes.filter((node) => node.type === 'scene')).toHaveLength(3);
    const scene2 = initialState.nodes.find(
      (node) => node.type === 'scene' && node.data.sourceOrdinal === 2,
    )!;
    const userNote = {
      id: nid(),
      type: 'note',
      version: 1,
      position: { x: 900, y: 400 },
      data: { text: 'Режиссёрская заметка' },
    };
    await db
      .update(boards)
      .set({ state: { ...initialState, nodes: [...initialState.nodes, userNote], __rev: 1 } })
      .where(eq(boards.id, boardId));

    const changed = [scene(1), scene(2, 'Новое действие второй сцены.')].join('\n');
    const saved = await app.inject({
      method: 'PUT',
      url: `/v1/scripts/${script.id}`,
      payload: { fountain: changed, baseRev: 0 },
    });
    expect(saved.statusCode).toBe(200);

    const synced = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/board-handoff`,
      payload: { ordinals: [1, 2], destination: 'linked', boardId, fullSync: true },
    });
    expect(synced.statusCode).toBe(200);
    expect(synced.json()).toMatchObject({ created: false, updated: 2, removed: 1 });

    const [updatedBoard] = await db.select().from(boards).where(eq(boards.id, boardId));
    const updatedState = updatedBoard!.state as typeof initialState;
    expect(updatedState.nodes.find((node) => node.id === userNote.id)?.data).toEqual({
      text: 'Режиссёрская заметка',
    });
    expect(updatedState.nodes.find((node) => node.id === scene2.id)).toMatchObject({
      id: scene2.id,
      position: scene2.position,
      data: { sourceText: expect.stringContaining('Новое действие второй сцены.') },
    });
    expect(
      updatedState.nodes.find((node) => node.type === 'scene' && node.data.sourceOrdinal === 3)
        ?.data.sourceStatus,
    ).toBe('removed');
  });

  it('reports and protects an ambiguous linked scene re-sync', async () => {
    const script = await createScript(scene(1), 'Неоднозначная сцена');
    const created = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/board-handoff`,
      payload: { ordinals: [1], destination: 'new', fullSync: true },
    });
    expect(created.statusCode).toBe(201);
    const boardId = created.json().boardId as string;
    createdBoards.push(boardId);

    const [board] = await db.select().from(boards).where(eq(boards.id, boardId));
    const initialState = board!.state as {
      __rev: number;
      nodes: Array<
        Record<string, unknown> & { id: string; type: string; data: Record<string, unknown> }
      >;
    };
    const linkedScene = initialState.nodes.find((node) => node.type === 'scene')!;
    await db
      .update(boards)
      .set({
        state: {
          ...initialState,
          __rev: initialState.__rev + 1,
          nodes: [
            ...initialState.nodes,
            {
              ...linkedScene,
              id: nid(),
              data: { ...linkedScene.data, sourceSceneId: 'duplicate-local-source' },
            },
          ],
        },
      })
      .where(eq(boards.id, boardId));

    const saved = await app.inject({
      method: 'PUT',
      url: `/v1/scripts/${script.id}`,
      payload: { fountain: scene(1, 'Изменённое действие.'), baseRev: script.rev },
    });
    expect(saved.statusCode).toBe(200);

    const synced = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/board-handoff`,
      payload: { ordinals: [1], destination: 'linked', boardId, fullSync: true },
    });
    expect(synced.statusCode).toBe(200);
    expect(synced.json()).toMatchObject({
      added: 0,
      updated: 0,
      removed: 0,
      skipped: 1,
    });
    expect(
      synced.json().state.nodes.filter((node: { type: string }) => node.type === 'scene'),
    ).toHaveLength(2);
    expect(
      synced
        .json()
        .state.nodes.every(
          (node: { type: string; data: { sourceStatus?: string } }) =>
            node.type !== 'scene' || node.data.sourceStatus === 'current',
        ),
    ).toBe(true);
  });

  it('handles a 20-scene screenplay and keeps the handoff private', async () => {
    const script = await createScript(
      Array.from({ length: 20 }, (_, index) => scene(index + 1)).join('\n'),
      'Двадцать сцен',
    );
    const preview = await app.inject({
      method: 'GET',
      url: `/v1/scripts/${script.id}/board-handoff`,
    });
    expect(preview.json().scenes).toHaveLength(20);

    const foreignPreview = await intruderApp.inject({
      method: 'GET',
      url: `/v1/scripts/${script.id}/board-handoff`,
    });
    const foreignCreate = await intruderApp.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/board-handoff`,
      payload: { ordinals: [1], destination: 'new', fullSync: false },
    });
    expect(foreignPreview.statusCode).toBe(404);
    expect(foreignCreate.statusCode).toBe(404);
  });

  it('creates Board sources from non-Film beats without generation calls', async () => {
    const script = await createScript('', 'Ролик');
    const outline = {
      version: 1,
      beats: [
        { id: 'hook', kind: 'hook', title: 'Стоп-кадр', summary: 'Герой замечает ошибку.' },
        { id: 'cta', kind: 'cta', title: 'Финальный призыв', summary: 'Открыть проект.' },
      ],
    };
    const saved = await app.inject({
      method: 'PUT',
      url: `/v1/scripts/${script.id}`,
      payload: { format: 'social', outline, baseRev: 0 },
    });
    expect(saved.statusCode).toBe(200);

    const preview = await app.inject({
      method: 'GET',
      url: `/v1/scripts/${script.id}/board-handoff`,
    });
    expect(preview.json().scenes).toEqual([
      { ordinal: 1, heading: 'Стоп-кадр', synopsis: 'Герой замечает ошибку.' },
      { ordinal: 2, heading: 'Финальный призыв', synopsis: 'Открыть проект.' },
    ]);

    const created = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/board-handoff`,
      payload: { ordinals: [1, 2], destination: 'new', fullSync: true },
    });
    expect(created.statusCode).toBe(201);
    createdBoards.push(created.json().boardId);
    const [board] = await db.select().from(boards).where(eq(boards.id, created.json().boardId));
    expect(board!.state).toMatchObject({
      nodes: [
        { type: 'scene', data: { sourceSceneId: 'hook', sourceOrdinal: 1 } },
        { type: 'scene', data: { sourceSceneId: 'cta', sourceOrdinal: 2 } },
      ],
    });
  });

  it('materializes a stored selected-scene plan into prompt → generate + unresolved cast nodes', async () => {
    const source = scene(1).trimEnd();
    const script = await createScript(`${source}\n`, 'План кадров');
    const timing = await app.inject({
      method: 'PUT',
      url: `/v1/scripts/` + script.id + `/scene-timings/scene:1`,
      payload: { durationSeconds: 12 },
    });
    expect(timing.statusCode).toBe(200);
    const plan = {
      version: SCENARIO_SHOT_PLAN_VERSION,
      sceneId: 'scene:1',
      targetDurationSeconds: 12,
      shots: [
        {
          order: 1,
          title: 'Ключ поворачивается',
          durationSec: 6,
          dramaticBeat: 'Герой решается открыть дверь.',
          promptDraft: 'Крупный план ключа в замке, рука замирает перед поворотом.',
          shotGrammar: { size: 'close', move: 'static' },
          requiredLocks: [],
          unresolvedAssets: [],
        },
        {
          order: 2,
          title: 'Пустая комната',
          durationSec: 6,
          dramaticBeat: 'Ожидание превращается в тревогу.',
          promptDraft: 'Медленный наезд в пустую ночную комнату после открытия двери.',
          requiredLocks: [],
          unresolvedAssets: ['неуказанный герой'],
        },
      ],
    };
    await db.insert(scriptShotPlans).values({
      id: nid(),
      scriptId: script.id,
      sourceSceneId: 'scene:1',
      sourceHash: scenarioTimingSourceRevisionId(source),
      targetDurationSeconds: 12,
      policyVersion: SCENARIO_SHOT_PLAN_VERSION,
      modelId: SCENARIO_SHOT_PLAN_MODEL,
      plan,
      creditsSpent: SCENARIO_SHOT_PLAN_CREDITS,
    });

    const created = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/board-handoff`,
      payload: { ordinals: [1], destination: 'new', fullSync: true },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      materializedShots: 2,
      materializedCastNodes: 1,
    });
    const boardId = created.json().boardId as string;
    createdBoards.push(boardId);
    const [board] = await db.select().from(boards).where(eq(boards.id, boardId));
    const state = board!.state as {
      nodes: Array<{ id: string; type: string; data: Record<string, unknown> }>;
      edges: Array<{ source: string; target: string; targetHandle?: string }>;
    };
    expect(state.nodes.filter((node) => node.type === 'scene')).toHaveLength(1);
    expect(state.nodes.filter((node) => node.type === 'prompt')).toHaveLength(2);
    expect(state.nodes.filter((node) => node.type === 'generate')).toHaveLength(2);
    expect(state.nodes.filter((node) => node.type === 'cast')).toMatchObject([
      { data: { name: 'неуказанный герой', imageUrls: [] } },
    ]);
    expect(state.edges.filter((edge) => edge.targetHandle === 'prompt')).toHaveLength(2);
    expect(state.edges.filter((edge) => edge.targetHandle?.startsWith('images['))).toHaveLength(1);
    const sceneNode = state.nodes.find((node) => node.type === 'scene')!;
    expect(
      state.nodes
        .filter((node) => node.type === 'prompt')
        .every((node) => node.data.sourceSceneNodeId === sceneNode.id),
    ).toBe(true);
    expect(
      state.nodes
        .filter((node) => node.type === 'generate')
        .map((node) => node.data.durationSeconds),
    ).toEqual([6, 6]);

    const repeated = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/board-handoff`,
      payload: { ordinals: [1], destination: 'board', boardId, fullSync: false },
    });
    expect(repeated.statusCode).toBe(200);
    const repeatedState = repeated.json().state as typeof state;
    expect(repeatedState.nodes).toHaveLength(state.nodes.length);
    expect(repeatedState.edges).toHaveLength(state.edges.length);

    const runningState = {
      ...(board!.state as Record<string, unknown>),
      nodes: state.nodes.map((node) =>
        node.type === 'generate'
          ? { ...node, data: { ...node.data, status: 'running', jobId: 'job-in-flight' } }
          : node,
      ),
    };
    await db.update(boards).set({ state: runningState }).where(eq(boards.id, boardId));

    const whileRunning = await app.inject({
      method: 'POST',
      url: `/v1/scripts/` + script.id + `/board-handoff`,
      payload: { ordinals: [1], destination: 'board', boardId, fullSync: false },
    });
    expect(whileRunning.statusCode).toBe(200);
    const whileRunningState = whileRunning.json().state as typeof state;
    expect(
      whileRunningState.nodes
        .filter((node) => node.type === 'generate')
        .map((node) => ({ status: node.data.status, jobId: node.data.jobId })),
    ).toEqual([
      { status: 'running', jobId: 'job-in-flight' },
      { status: 'running', jobId: 'job-in-flight' },
    ]);
  });

  it('preserves completed generate results and marks them drifted on re-handoff', async () => {
    const source = scene(1).trimEnd();
    const script = await createScript(`${source}\n`, 'Завершённая генерация');
    const timing = await app.inject({
      method: 'PUT',
      url: `/v1/scripts/` + script.id + `/scene-timings/scene:1`,
      payload: { durationSeconds: 12 },
    });
    expect(timing.statusCode).toBe(200);
    await db.insert(scriptShotPlans).values({
      id: nid(),
      scriptId: script.id,
      sourceSceneId: 'scene:1',
      sourceHash: scenarioTimingSourceRevisionId(source),
      targetDurationSeconds: 12,
      policyVersion: SCENARIO_SHOT_PLAN_VERSION,
      modelId: SCENARIO_SHOT_PLAN_MODEL,
      plan: {
        version: SCENARIO_SHOT_PLAN_VERSION,
        sceneId: 'scene:1',
        targetDurationSeconds: 12,
        shots: [
          {
            order: 1,
            title: 'Кадр двери',
            durationSec: 6,
            dramaticBeat: 'Герой делает шаг.',
            promptDraft: 'Средний план двери в ночной комнате.',
            requiredLocks: [],
            unresolvedAssets: [],
          },
          {
            order: 2,
            title: 'Кадр пустоты',
            durationSec: 6,
            dramaticBeat: 'Комната отвечает тишиной.',
            promptDraft: 'Медленный наезд на пустую комнату.',
            requiredLocks: [],
            unresolvedAssets: [],
          },
        ],
      },
      creditsSpent: SCENARIO_SHOT_PLAN_CREDITS,
    });

    const created = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/board-handoff`,
      payload: { ordinals: [1], destination: 'new', fullSync: true },
    });
    expect(created.statusCode).toBe(201);
    const boardId = created.json().boardId as string;
    createdBoards.push(boardId);
    const [board] = await db.select().from(boards).where(eq(boards.id, boardId));
    const state = board!.state as {
      nodes: Array<{ id: string; type: string; data: Record<string, unknown> }>;
      edges: Array<unknown>;
    };

    const doneState = {
      ...(board!.state as Record<string, unknown>),
      nodes: state.nodes.map((node) =>
        node.type === 'generate'
          ? {
              ...node,
              data: {
                ...node.data,
                status: 'done',
                resultUrl: 'https://assets.seed.local/result.mp4',
                resultKind: 'video',
                takes: ['https://assets.seed.local/take-1.mp4'],
              },
            }
          : node,
      ),
    };
    await db.update(boards).set({ state: doneState }).where(eq(boards.id, boardId));

    const rehandoff = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/board-handoff`,
      payload: { ordinals: [1], destination: 'board', boardId, fullSync: false },
    });
    expect(rehandoff.statusCode).toBe(200);
    const rehandoffState = rehandoff.json().state as typeof state;
    expect(
      rehandoffState.nodes
        .filter((node) => node.type === 'generate')
        .map((node) => ({
          status: node.data.status,
          resultUrl: node.data.resultUrl,
          takes: node.data.takes,
          drifted: node.data.drifted,
        })),
    ).toEqual([
      {
        status: 'done',
        resultUrl: 'https://assets.seed.local/result.mp4',
        takes: ['https://assets.seed.local/take-1.mp4'],
        drifted: true,
      },
      {
        status: 'done',
        resultUrl: 'https://assets.seed.local/result.mp4',
        takes: ['https://assets.seed.local/take-1.mp4'],
        drifted: true,
      },
    ]);
  });

  it('refuses materialization at the Board node limit without truncating state', async () => {
    const source = scene(1).trimEnd();
    const script = await createScript(`${source}\n`, 'Переполненная доска');
    const timing = await app.inject({
      method: 'PUT',
      url: '/v1/scripts/' + script.id + '/scene-timings/scene:1',
      payload: { durationSeconds: 12 },
    });
    expect(timing.statusCode).toBe(200);
    await db.insert(scriptShotPlans).values({
      id: nid(),
      scriptId: script.id,
      sourceSceneId: 'scene:1',
      sourceHash: scenarioTimingSourceRevisionId(source),
      targetDurationSeconds: 12,
      policyVersion: SCENARIO_SHOT_PLAN_VERSION,
      modelId: SCENARIO_SHOT_PLAN_MODEL,
      plan: {
        version: SCENARIO_SHOT_PLAN_VERSION,
        sceneId: 'scene:1',
        targetDurationSeconds: 12,
        shots: [
          {
            order: 1,
            title: 'Кадр двери',
            durationSec: 6,
            dramaticBeat: 'Герой делает шаг.',
            promptDraft: 'Средний план двери в ночной комнате.',
            requiredLocks: [],
            unresolvedAssets: [],
          },
          {
            order: 2,
            title: 'Кадр пустоты',
            durationSec: 6,
            dramaticBeat: 'Комната отвечает тишиной.',
            promptDraft: 'Медленный наезд на пустую комнату.',
            requiredLocks: [],
            unresolvedAssets: [],
          },
        ],
      },
      creditsSpent: SCENARIO_SHOT_PLAN_CREDITS,
    });
    const boardId = nid();
    createdBoards.push(boardId);
    const filler = Array.from({ length: 498 }, (_, index) => ({
      id: `filler-${index}`,
      type: 'note',
      version: 1,
      position: { x: index, y: index },
      data: { text: 'filler' },
    }));
    await db.insert(boards).values({
      id: boardId,
      userId: owner,
      title: 'Лимит',
      state: {
        schemaVersion: 1,
        nodes: [
          ...filler,
          {
            id: 'linked-scene',
            type: 'scene',
            version: 1,
            position: { x: 0, y: 0 },
            data: {
              title: 'ИНТ. ЛОКАЦИЯ 1 - ДЕНЬ',
              synopsis: 'Синопсис 1.',
              sourceText: source,
              sourceScriptId: script.id,
              sourceSceneId: 'scene:1',
              sourceOrdinal: 1,
              sourceHash: scenarioTimingSourceRevisionId(source),
              sourceStatus: 'current',
              collapsed: true,
            },
          },
        ],
        edges: [],
        tray: [],
        __rev: 0,
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/board-handoff`,
      payload: { ordinals: [1], destination: 'board', boardId, fullSync: false },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('board_capacity_exceeded');
    const [unchanged] = await db.select().from(boards).where(eq(boards.id, boardId));
    expect((unchanged!.state as { nodes: unknown[] }).nodes).toHaveLength(499);
  });

  it('does not project a cached plan after the approved scene duration changes', async () => {
    const source = scene(1).trimEnd();
    const script = await createScript(`${source}\n`, 'Устаревший план');
    const approved = await app.inject({
      method: 'PUT',
      url: `/v1/scripts/` + script.id + `/scene-timings/scene:1`,
      payload: { durationSeconds: 12 },
    });
    expect(approved.statusCode).toBe(200);
    await db.insert(scriptShotPlans).values({
      id: nid(),
      scriptId: script.id,
      sourceSceneId: 'scene:1',
      sourceHash: scenarioTimingSourceRevisionId(source),
      targetDurationSeconds: 12,
      policyVersion: SCENARIO_SHOT_PLAN_VERSION,
      modelId: SCENARIO_SHOT_PLAN_MODEL,
      plan: {
        version: SCENARIO_SHOT_PLAN_VERSION,
        sceneId: 'scene:1',
        targetDurationSeconds: 12,
        shots: [
          {
            order: 1,
            title: 'Один кадр',
            durationSec: 12,
            dramaticBeat: 'Действие развивается.',
            promptDraft: 'Средний план действия в комнате.',
            requiredLocks: [],
            unresolvedAssets: [],
          },
        ],
      },
      creditsSpent: SCENARIO_SHOT_PLAN_CREDITS,
    });

    const changed = await app.inject({
      method: 'PUT',
      url: `/v1/scripts/` + script.id + `/scene-timings/scene:1`,
      payload: { durationSeconds: 15 },
    });
    expect(changed.statusCode).toBe(200);

    const created = await app.inject({
      method: 'POST',
      url: `/v1/scripts/` + script.id + `/board-handoff`,
      payload: { ordinals: [1], destination: 'new', fullSync: true },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ materializedShots: 0, materializedCastNodes: 0 });
  });

  it('rejects a stale linked handoff without changing board state', async () => {
    const script = await createScript([scene(1), scene(2)].join('\n'), 'Конфликт ревизий');
    const created = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/board-handoff`,
      payload: { ordinals: [1, 2], destination: 'new', fullSync: true },
    });
    expect(created.statusCode).toBe(201);
    const boardId = created.json().boardId as string;
    createdBoards.push(boardId);
    const [before] = await db.select().from(boards).where(eq(boards.id, boardId));
    const beforeRev = (before!.state as { __rev: number }).__rev;

    const client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SELECT 1 FROM boards WHERE id = $1 FOR UPDATE', [boardId]);
    try {
      const handoffs = Promise.all([
        app.inject({
          method: 'POST',
          url: `/v1/scripts/${script.id}/board-handoff`,
          payload: { ordinals: [1], destination: 'linked', boardId, fullSync: false },
        }),
        app.inject({
          method: 'POST',
          url: `/v1/scripts/${script.id}/board-handoff`,
          payload: { ordinals: [1], destination: 'linked', boardId, fullSync: false },
        }),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await client.query('ROLLBACK');
      const [first, second] = await handoffs;
      expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);
      const rejected = [first, second].find((response) => response.statusCode === 409)!;
      expect(rejected.json()).toEqual({ error: 'board_rev_conflict' });
    } finally {
      try {
        await client.query('ROLLBACK');
      } catch {
        // already released by the happy path
      }
      client.release();
    }
    const [after] = await db.select().from(boards).where(eq(boards.id, boardId));
    expect((after!.state as { __rev: number }).__rev).toBe(beforeRev + 1);
  });

  it('replays concurrent same-key new-destination handoffs with a single board', async () => {
    const script = await createScript(scene(1), 'Параллельный ключ');
    const idempotencyKey = `handoff-${nid()}`;
    const [first, second] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/v1/scripts/${script.id}/board-handoff`,
        payload: { ordinals: [1], destination: 'new', fullSync: false, idempotencyKey },
      }),
      app.inject({
        method: 'POST',
        url: `/v1/scripts/${script.id}/board-handoff`,
        payload: { ordinals: [1], destination: 'new', fullSync: false, idempotencyKey },
      }),
    ]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 201]);
    const created = [first, second].find((response) => response.statusCode === 201)!;
    const replayed = [first, second].find((response) => response.statusCode === 200)!;
    expect(created.json()).toMatchObject({ created: true, replayed: false });
    expect(replayed.json()).toMatchObject({ created: false, replayed: true });
    expect(replayed.json().boardId).toBe(created.json().boardId);
    createdBoards.push(created.json().boardId);
    const rows = await db.select().from(boards).where(eq(boards.userId, owner));
    const matching = rows.filter(
      (row) =>
        (row.state as { __scenarioHandoff?: { idempotencyKey?: unknown } }).__scenarioHandoff
          ?.idempotencyKey === idempotencyKey,
    );
    expect(matching).toHaveLength(1);
  });

  it('rejects a handoff that would exceed 1 MiB without persisting', async () => {
    const script = await createScript(scene(1), 'Переполнение байтов');
    const boardId = nid();
    createdBoards.push(boardId);
    const filler = Array.from({ length: 60 }, (_, index) => ({
      id: `byte-filler-${index}`,
      type: 'note',
      version: 1,
      position: { x: index, y: index },
      data: { text: 'x'.repeat(20_000) },
    }));
    await db.insert(boards).values({
      id: boardId,
      userId: owner,
      title: 'Байтовый предел',
      state: {
        schemaVersion: 1,
        nodes: filler,
        edges: [],
        tray: [],
        __rev: 0,
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${script.id}/board-handoff`,
      payload: { ordinals: [1], destination: 'board', boardId, fullSync: false },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'board_state_too_large' });
    const [unchanged] = await db.select().from(boards).where(eq(boards.id, boardId));
    const unchangedState = unchanged!.state as { nodes: unknown[]; __rev: number };
    expect(unchangedState.nodes).toHaveLength(60);
    expect(unchangedState.__rev).toBe(0);
  });
});

describe('Scenario scene timing revisions', () => {
  it('returns a labelled page fallback, persists user approval, and preserves it after a source edit', async () => {
    const script = await createScript(
      'ИНТ. КВАРТИРА — ДЕНЬ\nМаша смотрит в окно.\n\nНАТ. ДВОР — ВЕЧЕР\nМаша выходит из дома.\n',
      'Timing ledger',
    );

    const initial = await app.inject({
      method: 'GET',
      url: `/v1/scripts/${script.id}/scene-timings`,
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({
      policyVersion: 'page-estimate-v1',
      scenes: [
        { sourceUnitId: 'scene:1', timing: null, pageEstimate: '0:04' },
        { sourceUnitId: 'scene:2', timing: null, pageEstimate: '0:04' },
      ],
    });

    const approved = await app.inject({
      method: 'PUT',
      url: `/v1/scripts/${script.id}/scene-timings/scene:1`,
      payload: { durationSeconds: 12 },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({
      ok: true,
      timing: { durationSeconds: 12, owner: 'user', stale: false, sourceChanged: false },
    });
    const approvedId = approved.json().timing.id as string;

    const revised = await app.inject({
      method: 'PUT',
      url: `/v1/scripts/${script.id}`,
      payload: {
        baseRev: 0,
        fountain:
          'ИНТ. КВАРТИРА — ДЕНЬ\nМаша смотрит в окно и открывает письмо.\n\nНАТ. ДВОР — ВЕЧЕР\nМаша выходит из дома.\n',
      },
    });
    expect(revised.statusCode).toBe(200);

    const afterSourceEdit = await app.inject({
      method: 'GET',
      url: `/v1/scripts/${script.id}/scene-timings`,
    });
    expect(afterSourceEdit.json().scenes[0]).toMatchObject({
      sourceUnitId: 'scene:1',
      timing: {
        id: approvedId,
        durationSeconds: 12,
        owner: 'user',
        stale: false,
        sourceChanged: true,
      },
    });
  });

  it('marks a Vertov timing stale after its source revision changes and keeps history append-only', async () => {
    const script = await createScript(
      'ИНТ. КОМНАТА — ДЕНЬ\nГерой ждёт.\n\nНАТ. УЛИЦА — НОЧЬ\nГерой уходит.\n',
      'Stale timing',
    );
    const [vertov] = await db
      .insert(scriptSceneTimings)
      .values({
        id: nid(),
        scriptId: script.id,
        sourceUnitId: 'scene:2',
        durationSeconds: 8,
        owner: 'vertov',
        sourceRevisionId: 'old-revision',
        estimatorPolicyVersion: 'page-estimate-v1',
      })
      .returning();

    const next = await app.inject({
      method: 'PUT',
      url: `/v1/scripts/${script.id}/scene-timings/scene:2`,
      payload: { durationSeconds: 15 },
    });
    expect(next.statusCode).toBe(200);

    const rows = await db
      .select()
      .from(scriptSceneTimings)
      .where(eq(scriptSceneTimings.scriptId, script.id));
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === next.json().timing.id)?.supersedesTimingId).toBe(
      vertov!.id,
    );

    const read = await app.inject({
      method: 'GET',
      url: `/v1/scripts/${script.id}/scene-timings`,
    });
    expect(read.json().scenes[1].timing).toMatchObject({
      durationSeconds: 15,
      owner: 'user',
      stale: false,
    });
  });
});

describe('scripts CRUD', () => {
  it('creates exactly one script when the same intent key is retried', async () => {
    const key = `script-intent-${nid()}`;
    const first = await app.inject({
      method: 'POST',
      url: '/v1/scripts',
      payload: { idempotencyKey: key, title: 'Один проект' },
    });
    const retry = await app.inject({
      method: 'POST',
      url: '/v1/scripts',
      payload: { idempotencyKey: key, title: 'Не должен создать второй' },
    });
    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().id).toBe(first.json().id);
    createdScripts.push(first.json().id);
    const rows = await db
      .select({ id: scripts.id })
      .from(scripts)
      .where(and(eq(scripts.userId, owner), eq(scripts.createKey, key)));
    expect(rows).toHaveLength(1);
  });

  it('creates, reads, lists and deletes a script', async () => {
    const row = await createScript();
    expect(row.rev).toBe(0);

    const got = await app.inject({ method: 'GET', url: `/v1/scripts/${row.id}` });
    expect(got.statusCode).toBe(200);
    expect(got.json().fountain).toBe(RU_FOUNTAIN);

    const list = await app.inject({ method: 'GET', url: '/v1/scripts' });
    expect(list.json().items.some((i: { id: string }) => i.id === row.id)).toBe(true);
    // list must not carry the full text
    expect(list.json().items[0].fountain).toBeUndefined();

    const del = await app.inject({ method: 'DELETE', url: `/v1/scripts/${row.id}` });
    expect(del.json()).toEqual({ ok: true });
    const gone = await app.inject({ method: 'GET', url: `/v1/scripts/${row.id}` });
    expect(gone.statusCode).toBe(404);
  });

  it('stores a validated universal project model without changing Fountain content', async () => {
    const outline = {
      version: 1,
      beats: [
        {
          id: 'hook-1',
          kind: 'hook',
          title: 'First second',
          summary: 'A creator drops a camera into a dark cinema.',
          durationSeconds: 3,
        },
      ],
    };
    const created = await app.inject({
      method: 'POST',
      url: '/v1/scripts',
      payload: {
        title: 'Short launch',
        fountain: 'Existing Fountain stays canonical.\n',
        format: 'social',
        brief: { version: 1, platform: 'Reels', durationSeconds: 25, inferred: true },
        outline,
      },
    });
    expect(created.statusCode).toBe(201);
    const row = created.json();
    createdScripts.push(row.id);
    expect(row).toMatchObject({ format: 'social', brief: { platform: 'Reels' }, outline });
    expect(row.fountain).toBe('Existing Fountain stays canonical.\n');

    const revised = await app.inject({
      method: 'PUT',
      url: `/v1/scripts/${row.id}`,
      payload: {
        baseRev: 0,
        brief: { version: 1, platform: 'TikTok', durationSeconds: 30 },
        outline: {
          ...outline,
          beats: [...outline.beats, { id: 'cta-1', kind: 'cta', title: 'CTA', summary: '' }],
        },
      },
    });
    expect(revised.json()).toEqual({ ok: true, rev: 1 });
    const reread = await app.inject({ method: 'GET', url: `/v1/scripts/${row.id}` });
    expect(reread.json()).toMatchObject({
      fountain: 'Existing Fountain stays canonical.\n',
      brief: { platform: 'TikTok' },
      outline: { beats: [{ id: 'hook-1' }, { id: 'cta-1' }] },
      rev: 1,
    });
  });

  it('rejects invalid outline payloads before persistence', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/scripts',
      payload: {
        format: 'social',
        outline: { version: 1, beats: [{ id: 'x', kind: 'hook', title: '', summary: '' }] },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_body' });
  });
});

describe('rev-guarded save (the draft can never be silently eaten)', () => {
  it('version-guards the complete project and returns all fields on conflict', async () => {
    const row = await createScript('Исходный текст.\n');
    const first = await app.inject({
      method: 'PATCH',
      url: `/v1/scripts/${row.id}/project`,
      payload: {
        baseRev: 0,
        title: 'Новая версия',
        format: 'ad',
        brief: { version: 1, audience: 'Продюсеры' },
        outline: {
          version: 1,
          beats: [{ id: 'proof', kind: 'development', title: 'Доказательство', summary: '' }],
        },
      },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().project).toMatchObject({ rev: 1, title: 'Новая версия', format: 'ad' });

    const stale = await app.inject({
      method: 'PATCH',
      url: `/v1/scripts/${row.id}/project`,
      payload: { baseRev: 0, title: 'Потерянная запись' },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      error: 'rev_conflict',
      project: {
        rev: 1,
        title: 'Новая версия',
        fountain: 'Исходный текст.\n',
        format: 'ad',
        brief: { audience: 'Продюсеры' },
        outline: { beats: [{ id: 'proof' }] },
      },
    });
  });

  it('accepts a save from the current rev and bumps rev', async () => {
    const row = await createScript();
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/scripts/${row.id}`,
      payload: { fountain: RU_FOUNTAIN + '\nНОВАЯ СТРОКА.\n', baseRev: 0 },
    });
    expect(res.json()).toEqual({ ok: true, rev: 1 });
  });

  it('rejects a stale save with 409 + current rev, leaving the text intact', async () => {
    const row = await createScript();
    await app.inject({
      method: 'PUT',
      url: `/v1/scripts/${row.id}`,
      payload: { fountain: 'Версия из вкладки А.\n', baseRev: 0 },
    });
    const stale = await app.inject({
      method: 'PUT',
      url: `/v1/scripts/${row.id}`,
      payload: { fountain: 'Версия из вкладки Б (устаревшая).\n', baseRev: 0 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({
      error: 'rev_conflict',
      rev: 1,
      fountain: 'Версия из вкладки А.\n',
    });
    const current = await app.inject({ method: 'GET', url: `/v1/scripts/${row.id}` });
    expect(current.json().fountain).toBe('Версия из вкладки А.\n');
  });

  it('requires baseRev when fountain changes', async () => {
    const row = await createScript();
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/scripts/${row.id}`,
      payload: { fountain: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('base_rev_required');
  });

  it('metadata-only update (title/bible) does not bump rev', async () => {
    const row = await createScript();
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/scripts/${row.id}`,
      payload: { title: 'Новое имя', bible: { tone: ['мистика'] } },
    });
    expect(res.json()).toEqual({ ok: true, rev: 0 });
    const got = await app.inject({ method: 'GET', url: `/v1/scripts/${row.id}` });
    expect(got.json().title).toBe('Новое имя');
    expect(got.json().bible).toEqual({ tone: ['мистика'] });
  });
});

describe('IDOR: every route is invisible cross-user', () => {
  it('read/save/delete/export of another user’s script → 404, data intact', async () => {
    const row = await createScript();
    for (const attempt of [
      { method: 'GET' as const, url: `/v1/scripts/${row.id}` },
      {
        method: 'PUT' as const,
        url: `/v1/scripts/${row.id}`,
        payload: { fountain: 'взлом', baseRev: 0 },
      },
      { method: 'DELETE' as const, url: `/v1/scripts/${row.id}` },
      { method: 'GET' as const, url: `/v1/scripts/${row.id}/export?format=fountain` },
      { method: 'GET' as const, url: `/v1/scripts/${row.id}/snapshots` },
      { method: 'POST' as const, url: `/v1/scripts/${row.id}/snapshots` },
      {
        method: 'POST' as const,
        url: `/v1/scripts/${row.id}/threads`,
        payload: { message: { content: 'hi' } },
      },
    ]) {
      const res = await intruderApp.inject(attempt);
      expect(res.statusCode, `${attempt.method} ${attempt.url}`).toBe(404);
    }
    const intact = await db.select().from(scripts).where(eq(scripts.id, row.id));
    expect(intact[0]!.fountain).toBe(RU_FOUNTAIN);
  });

  it('cannot patch another user’s thread', async () => {
    const row = await createScript();
    const created = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${row.id}/threads`,
      payload: { message: { content: 'моя заметка' } },
    });
    const threadId = created.json().id;
    const res = await intruderApp.inject({
      method: 'PATCH',
      url: `/v1/scripts/${row.id}/threads/${threadId}`,
      payload: { status: 'dismissed' },
    });
    expect(res.statusCode).toBe(404);
    const intact = await db.select().from(scriptThreads).where(eq(scriptThreads.id, threadId));
    expect(intact[0]!.status).toBe('open');
  });
});

describe('snapshots and restore', () => {
  it('manual snapshot → edit → restore brings the old text back at a new rev', async () => {
    const row = await createScript('Первый вариант.\n');
    const snap = await app.inject({ method: 'POST', url: `/v1/scripts/${row.id}/snapshots` });
    expect(snap.statusCode).toBe(201);
    const snapshotId = snap.json().id;

    await app.inject({
      method: 'PUT',
      url: `/v1/scripts/${row.id}`,
      payload: { fountain: 'Второй вариант.\n', baseRev: 0 },
    });

    const restored = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${row.id}/restore`,
      payload: { snapshotId },
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().fountain).toBe('Первый вариант.\n');
    expect(restored.json().rev).toBe(2); // restore is a new revision, not time travel

    const list = await app.inject({ method: 'GET', url: `/v1/scripts/${row.id}/snapshots` });
    const causes = list.json().items.map((s: { cause: string }) => s.cause);
    expect(causes).toContain('manual');
    expect(causes).toContain('restore');
  });

  it('fetches a single snapshot body', async () => {
    const row = await createScript('Тело версии.\n');
    const snap = await app.inject({ method: 'POST', url: `/v1/scripts/${row.id}/snapshots` });
    const got = await app.inject({
      method: 'GET',
      url: `/v1/scripts/${row.id}/snapshots/${snap.json().id}`,
    });
    expect(got.json().fountain).toBe('Тело версии.\n');
  });
});

describe('threads', () => {
  it('paginates the append-only message ledger with a stable cursor', async () => {
    const row = await createScript();
    const threadId = nid();
    await db
      .insert(scriptThreads)
      .values({ id: threadId, scriptId: row.id, userId: owner, messages: [] });
    const base = new Date('2032-01-01T00:00:00.000Z');
    await db.insert(scriptThreadMessages).values(
      Array.from({ length: 3 }, (_, index) => ({
        id: `msg-${index}-${nid()}`,
        threadId,
        scriptId: row.id,
        userId: owner,
        role: index % 2 ? 'assistant' : 'user',
        content: `message ${index}`,
        createdAt: new Date(base.getTime() + index * 1_000),
      })),
    );
    const newest = await app.inject({
      method: 'GET',
      url: `/v1/scripts/${row.id}/threads/${threadId}/messages?limit=2`,
    });
    expect(newest.statusCode).toBe(200);
    expect(newest.json()).toMatchObject({
      source: 'ledger',
      items: [{ content: 'message 1' }, { content: 'message 2' }],
    });
    const older = await app.inject({
      method: 'GET',
      url: `/v1/scripts/${row.id}/threads/${threadId}/messages?cursor=${encodeURIComponent(newest.json().nextCursor)}&limit=2`,
    });
    expect(older.json()).toMatchObject({ items: [{ content: 'message 0' }], nextCursor: null });
  });

  it('bounds a 1,000-message history, paginates without overlap, and cascades on delete', async () => {
    const row = await createScript();
    const threadId = nid();
    await db
      .insert(scriptThreads)
      .values({ id: threadId, scriptId: row.id, userId: owner, messages: [] });
    const base = new Date('2033-01-01T00:00:00.000Z');
    for (let offset = 0; offset < 1_000; offset += 200) {
      await db.insert(scriptThreadMessages).values(
        Array.from({ length: 200 }, (_, index) => {
          const n = offset + index;
          return {
            id: `scale-${n}-${nid()}`,
            threadId,
            scriptId: row.id,
            userId: owner,
            role: n % 2 ? 'assistant' : 'user',
            content: `scale message ${n}`,
            createdAt: new Date(base.getTime() + n),
          };
        }),
      );
    }
    const started = performance.now();
    const newest = await app.inject({
      method: 'GET',
      url: `/v1/scripts/${row.id}/threads/${threadId}/messages?limit=50`,
    });
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(newest.json().items).toHaveLength(50);
    expect(newest.body).not.toContain('scale message 0');
    const older = await app.inject({
      method: 'GET',
      url: `/v1/scripts/${row.id}/threads/${threadId}/messages?limit=50&cursor=${encodeURIComponent(newest.json().nextCursor)}`,
    });
    const newestIds = new Set(newest.json().items.map((item: { id: string }) => item.id));
    expect(older.json().items.every((item: { id: string }) => !newestIds.has(item.id))).toBe(true);
    const hidden = await intruderApp.inject({
      method: 'GET',
      url: `/v1/scripts/${row.id}/threads/${threadId}/messages?limit=50`,
    });
    expect(hidden.statusCode).toBe(404);

    await app.inject({ method: 'DELETE', url: `/v1/scripts/${row.id}` });
    const remaining = await db
      .select({ id: scriptThreadMessages.id })
      .from(scriptThreadMessages)
      .where(eq(scriptThreadMessages.scriptId, row.id));
    expect(remaining).toHaveLength(0);
  });

  it('creates an anchored thread and appends messages', async () => {
    const row = await createScript();
    const created = await app.inject({
      method: 'POST',
      url: `/v1/scripts/${row.id}/threads`,
      payload: {
        anchor: { from: 120, to: 190, rev: 0, quote: 'Сеанс окончен, Лида.' },
        message: { content: 'Слишком мягко для Михалыча?' },
      },
    });
    expect(created.statusCode).toBe(201);
    const thread = created.json();
    expect(thread.anchor.quote).toBe('Сеанс окончен, Лида.');
    expect(thread.messages).toHaveLength(1);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/v1/scripts/${row.id}/threads/${thread.id}`,
      payload: {
        message: {
          role: 'assistant',
          content: 'Вариант жёстче:',
          proposal: { before: 'Сеанс окончен, Лида.', after: 'Всё. Домой.' },
          tier: 'standard',
        },
        status: 'open',
      },
    });
    expect(patched.json().messages).toHaveLength(2);
    expect(patched.json().messages[1].proposal.after).toBe('Всё. Домой.');
    const ledger = await app.inject({
      method: 'GET',
      url: `/v1/scripts/${row.id}/threads/${thread.id}/messages`,
    });
    expect(ledger.json()).toMatchObject({
      source: 'ledger',
      items: [
        { role: 'user', content: 'Слишком мягко для Михалыча?' },
        { role: 'assistant', proposal: { after: 'Всё. Домой.' } },
      ],
    });

    const list = await app.inject({ method: 'GET', url: `/v1/scripts/${row.id}/threads` });
    expect(list.json().items.map((t: { id: string }) => t.id)).toContain(thread.id);
  });
});

describe('import', () => {
  it('imports a .fountain file, titles it from the title page, snapshots rev 0', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/scripts/import?format=fountain',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from(RU_FOUNTAIN),
    });
    expect(res.statusCode).toBe(201);
    const { script, report } = res.json();
    createdScripts.push(script.id);
    expect(script.title).toBe('Последний сеанс');
    expect(script.fountain).toBe(RU_FOUNTAIN);
    expect(report.lossless).toBe(true);

    const snaps = await db
      .select()
      .from(scriptSnapshots)
      .where(and(eq(scriptSnapshots.scriptId, script.id), eq(scriptSnapshots.rev, 0)));
    expect(snaps).toHaveLength(1);
  });

  it('imports .fdx with a fidelity report', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/scripts/import?format=fdx&title=Из Final Draft',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from(SAMPLE_FDX),
    });
    expect(res.statusCode).toBe(201);
    const { script, report } = res.json();
    createdScripts.push(script.id);
    expect(script.title).toBe('Из Final Draft');
    expect(report.lossless).toBe(false);
    expect(report.issues.length).toBeGreaterThan(0);
  });

  it('imports .md as fountain (fountain degrades to/from plain text and markdown)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/scripts/import?format=md&title=Из markdown',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('ИНТ. КУХНЯ - ДЕНЬ\n\nЧайник свистит.\n'),
    });
    expect(res.statusCode).toBe(201);
    const { script, report } = res.json();
    createdScripts.push(script.id);
    expect(report.lossless).toBe(true);
    expect(script.fountain).toContain('ИНТ. КУХНЯ');
  });

  it('rejects unknown formats and empty bodies', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/scripts/import?format=exe',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('x'),
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('unsupported_format');
  });

  it('returns 422 with the adapter message when the file is broken', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/scripts/import?format=fdx',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('*** это не XML ***'),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('import_failed');
    expect(res.json().message).toMatch(/FDX/);
  });
});

describe('export', () => {
  it('exports fountain text verbatim', async () => {
    const row = await createScript();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/scripts/${row.id}/export?format=fountain`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(RU_FOUNTAIN);
    expect(res.headers['content-disposition']).toContain('attachment');
  });

  it('exports fdx XML', async () => {
    const row = await createScript();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/scripts/${row.id}/export?format=fdx`,
    });
    expect(res.body).toContain('<FinalDraft');
    expect(res.body).toContain('КИНОБУДКА');
  });

  it('exports a typeset PDF', async () => {
    const row = await createScript();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/scripts/${row.id}/export?format=pdf`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });
});

describe('materials («Материалы проекта») CRUD + ceilings', () => {
  const addMaterial = (id: string, body: unknown) =>
    app.inject({ method: 'POST', url: `/v1/scripts/${id}/materials`, payload: body });

  it('creates, lists (with a context meter), updates and deletes materials', async () => {
    const row = await createScript();
    const created = await addMaterial(row.id, { name: 'лор.md', content: 'Мир зимний.' });
    expect(created.statusCode).toBe(201);
    expect(created.json().chars).toBe([...'Мир зимний.'].length);

    const list = await app.inject({ method: 'GET', url: `/v1/scripts/${row.id}/materials` });
    expect(list.json().items).toHaveLength(1);
    expect(list.json().totalChars).toBe([...'Мир зимний.'].length);
    expect(list.json().maxTotalChars).toBe(20_000);
    // the list must not carry the (potentially large) file bodies
    expect(list.json().items[0].content).toBeUndefined();

    const matId = created.json().id;
    const upd = await app.inject({
      method: 'PUT',
      url: `/v1/scripts/${row.id}/materials/${matId}`,
      payload: { content: 'Мир зимний. Кинотеатр заброшен.' },
    });
    expect(upd.statusCode).toBe(200);
    expect(upd.json().chars).toBe([...'Мир зимний. Кинотеатр заброшен.'].length);

    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/scripts/${row.id}/materials/${matId}`,
    });
    expect(del.json()).toEqual({ ok: true });
    const after = await app.inject({ method: 'GET', url: `/v1/scripts/${row.id}/materials` });
    expect(after.json().items).toHaveLength(0);
  });

  it('blocks the 11th file with a clear RU message (never silent)', async () => {
    const row = await createScript();
    for (let i = 0; i < 10; i++) {
      const r = await addMaterial(row.id, { name: `f${i}.txt`, content: 'x' });
      expect(r.statusCode).toBe(201);
    }
    const overflow = await addMaterial(row.id, { name: 'f10.txt', content: 'x' });
    expect(overflow.statusCode).toBe(400);
    expect(overflow.json().error).toBe('too_many_materials');
    expect(overflow.json().message).toContain('не более 10');
  });

  it('blocks a single file over 30k chars', async () => {
    const row = await createScript();
    const r = await addMaterial(row.id, { name: 'big.md', content: 'ы'.repeat(30_001) });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('material_too_large');
  });

  it('blocks exceeding the 20k total in-context budget', async () => {
    const row = await createScript();
    const first = await addMaterial(row.id, { name: 'a.md', content: 'ю'.repeat(15_000) });
    expect(first.statusCode).toBe(201);
    const second = await addMaterial(row.id, { name: 'b.md', content: 'я'.repeat(6_000) });
    expect(second.statusCode).toBe(400);
    expect(second.json().error).toBe('materials_budget_exceeded');
    expect(second.json().message).toContain('20');
  });

  it("IDOR: cannot add materials to another user's script", async () => {
    const row = await createScript();
    const res = await intruderApp.inject({
      method: 'POST',
      url: `/v1/scripts/${row.id}/materials`,
      payload: { name: 'x.md', content: 'y' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('background-compacts a large uploaded material via the injected compactor', async () => {
    const seen: Array<{ id: string; chars: number }> = [];
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    const compactor = async (m: { id: string; name: string; content: string }) => {
      seen.push({ id: m.id, chars: [...m.content].length });
      await db
        .update(scriptMaterials)
        .set({ summary: 'сжатая память' })
        .where(eq(scriptMaterials.id, m.id));
      resolveDone();
    };
    const capp = await buildApp(owner, { compactor });
    const script = await capp.inject({ method: 'POST', url: '/v1/scripts', payload: {} });
    const scriptId = script.json().id;

    const big = 'канон истории. '.repeat(150); // ~2250 chars: over the min, under the 20k ceiling
    const created = await capp.inject({
      method: 'POST',
      url: `/v1/scripts/${scriptId}/materials`,
      payload: { name: 'заявка.md', content: big },
    });
    expect(created.statusCode).toBe(201);
    // upload returns immediately; compaction runs fire-and-forget
    expect(created.json().summary).toBeNull();
    await done;
    expect(seen).toHaveLength(1);
    const [row] = await db
      .select({ summary: scriptMaterials.summary })
      .from(scriptMaterials)
      .where(eq(scriptMaterials.id, created.json().id));
    expect(row!.summary).toBe('сжатая память');
    await capp.close();
  });

  it('does NOT compact a small material (below the min)', async () => {
    const seen: string[] = [];
    const compactor = async (m: { id: string }) => void seen.push(m.id);
    const capp = await buildApp(owner, { compactor });
    const script = await capp.inject({ method: 'POST', url: '/v1/scripts', payload: {} });
    await capp.inject({
      method: 'POST',
      url: `/v1/scripts/${script.json().id}/materials`,
      payload: { name: 'note.md', content: 'коротко' },
    });
    await new Promise((r) => setTimeout(r, 20)); // give any stray call a chance
    expect(seen).toHaveLength(0);
    await capp.close();
  });
});

describe('list-card stats + author', () => {
  it('returns pages / scene count / first + last scene and the title-page author, not the fountain', async () => {
    const row = await createScript();
    const res = await app.inject({ method: 'GET', url: '/v1/scripts' });
    expect(res.statusCode).toBe(200);
    const item = res.json().items.find((x: { id: string }) => x.id === row.id);
    expect(item).toBeTruthy();
    expect(item.fountain).toBeUndefined(); // payload stays lean
    expect(item.stats.scenes).toBe(4);
    expect(item.stats.firstScene).toBe('ИНТ. КИНОБУДКА - НОЧЬ');
    expect(item.stats.lastScene).toBe('ПАВ. ДЕКОРАЦИЯ «КВАРТИРА» - ДЕНЬ');
    expect(item.stats.pages).toBeGreaterThanOrEqual(1);
    expect(item.author).toBe('Аноним Вертов');
  });
});

describe('«Открыть пример» seeded project', () => {
  it('creates a populated example: script + bible + one applied note + one material', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/scripts/example' });
    expect(res.statusCode).toBe(201);
    const script = res.json();
    createdScripts.push(script.id);
    expect(script.title).toBe('Кинобудка');
    expect(script.bible.notes?.some((n: string) => n.includes('МАРК'))).toBe(true);
    // The applied rewrite is already reflected in the text.
    expect(script.fountain).toContain('Плёнка не врёт. Люди врут.');

    const threads = await app.inject({ method: 'GET', url: `/v1/scripts/${script.id}/threads` });
    const thread = threads.json().items[0];
    expect(thread.status).toBe('applied');
    expect(thread.anchor).toBeTruthy();
    const proposal = thread.messages.find((m: { proposal?: unknown }) => m.proposal).proposal;
    expect(proposal.before).toBe('Плёнка не врёт.');
    expect(proposal.after).toBe('Плёнка не врёт. Люди врут.');
    // The anchor points at the applied span in the current text.
    expect(script.fountain.slice(thread.anchor.from, thread.anchor.to)).toBe(
      'Плёнка не врёт. Люди врут.',
    );

    const mats = await app.inject({ method: 'GET', url: `/v1/scripts/${script.id}/materials` });
    expect(mats.json().items).toHaveLength(1);
    expect(mats.json().items[0].name).toBe('синопсис_v2.docx');
  });
});

import {
  scenarioStructurizeResultSchema,
  type ScenarioFormat,
  type ScenarioStructurizeResult,
} from '@seed/shared';

/**
 * Structurization engine (goal S1) — the craft, encoded as RULES.
 *
 * Pure functions only (no DB, no gateway): the format playbooks, the prompt
 * assembly, and the JSON parse/validate/normalize pipeline. This is what turns
 * a rough idea (or a pasted screenplay) into a validated {format, brief,
 * outline} that every visual unit downstream consumes. Kept side-effect-free so
 * the whole pipeline is unit-testable and the eval corpus can score it offline
 * through the mock gateway.
 *
 * Doctrine (plan §6 S1): playbooks are RULES for answering well, NOT templates
 * and NOT a canned-answer library. The model picks the format from the idea and
 * applies that format's craft; the universal rules bind across all four.
 */

export type StructurizeSourceKind = 'idea' | 'fountain';

/** The visible beat kinds, mirrored from ScenarioBeatV1 for the prompt contract. */
const BEAT_KINDS = [
  'hook',
  'setup',
  'conflict',
  'development',
  'turn',
  'resolution',
  'cta',
  'scene',
  'custom',
] as const;
type BeatKind = (typeof BEAT_KINDS)[number];
const BEAT_KIND_SET = new Set<string>(BEAT_KINDS);

/** Per-format craft rules — the playbooks (plan §6 S1). */
const FORMAT_PLAYBOOKS = [
  '«social» (Короткое видео) — вертикаль, TikTok/Reels/Shorts:',
  '  · Крючок в первые 2 секунды: первый бит обязан остановить пролистывание',
  '    (вопрос, обещание, аномалия, конфликт), а не «представление темы».',
  '  · Каждый следующий бит отвечает на «почему он не свайпнул»: держи напряжение,',
  '    добавляй новое, не повторяйся.',
  '  · Развязка/пойнт и CTA — в конце (последний бит kind=cta или resolution).',
  '  · Типичная длительность 15–60 с; биты по 2–6 с.',
  '',
  '«ad» (Реклама / бренд):',
  '  · Сначала боль/желание зрителя, потом продукт — не наоборот.',
  '  · ОДНО сообщение на ролик. Не перечисляй все фичи — выбери одну выгоду.',
  '  · Доказательство (демо, факт, соц-док) ПЕРЕД призывом, CTA — последний бит.',
  '  · Жёсткий бюджет времени: биты обязаны уложиться в цель (15–30 с обычно).',
  '',
  '«film» (Фильм / сценарий):',
  '  · Логлайн в brief.goal (одна строка: кто, чего хочет, что мешает).',
  '  · Синопсис в brief (3–5 предложений) через goal/tone/constraints.',
  '  · Биты — это СЦЕНЫ (kind=scene): сцена = событие + перемена состояния,',
  '    а не «локация». title = что происходит, summary = суть сцены.',
  '  · Тайминг постраничный/опциональный: durationSeconds можно опустить.',
  '',
  '«sketch» (Скетч):',
  '  · Одна посылка (premise), без побочных линий.',
  '  · Эскалация минимум в 3 шага: каждый бит поднимает абсурд/ставку выше.',
  '  · Панчлайн — это ПОСЛЕДНЯЯ реплика (последний бит = удар, kind=turn/resolution).',
  '  · Обычно 60–120 с; биты по 5–10 с.',
].join('\n');

/** Rules that bind across every format. */
const UNIVERSAL_RULES = [
  'Материализуй ИДЕЮ ПОЛЬЗОВАТЕЛЯ: конкретные события, образы, реплики из его замысла.',
  'Никаких пустышек вроде «начало истории», «развитие», «кульминация», «сцена 1» —',
  'title всегда говорит ЧТО происходит, summary — 1–2 предложения по сути.',
  'Тайминг задаёт число битов и ОБЯЗАН суммироваться в цель: если пользователь дал',
  'длительность — уложись в неё; если нет — выбери типичную для формата и держи сумму',
  'durationSeconds битов равной этой цели (± пара секунд). Для film тайминг опционален.',
  'Пробелы в брифе заполняй нейтральным предположением и ставь brief.inferred=true —',
  'не выдумывай смелых фактов. Задай РОВНО ОДИН вопрос (поле "question") ТОЛЬКО если',
  'недостающий факт реально меняет структуру; иначе поля "question" быть не должно.',
  'Каждый бит должен быть редактируемым и самодостаточным. Пиши на языке идеи',
  '(обычно русский). Не переспрашивай ради вежливости — сразу дай рабочую структуру.',
].join('\n');

const OUTPUT_CONTRACT = [
  'Верни ТОЛЬКО валидный JSON (без markdown, без ```-ограждений, без пояснений до/после)',
  'строго такой формы:',
  '{',
  '  "format": "film" | "social" | "ad" | "sketch",',
  '  "brief": {',
  '    "version": 1,',
  '    "goal"?: string, "audience"?: string, "platform"?: string,',
  '    "durationSeconds"?: number, "tone"?: string, "cta"?: string,',
  '    "constraints"?: string[], "inferred"?: boolean',
  '  },',
  '  "outline": {',
  '    "version": 1,',
  '    "beats": [',
  '      {',
  '        "kind": "hook"|"setup"|"conflict"|"development"|"turn"|"resolution"|"cta"|"scene"|"custom",',
  '        "title": string,               // что происходит',
  '        "summary": string,             // 1–2 предложения',
  '        "visual"?: string,             // что в кадре (для social/ad/sketch — промпт клипа)',
  '        "spokenText"?: string,         // закадр/реплика',
  '        "onScreenText"?: string,       // текст на экране',
  '        "durationSeconds"?: number',
  '      }',
  '    ]',
  '  },',
  '  "question"?: string                  // максимум один, только если меняет структуру',
  '}',
  'Не более 100 битов. Пустые необязательные поля просто опускай.',
].join('\n');

/**
 * Assemble the {system, user} pair for one structurization. The playbooks +
 * universal rules + output contract live in the SYSTEM message (stable prefix);
 * the user's raw idea or pasted text is the volatile USER message.
 */
export function buildStructurizePrompt(input: { source: string; kind: StructurizeSourceKind }): {
  system: string;
  user: string;
} {
  const system = [
    'Ты — структуратор замысла в приложении «Вертов · Сценарий». Из сырой идеи или',
    'вставленного текста ты собираешь рабочую структуру для одного из четырёх форматов:',
    'Фильм, Короткое видео, Реклама/бренд, Скетч. Ты НЕ пишешь готовый сценарий —',
    'ты выдаёшь бриф-предположение и упорядоченные биты, которые автор потом правит.',
    '',
    'Сначала определи формат по идее (film/social/ad/sketch), затем применяй правила',
    'ИМЕННО этого формата. Правила — это как отвечать хорошо, а не шаблон для заполнения.',
    '',
    '=== ПЛЕЙБУКИ ФОРМАТОВ ===',
    FORMAT_PLAYBOOKS,
    '',
    '=== ОБЩИЕ ПРАВИЛА ===',
    UNIVERSAL_RULES,
    '',
    '=== ФОРМАТ ОТВЕТА ===',
    OUTPUT_CONTRACT,
  ].join('\n');

  const user =
    input.kind === 'idea'
      ? `Идея пользователя — собери структуру:\n${input.source}`
      : `Готовый текст (Fountain) — определи формат и структурируй его в биты/сцены:\n${input.source}`;

  return { system, user };
}

/** Thrown when model output cannot be coerced into a valid structurize result. */
export class StructurizeSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StructurizeSchemaError';
  }
}

/**
 * Pull the JSON object out of a raw completion: tolerate ```json fences and
 * incidental prose by falling back to the first-`{`…last-`}` slice. Returns the
 * parsed value or throws StructurizeSchemaError (→ the route retries).
 * Shared with the shot planner, which wraps the throw in its own schema error.
 */
export function extractJson(raw: string): unknown {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    return JSON.parse(stripped);
  } catch {
    // Fall through to brace-slice.
  }
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new StructurizeSchemaError('no JSON object in output');
  }
  try {
    return JSON.parse(stripped.slice(start, end + 1));
  } catch (err) {
    throw new StructurizeSchemaError(`unparseable JSON: ${(err as Error).message}`);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new StructurizeSchemaError('output is not an object');
  }
  return value as Record<string, unknown>;
}

function optionalTrimmed(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

function optionalPositiveInt(value: unknown, max: number): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
  const rounded = Math.round(n);
  if (rounded <= 0) return undefined;
  return Math.min(rounded, max);
}

function coerceKind(value: unknown, format: ScenarioFormat): BeatKind {
  if (typeof value === 'string' && BEAT_KIND_SET.has(value)) return value as BeatKind;
  return format === 'film' ? 'scene' : 'custom';
}

/**
 * Normalize a tolerant model object into the canonical result shape, then
 * validate it against the shared strict schemas (the single source of truth for
 * validity). Tolerance is localized here: assign missing beat ids, coerce
 * unknown kinds, drop empty optionals, round durations. Anything the strict
 * schema still rejects throws StructurizeSchemaError so the caller can retry.
 */
export function parseStructurizeOutput(raw: string): ScenarioStructurizeResult {
  const obj = asRecord(extractJson(raw));

  const format = obj.format;
  if (format !== 'film' && format !== 'social' && format !== 'ad' && format !== 'sketch') {
    throw new StructurizeSchemaError(`invalid format: ${String(format)}`);
  }

  const rawBrief =
    obj.brief && typeof obj.brief === 'object' ? (obj.brief as Record<string, unknown>) : {};
  const brief: Record<string, unknown> = { version: 1 };
  const goal = optionalTrimmed(rawBrief.goal, 500);
  if (goal) brief.goal = goal;
  const audience = optionalTrimmed(rawBrief.audience, 500);
  if (audience) brief.audience = audience;
  const platform = optionalTrimmed(rawBrief.platform, 100);
  if (platform) brief.platform = platform;
  const durationSeconds = optionalPositiveInt(rawBrief.durationSeconds, 7_200);
  if (durationSeconds !== undefined) brief.durationSeconds = durationSeconds;
  const tone = optionalTrimmed(rawBrief.tone, 300);
  if (tone) brief.tone = tone;
  const cta = optionalTrimmed(rawBrief.cta, 500);
  if (cta) brief.cta = cta;
  if (Array.isArray(rawBrief.constraints)) {
    const constraints = rawBrief.constraints
      .map((c) => optionalTrimmed(c, 300))
      .filter((c): c is string => Boolean(c))
      .slice(0, 20);
    if (constraints.length) brief.constraints = constraints;
  }
  if (rawBrief.inferred === true) brief.inferred = true;

  const rawOutline =
    obj.outline && typeof obj.outline === 'object' ? (obj.outline as Record<string, unknown>) : {};
  const rawBeats = Array.isArray(rawOutline.beats) ? rawOutline.beats : [];
  const seenIds = new Set<string>();
  const beats = rawBeats.slice(0, 100).map((rawBeat, i) => {
    const b = rawBeat && typeof rawBeat === 'object' ? (rawBeat as Record<string, unknown>) : {};
    let id = optionalTrimmed(b.id, 128);
    if (!id || seenIds.has(id)) id = `beat-${i + 1}`;
    seenIds.add(id);
    const beat: Record<string, unknown> = {
      id,
      kind: coerceKind(b.kind, format),
      title: typeof b.title === 'string' ? b.title.trim().slice(0, 300) : '',
      summary: typeof b.summary === 'string' ? b.summary.trim().slice(0, 4_000) : '',
    };
    const visual = optionalTrimmed(b.visual, 4_000);
    if (visual) beat.visual = visual;
    const spokenText = optionalTrimmed(b.spokenText, 8_000);
    if (spokenText) beat.spokenText = spokenText;
    const onScreenText = optionalTrimmed(b.onScreenText, 2_000);
    if (onScreenText) beat.onScreenText = onScreenText;
    const dur = optionalPositiveInt(b.durationSeconds, 7_200);
    if (dur !== undefined) beat.durationSeconds = dur;
    return beat;
  });

  const candidate: Record<string, unknown> = {
    format,
    brief,
    outline: { version: 1, beats },
  };
  const question = optionalTrimmed(obj.question, 300);
  if (question) candidate.question = question;

  const result = scenarioStructurizeResultSchema.safeParse(candidate);
  if (!result.success) {
    throw new StructurizeSchemaError(result.error.issues.map((issue) => issue.message).join('; '));
  }
  return result.data;
}

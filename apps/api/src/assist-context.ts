import type { ScriptBible, ScriptMaterial, ScriptThreadMessage } from '@seed/db';
import {
  MATERIALS_MAX_CHARS,
  MEMORY_NOTES_MAX_CHARS,
  MATERIAL_SUMMARY_MAX_CHARS,
  MATERIAL_COMPACTION_INPUT_TOKEN_LIMIT,
  CONSPECT_INPUT_TOKEN_LIMIT,
  bibleNotes,
} from '@seed/shared';

/**
 * Assist prompt assembly + thread memory (window + rolling conспект).
 *
 * Pure functions only — no DB, no gateway — so the cache-friendly prompt
 * ORDER and the bounded-memory math are unit-testable without a live call.
 *
 * Cache-friendly ordering (research/archive/scenario-canvas-mvp-goal-2026-07.md §5):
 * the stable prefix comes first, the volatile question last, so provider
 * prompt caches hit across turns of the same project:
 *
 *   библия → materials → scene → conспект → window → question
 *
 * библия + the generic role rules live in the SYSTEM message (the most
 * stable, longest-lived prefix); everything else is the USER message.
 */

/** Verbatim window ceiling: ~3k tokens of recent messages (≈3 chars/token). */
export const WINDOW_MAX_CHARS = 9_000;
/** Rolling-conспект ceiling: keeps per-call cost flat for years-long threads. */
export const CONSPECT_MAX_CHARS = 4_000;

export const SECTION = {
  bible: '=== БИБЛИЯ ПРОЕКТА ===',
  materials: '=== МАТЕРИАЛЫ ПРОЕКТА ===',
  conspect: '=== ПРЕДЫСТОРИЯ ОБСУЖДЕНИЯ ===',
  window: '=== ПОСЛЕДНИЕ СООБЩЕНИЯ ===',
  question: '=== ВОПРОС ===',
} as const;

const BASE_SYSTEM = [
  'Ты — соавтор сценариста в приложении «Вертов · Сценарий». Формат текста — Fountain.',
  'Отвечай на языке вопроса (обычно русский). Держи канон «мира проекта» ниже.',
  'Если просят переписать/сжать/изменить текст — дай ЕДИНСТВЕННЫЙ финальный вариант',
  'реплики/фрагмента внутри тегов <rewrite>…</rewrite> (только заменяемый текст,',
  'без пояснений внутри тегов), а обсуждение — вне тегов. Если это вопрос-обсуждение,',
  'теги не нужны.',
  'Если инструкция ПРАВКИ обобщаема — то есть должна действовать и в будущих сценах',
  '(например «Марк никогда не извиняется», «реплики Лиды всегда короткие») — добавь',
  'ОДНУ строку-формулировку правила в тегах <rule>…</rule> ПОСЛЕ <rewrite>. Не добавляй',
  '<rule> для разовых правок конкретного фрагмента («сделай короче», «убери слово»).',
  'Сомневаешься — не добавляй тег.',
].join('\n');

/**
 * Render МИР ПРОЕКТА (a flat notes list) as a compact block, or '' when empty.
 * МИР ПРОЕКТА is the editor's memory, read every turn, so the block is clamped
 * to `maxChars`: notes are added in author order until the budget is spent and
 * the rest are dropped (the ceiling should rarely bind).
 */
export function bibleBlock(
  bible: ScriptBible | null | undefined,
  maxChars = MEMORY_NOTES_MAX_CHARS,
): string {
  const notes = bibleNotes(bible);
  const lines: string[] = [];
  let used = 0;
  for (const n of notes) {
    const line = `- ${n}`;
    if (lines.length > 0 && used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

/**
 * Render «Материалы проекта» for the prompt. All materials are always in
 * context; the total is bounded server-side by the add-time ceiling, but we
 * hard-clamp here too so a stale/oversized set can never blow the budget.
 * A file's background-compacted `summary` (economy-model, always shorter than
 * the raw text) is injected in place of its `content` when present — this is
 * what keeps the memory cheap to read at scale.
 */
export function materialsBlock(
  materials: Array<
    Pick<ScriptMaterial, 'name' | 'content' | 'summary'> & { includeInAi?: number | boolean }
  >,
): string {
  if (!materials.length) return '';
  let budget = MATERIALS_MAX_CHARS;
  const chunks: string[] = [];
  for (const m of materials) {
    if (m.includeInAi === 0 || m.includeInAi === false) continue;
    if (budget <= 0) break;
    const source = m.summary && m.summary.length > 0 ? m.summary : m.content;
    const content = source.length > budget ? source.slice(0, budget) : source;
    budget -= content.length;
    chunks.push(`— ${m.name} —\n${content}`);
  }
  return chunks.join('\n\n');
}

/**
 * Prompt fed to the economy model to background-compact a МИР ПРОЕКТА file
 * into the editor's memory. Terse, canon-focused, hard length cap — the
 * caller additionally guarantees the result is shorter than the raw text.
 */
export function materialCompactionPrompt(
  name: string,
  raw: string,
  maxChars = MATERIAL_SUMMARY_MAX_CHARS,
): { system: string; user: string } {
  const system = [
    'Ты сжимаешь справочный материал проекта в память редактора-сценариста.',
    'Сохрани только то, что важно для канона истории: персонажей и их голоса,',
    'правила мира, тон, ключевые сюжетные факты, имена и связи. Убери воду,',
    'форматирование, повторы и служебный текст.',
    `Уложись НЕ длиннее ${maxChars} символов. Без markdown, без вступлений и`,
    'без комментариев — только суть, которую редактор должен помнить.',
  ].join('\n');
  const user = `Материал «${name}»:\n${raw}`;
  const systemBytes = utf8Bytes(system);
  const userBudget = Math.max(0, MATERIAL_COMPACTION_INPUT_TOKEN_LIMIT - systemBytes);
  const boundedUser = truncateUtf8(user, userBudget);
  return { system, user: boundedUser };
}

export interface MemoryWindow {
  /** The trailing messages that fit verbatim in the window. */
  window: ScriptThreadMessage[];
  /** Index in `messages` where the window starts (0 = whole thread fits). */
  windowStart: number;
}

/**
 * Take the trailing messages that fit within `maxChars` (always at least the
 * last one). Everything before `windowStart` is a candidate for the conспект.
 */
export function selectWindow(
  messages: ScriptThreadMessage[],
  maxChars = WINDOW_MAX_CHARS,
): MemoryWindow {
  if (messages.length === 0) return { window: [], windowStart: 0 };
  let used = 0;
  let start = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const len = messages[i]!.content.length + 16; // + small role overhead
    if (i < messages.length - 1 && used + len > maxChars) break;
    used += len;
    start = i;
  }
  return { window: messages.slice(start), windowStart: start };
}

/**
 * Conservative pure predicate for the post-success rolling-conspect call.
 * The runtime invokes `refreshConspect` after the user and assistant turns are
 * durable.  Quote time cannot know the exact answer, so it tests the maximum
 * response envelope; if that envelope would evict any message not yet folded
 * into `conspectUpto`, the active workbook `/conspect` row is selected.  The
 * placeholder uses four characters per output token, a safe upper bound for
 * the existing character-based window and intentionally errs toward margin.
 */
export function conspectRefreshRequired(
  messages: ScriptThreadMessage[],
  conspectUpto: number,
  question: string,
  maxOutputTokens: number,
): boolean {
  const maxAnswerChars = Math.max(1, Math.ceil(maxOutputTokens * 4));
  const future: ScriptThreadMessage[] = [
    ...messages,
    { role: 'user', content: question, at: '' },
    { role: 'assistant', content: 'x'.repeat(maxAnswerChars), at: '' },
  ];
  const { windowStart } = selectWindow(future);
  return windowStart > Math.max(0, conspectUpto);
}

const roleLabel = (r: ScriptThreadMessage['role']) => (r === 'user' ? 'Автор' : 'Ассистент');

export const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= maxBytes) return value;
  return new TextDecoder().decode(encoded.slice(0, maxBytes)).replace(/\uFFFD$/u, '');
}

function fitHeadAndTail(value: string, maxBytes: number): string {
  if (utf8Bytes(value) <= maxBytes) return value;
  const separator = '\n… контекст сокращён по финансовому лимиту …\n';
  const separatorBytes = utf8Bytes(separator);
  if (maxBytes <= separatorBytes) return truncateUtf8(value, maxBytes);
  const headBudget = Math.ceil((maxBytes - separatorBytes) * 0.6);
  const tailBudget = maxBytes - separatorBytes - headBudget;
  const encoded = new TextEncoder().encode(value);
  const head = new TextDecoder().decode(encoded.slice(0, headBudget)).replace(/\uFFFD$/u, '');
  const tail = new TextDecoder().decode(encoded.slice(-tailBudget)).replace(/^\uFFFD/u, '');
  return truncateUtf8(`${head}${separator}${tail}`, maxBytes);
}

/**
 * Enforce tokens ≤ UTF-8 bytes before provider egress. The question block is
 * preserved first, then stable system rules, then a head+tail view of context
 * (project facts plus the most recent conversation). This makes the workbook
 * max-input value a physical ceiling even for dense Cyrillic or emoji.
 */
export function fitAssistPromptToInputLimit(
  prompt: { system: string; user: string },
  maxInputTokens: number,
): { system: string; user: string; truncated: boolean } {
  const maxBytes = Math.max(1, Math.floor(maxInputTokens));
  if (utf8Bytes(prompt.system) + utf8Bytes(prompt.user) <= maxBytes) {
    return { ...prompt, truncated: false };
  }

  const questionAt = prompt.user.lastIndexOf(SECTION.question);
  const context = questionAt >= 0 ? prompt.user.slice(0, questionAt).trimEnd() : prompt.user;
  const question = questionAt >= 0 ? prompt.user.slice(questionAt) : '';
  // The question is a hard product input, not lower-priority context. Keep it
  // byte-for-byte whenever it can fit; the API refuses a request whose system
  // rules plus question cannot fit the largest signed envelope rather than
  // silently clipping the user's instruction.
  const questionBytes = utf8Bytes(question);
  const fittedQuestion = questionBytes <= maxBytes ? question : fitHeadAndTail(question, maxBytes);
  const remainingAfterQuestion = maxBytes - utf8Bytes(fittedQuestion);
  const systemBudget = Math.min(utf8Bytes(prompt.system), Math.max(0, remainingAfterQuestion));
  const system = fitHeadAndTail(prompt.system, systemBudget);
  const joiner = fittedQuestion && context ? '\n\n' : '';
  const contextBudget = Math.max(
    0,
    maxBytes - utf8Bytes(system) - utf8Bytes(fittedQuestion) - utf8Bytes(joiner),
  );
  const fittedContext = fitHeadAndTail(context, contextBudget);
  const user = [fittedContext, fittedQuestion].filter(Boolean).join(joiner);
  return {
    system,
    user: truncateUtf8(user, maxBytes - utf8Bytes(system)),
    truncated: true,
  };
}

/** Render the verbatim window as a compact transcript. */
export function windowBlock(window: ScriptThreadMessage[]): string {
  if (!window.length) return '';
  return window.map((m) => `${roleLabel(m.role)}: ${m.content}`).join('\n\n');
}

export interface AssistPromptInput {
  bible: ScriptBible | null | undefined;
  /** Pre-rendered materials block ('' when none). */
  materials: string;
  /** Scene/script context section, already carrying its own === headers ===. */
  sceneBlock: string;
  /** Rolling conспект of older messages ('' when none). */
  conspect: string;
  /** Verbatim recent messages (excluding the current question). */
  window: ScriptThreadMessage[];
  question: string;
}

/**
 * Assemble the {system, user} pair in the fixed cache-friendly order.
 * Empty sections are omitted (but never reordered).
 */
export function assembleAssistPrompt(input: AssistPromptInput): { system: string; user: string } {
  const bible = bibleBlock(input.bible);
  const system = [BASE_SYSTEM, bible ? `\n${SECTION.bible}\n${bible}` : '']
    .filter(Boolean)
    .join('\n');

  const win = windowBlock(input.window);
  const user = [
    input.materials ? `${SECTION.materials}\n${input.materials}` : '',
    input.sceneBlock,
    input.conspect ? `${SECTION.conspect}\n${input.conspect}` : '',
    win ? `${SECTION.window}\n${win}` : '',
    `${SECTION.question}\n${input.question}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  return { system, user };
}

/**
 * Build the prompt fed to the economy model to (re)generate a thread's
 * rolling conспект: fold the previous conспект + the newly-evicted messages
 * into a fresh, bounded summary. Kept terse and factual — it is the thread's
 * long-term memory, not a user-facing artefact.
 */
export function conspectPrompt(
  previous: string,
  evicted: ScriptThreadMessage[],
): { system: string; user: string } {
  const system = [
    'Ты ведёшь краткий конспект длинного обсуждения сценария между автором и ассистентом.',
    `Сожми факты, решения и договорённости в связный конспект НЕ длиннее ${CONSPECT_MAX_CHARS} символов.`,
    'Только суть: что решили, что переписали, какие правила канона всплыли. Без воды и без markdown.',
  ].join('\n');
  const user = [
    previous ? `Прежний конспект:\n${previous}` : 'Прежнего конспекта нет.',
    `Новые сообщения для сворачивания:\n${evicted.map((m) => `${roleLabel(m.role)}: ${m.content}`).join('\n\n')}`,
  ].join('\n\n');
  const systemBytes = utf8Bytes(system);
  const userBudget = Math.max(0, CONSPECT_INPUT_TOKEN_LIMIT - systemBytes);
  const boundedUser = truncateUtf8(user, userBudget);
  return { system, user: boundedUser };
}

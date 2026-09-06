import { SHOT_PLAN_PROMPT_MAX_CHARS } from '@seed/shared/shot-plan';

/**
 * Prompt assembly for «Разложить на кадры» (contract §1–§2). Pure functions
 * only — no DB, no gateway — so the assembled length (which the 413 budget guard
 * and the batch packer both measure) is testable without a live call.
 *
 * The craft rules and the output contract live in the SYSTEM message (the stable
 * prefix a provider cache can hit); the board's dictionary, the project memory
 * and the scenes are the volatile USER message.
 */

/** Author-written camera directions we hand to the model verbatim (§2). */
const CUE_PATTERN = /\b(SMASH CUT|ANGLE ON|PUSH IN|MATCH CUT)\b/giu;

/**
 * Pull the author's explicit camera directions out of a scene. They are free —
 * the author already wrote them — so they are extracted BEFORE the call and
 * echoed back in `cue`, where the substring check (§2) can prove they are the
 * author's words and not the model's invention.
 */
export function extractSceneCues(sourceText: string): string[] {
  const found = sourceText.match(CUE_PATTERN) ?? [];
  return [...new Set(found.map((cue) => cue.toUpperCase()))].slice(0, 8);
}

export interface ShotPlanPromptScene {
  sceneNodeId: string;
  title: string;
  /** Already bounded by the caller (SHOT_PLAN_SCENE_MAX_CHARS bytes). */
  sourceText: string;
}

export interface ShotPlanPromptCastEntry {
  id: string;
  castKind: 'character' | 'location' | 'product';
  name: string;
}

const OUTPUT_CONTRACT = [
  'Верни ТОЛЬКО валидный JSON (без markdown, без ```-ограждений, без пояснений до/после)',
  'строго такой формы:',
  '{',
  '  "scenes": [',
  '    {',
  '      "sceneNodeId": string,          // ДОСЛОВНО из списка сцен ниже',
  '      "complete": boolean,            // false, если сцена не уместилась в лимит кадров',
  '      "shots": [',
  '        {',
  '          "action": string,           // одно снимаемое действие, ≤240 символов',
  `          "prompt": string,           // промпт генерации, ≤${SHOT_PLAN_PROMPT_MAX_CHARS} символов`,
  '          "castNodeIds": string[],    // ≤4 id ПЕРСОНАЖЕЙ и ТОВАРОВ из справочника',
  '          "locationNodeId"?: string,  // id ЛОКАЦИИ из справочника',
  '          "durationSeconds": number,  // целое 1…120',
  '          "dialogue"?: string,        // ДОСЛОВНАЯ подстрока текста сцены, ≤300',
  '          "cue"?: string              // указание автора ДОСЛОВНО, ≤64',
  '        }',
  '      ]',
  '    }',
  '  ]',
  '}',
  'Никаких других полей. Пустые необязательные поля просто опускай.',
].join('\n');

const RULES = [
  'Кадр — это ОДИН непрерывный дубль: одна точка съёмки, одно действие. Новая точка',
  'съёмки или новое действие — новый кадр.',
  'Решай то, чего автор не написал: сколько кадров, где границы, что крупно, что общим,',
  'и текст промпта. Не пересказывай сцену — раскладывай её на съёмочные единицы.',
  '«prompt» пишется для видеомодели: что в кадре, крупность, движение камеры, свет,',
  'без имён файлов и без служебных пометок. Персонажей и товары называй по имени из справочника.',
  '«dialogue» — только если реплика есть в тексте сцены ДОСЛОВНО; иначе поле опусти.',
  '«cue» — только если указание есть в тексте сцены ДОСЛОВНО; иначе поле опусти.',
  'В «castNodeIds» и «locationNodeId» допустимы ТОЛЬКО id из справочника ниже. Не выдумывай id.',
  '«durationSeconds» — редакторская оценка длительности кадра.',
  'Пиши на языке сцены (обычно русский).',
].join('\n');

/**
 * Assemble the {system, user} pair for ONE batch: the project memory and the
 * board dictionary appear ONCE for the whole batch (that is what makes a batch
 * cheaper than N single-scene calls).
 */
export function buildShotPlanPrompt(input: {
  /** «Мир проекта» notes, already clamped to MEMORY_NOTES_MAX_CHARS. */
  memory: string;
  dictionary: readonly ShotPlanPromptCastEntry[];
  scenes: readonly ShotPlanPromptScene[];
  maxShotsPerScene: number;
  /** Schema complaint from the previous attempt — absent on the first (§1). */
  schemaError?: string;
}): { system: string; user: string } {
  const system = [
    'Ты — постановщик в приложении «Вертов». Ты раскладываешь сцену сценария на кадры,',
    'которые можно снять по одному. Ты НЕ переписываешь сценарий и НЕ пересказываешь его.',
    '',
    '=== ПРАВИЛА ===',
    RULES,
    '',
    '=== ФОРМАТ ОТВЕТА ===',
    OUTPUT_CONTRACT,
  ].join('\n');

  const characters = input.dictionary.filter((entry) => entry.castKind === 'character');
  const products = input.dictionary.filter((entry) => entry.castKind === 'product');
  const locations = input.dictionary.filter((entry) => entry.castKind === 'location');
  // Characters and products share «castNodeIds», so the "оставляй пустым"
  // instruction belongs to the pair — emitted by either section alone it would
  // cancel the other one's entries.
  const dictionaryBlock = [
    ...(characters.length
      ? ['Персонажи:', ...characters.map((entry) => `- ${entry.id} — ${entry.name || 'без имени'}`)]
      : []),
    ...(products.length
      ? ['Товары:', ...products.map((entry) => `- ${entry.id} — ${entry.name || 'без имени'}`)]
      : []),
    ...(characters.length || products.length
      ? []
      : ['Персонажей и товаров на борде нет — «castNodeIds» оставляй пустым.']),
    ...(locations.length
      ? ['Локации:', ...locations.map((entry) => `- ${entry.id} — ${entry.name || 'без имени'}`)]
      : ['Локаций на борде нет — «locationNodeId» опускай.']),
  ].join('\n');

  const scenesBlock = input.scenes
    .map((scene) => {
      const cues = extractSceneCues(scene.sourceText);
      return [
        `--- sceneNodeId: ${scene.sceneNodeId} ---`,
        `Заголовок: ${scene.title}`,
        ...(cues.length ? [`Указания автора (верни дословно в «cue»): ${cues.join(', ')}`] : []),
        'Текст сцены:',
        scene.sourceText,
      ].join('\n');
    })
    .join('\n\n');

  const user = [
    input.memory ? `=== МИР ПРОЕКТА ===\n${input.memory}` : '',
    `=== СПРАВОЧНИК МОДУЛЕЙ ДОСКИ ===\n${dictionaryBlock}`,
    `=== ЗАДАЧА ===\nРазложи каждую сцену ниже не более чем на ${input.maxShotsPerScene} кадров.`,
    `=== СЦЕНЫ ===\n${scenesBlock}`,
    input.schemaError
      ? `=== ОШИБКА ПРЕДЫДУЩЕГО ОТВЕТА ===\nОтвет не прошёл проверку: ${input.schemaError}\nВерни исправленный JSON строго по форме выше.`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  return { system, user };
}

import type { ScriptBible, ScriptThreadMessage, ScriptThreadAnchor } from '@seed/db';

/**
 * The seeded «Открыть пример» project (spec §2, path 3): a small, real RU
 * screenplay with a populated МИР ПРОЕКТА and one answered note whose rewrite
 * has already been applied — so a first-time writer sees the whole loop live,
 * never an empty state. One static fixture, checked into the repo.
 */

export const EXAMPLE_TITLE = 'Кинобудка';

/** Note: the МАРК line already carries the APPLIED rewrite (see the thread). */
export const EXAMPLE_FOUNTAIN = [
  'Название: Кинобудка',
  'Автор: Пример Вертова',
  '',
  'ИНТ. КИНОБУДКА - НОЧЬ',
  '',
  '= Марк отказывается сдать плёнку.',
  '',
  'Тесная будка киномеханика. Гудит старый проектор. МАРК (40) заправляет плёнку не глядя.',
  '',
  'МАРК',
  'Плёнка не врёт. Люди врут.',
  '',
  'Луч проектора дрожит. За стеклом — пустой зал.',
  '',
  'НАТ. КРЫША - НОЧЬ',
  '',
  'Ветер гонит старые афиши по крыше. Марк стоит у самого края и смотрит на спящий город.',
  '',
  'МАРК',
  'Ещё один сеанс. И можно гасить.',
  '',
  'ИНТ. ФОЙЕ КИНОТЕАТРА - УТРО',
  '',
  'Пустое фойе. Пыль висит в луче света из окошка кассы.',
  '',
  'КАССИРША',
  '(не поднимая глаз)',
  'Закрыто. Кино кончилось.',
  '',
].join('\n');

export const EXAMPLE_BIBLE: ScriptBible = {
  notes: [
    'МАРК — киномеханик, 40. Врёт только себе. Говорит коротко, глаголами.',
    'Тон: меланхолия, сухой юмор.',
    'Плёнка — метафора памяти: то, что снято, уже не переснять.',
  ],
};

export const EXAMPLE_MATERIAL = {
  name: 'синопсис_v2.docx',
  content: [
    'Логлайн: в последнюю ночь перед сносом кинотеатра стареющий механик',
    'прокручивает фильм, которого нет на плёнке.',
    '',
    'Тема: память нельзя перемотать. Марк цепляется за прошлое, пока город спит.',
  ].join('\n'),
};

/** The one applied «было → станет» note (proposal already reflected in the text). */
export const EXAMPLE_NOTE = {
  before: 'Плёнка не врёт.',
  after: 'Плёнка не врёт. Люди врут.',
  discussion:
    'Добавил вторую фразу — она переворачивает первую и сразу задаёт характер Марка: сухо, парой глаголов.',
};

/** Build the thread messages + anchor once the applied span offset is known. */
export function exampleThread(
  fountain: string,
  now: string,
): { messages: ScriptThreadMessage[]; anchor: ScriptThreadAnchor; status: string } {
  const from = fountain.indexOf(EXAMPLE_NOTE.after);
  const to = from + EXAMPLE_NOTE.after.length;
  const messages: ScriptThreadMessage[] = [
    { role: 'user', content: 'Сделай реплику Марка острее — добавь подтекст.', at: now },
    {
      role: 'assistant',
      content: `${EXAMPLE_NOTE.discussion}\n<rewrite>\n${EXAMPLE_NOTE.after}\n</rewrite>`,
      tier: 'standard',
      proposal: { before: EXAMPLE_NOTE.before, after: EXAMPLE_NOTE.after },
      at: now,
    },
  ];
  return {
    messages,
    anchor: { from, to, rev: 0, quote: EXAMPLE_NOTE.after },
    status: 'applied',
  };
}

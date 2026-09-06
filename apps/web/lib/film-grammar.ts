/**
 * Film grammar for storyboard shot cards. A shot is not a bare prompt — it
 * carries a shot size, camera move(s), lens, and (B-4) light, colour
 * temperature, genre, and motion energy. We surface these as director's
 * controls (no typing), weave them into the generation prompt in natural
 * Russian so they actually steer Seedance, and emit a structured metadata
 * object for future provider routing.
 *
 * Pure data + string building; no I/O.
 */

export interface ShotGrammar {
  /** Shot size — общий / средний / крупный / деталь / дальний. */
  size?: string | undefined;
  /** Single camera move (legacy / single-pick). Superseded by `moves`. */
  move?: string | undefined;
  /** B-4: stacked camera/motion moves (up to MAX_MOVES). */
  moves?: string[] | undefined;
  /** Lens — 24 / 35 / 50 / 85 mm (optional; '' = unset). */
  lens?: string | undefined;
  /** B-4: lighting style. */
  light?: string | undefined;
  /** B-4: colour temperature — warm / neutral / cool. */
  colorTemp?: string | undefined;
  /** B-4: genre / mood. */
  genre?: string | undefined;
  /** B-4: motion energy / pacing. */
  energy?: string | undefined;
}

interface Opt {
  /** Stored key. */
  id: string;
  /** Short chip label. */
  label: string;
  /** Russian prompt fragment woven into the generation prompt. */
  frag: string;
}

export const SHOT_SIZES: Opt[] = [
  { id: 'ews', label: 'Дальний', frag: 'дальний установочный план' },
  { id: 'ws', label: 'Общий', frag: 'общий план' },
  { id: 'ms', label: 'Средний', frag: 'средний план' },
  { id: 'cu', label: 'Крупный', frag: 'крупный план' },
  { id: 'ecu', label: 'Деталь', frag: 'макро-деталь, очень крупно' },
];

export const SHOT_MOVES: Opt[] = [
  { id: 'static', label: 'Статика', frag: 'камера неподвижна, штатив' },
  { id: 'push', label: 'Наезд', frag: 'медленный наезд камеры' },
  { id: 'pull', label: 'Отъезд', frag: 'медленный отъезд камеры' },
  { id: 'pan', label: 'Панорама', frag: 'плавная панорама' },
  { id: 'track', label: 'Проводка', frag: 'проводка камеры за движением' },
  { id: 'crane', label: 'Кран', frag: 'кран — камера идёт вверх' },
  { id: 'handheld', label: 'С рук', frag: 'камера с рук, лёгкая дрожь' },
];

export const SHOT_LENSES: Opt[] = [
  { id: '24', label: '24мм', frag: 'широкий объектив 24мм' },
  { id: '35', label: '35мм', frag: 'объектив 35мм' },
  { id: '50', label: '50мм', frag: 'объектив 50мм, естественная перспектива' },
  { id: '85', label: '85мм', frag: 'портретный объектив 85мм, малая глубина резкости' },
];

export const SHOT_LIGHT: Opt[] = [
  { id: 'soft', label: 'Мягкий', frag: 'мягкий рассеянный свет' },
  { id: 'hard', label: 'Жёсткий', frag: 'жёсткий направленный свет, контрастные тени' },
  { id: 'golden', label: 'Золотой час', frag: 'тёплый свет золотого часа' },
  { id: 'night', label: 'Ночь', frag: 'ночная сцена, низкий ключ' },
  { id: 'neon', label: 'Неон', frag: 'неоновая подсветка, цветные блики' },
  { id: 'backlit', label: 'Контровой', frag: 'контровой свет, силуэт' },
];

export const SHOT_COLOR_TEMP: Opt[] = [
  { id: 'warm', label: 'Тёплый', frag: 'тёплая цветовая температура' },
  { id: 'neutral', label: 'Нейтр.', frag: 'нейтральный баланс белого' },
  { id: 'cool', label: 'Холодный', frag: 'холодная цветовая температура' },
];

export const SHOT_GENRE: Opt[] = [
  { id: 'doc', label: 'Док', frag: 'документальная подача' },
  { id: 'noir', label: 'Нуар', frag: 'нуар, высокий контраст, глубокие тени' },
  { id: 'thriller', label: 'Триллер', frag: 'напряжённая триллер-атмосфера' },
  { id: 'romance', label: 'Романтика', frag: 'мягкая романтическая атмосфера' },
  { id: 'action', label: 'Экшн', frag: 'динамичный экшн-кадр' },
  { id: 'scifi', label: 'Sci-fi', frag: 'научно-фантастическая эстетика' },
];

export const SHOT_ENERGY: Opt[] = [
  { id: 'calm', label: 'Спокойно', frag: 'спокойный, медленный темп' },
  { id: 'med', label: 'Средне', frag: 'умеренная динамика' },
  { id: 'high', label: 'Энергично', frag: 'высокая энергия, быстрый темп' },
];

/** Max stacked camera/motion moves per shot (B-4). */
export const MAX_MOVES = 3;

/** Add/remove a move from the stack, capped at MAX_MOVES (pure; for the UI). */
export function toggleMove(moves: string[] | undefined, id: string): string[] {
  const cur = moves ?? [];
  if (cur.includes(id)) return cur.filter((m) => m !== id);
  if (cur.length >= MAX_MOVES) return cur; // full — ignore (UI shows the cap)
  return [...cur, id];
}

/** The effective move stack (new `moves`, falling back to legacy single `move`). */
export function effectiveMoves(g: ShotGrammar | undefined): string[] {
  if (g?.moves && g.moves.length) return g.moves.slice(0, MAX_MOVES);
  return g?.move ? [g.move] : [];
}

function fragOf(opts: Opt[], id: string | undefined): string | null {
  if (!id) return null;
  return opts.find((o) => o.id === id)?.frag ?? null;
}

/** A compact, human label for the card chips (e.g. «Общий · 50мм · Наезд · Неон»). */
export function shotGrammarLabel(g: ShotGrammar | undefined): string {
  if (!g) return '';
  const parts = [
    SHOT_SIZES.find((o) => o.id === g.size)?.label,
    SHOT_LENSES.find((o) => o.id === g.lens)?.label,
    ...effectiveMoves(g).map((m) => SHOT_MOVES.find((o) => o.id === m)?.label),
    SHOT_LIGHT.find((o) => o.id === g.light)?.label,
    SHOT_COLOR_TEMP.find((o) => o.id === g.colorTemp)?.label,
    SHOT_GENRE.find((o) => o.id === g.genre)?.label,
    SHOT_ENERGY.find((o) => o.id === g.energy)?.label,
  ].filter(Boolean);
  return parts.join(' · ');
}

/**
 * Structured grammar metadata for the job params (B-4) — the raw ids, so the
 * provider router can act on them later without re-parsing the prompt. Omits
 * unset dimensions; returns null when nothing is set.
 */
export function shotGrammarMetadata(
  g: ShotGrammar | undefined,
): Record<string, string | string[]> | null {
  if (!g) return null;
  const out: Record<string, string | string[]> = {};
  if (g.size) out['size'] = g.size;
  if (g.lens) out['lens'] = g.lens;
  const moves = effectiveMoves(g);
  if (moves.length) out['moves'] = moves;
  if (g.light) out['light'] = g.light;
  if (g.colorTemp) out['colorTemp'] = g.colorTemp;
  if (g.genre) out['genre'] = g.genre;
  if (g.energy) out['energy'] = g.energy;
  return Object.keys(out).length ? out : null;
}

/**
 * Build the effective generation prompt: the camera grammar leads (so the
 * model frames before it paints), then the scene's continuity look, then the
 * shot's own description. Empty pieces are dropped.
 */
export function buildShotPrompt(opts: {
  grammar?: ShotGrammar | undefined;
  look?: string | undefined;
  text: string;
}): string {
  const g = opts.grammar;
  const cam = [
    fragOf(SHOT_SIZES, g?.size),
    fragOf(SHOT_LENSES, g?.lens),
    ...effectiveMoves(g).map((m) => fragOf(SHOT_MOVES, m)),
    fragOf(SHOT_LIGHT, g?.light),
    fragOf(SHOT_COLOR_TEMP, g?.colorTemp),
    fragOf(SHOT_GENRE, g?.genre),
    fragOf(SHOT_ENERGY, g?.energy),
  ].filter((x): x is string => Boolean(x));
  const lead = cam.length ? cam.join(', ') + '. ' : '';
  const look = opts.look?.trim() ? opts.look.trim().replace(/\.?\s*$/, '. ') : '';
  return `${lead}${look}${opts.text.trim()}`.trim();
}

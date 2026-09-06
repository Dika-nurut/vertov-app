// Pure Fountain line classification + Tab-cycle transforms — no CodeMirror,
// so it's importable from plain modules (the СОДЕРЖАНИЕ navigator) and unit
// tests. The canonical parse (@seed/screenplay) still governs export and page
// counts; this is the live, per-line client mirror.

export type SpClass =
  | 'scene'
  | 'character'
  | 'paren'
  | 'dialogue'
  | 'transition'
  | 'section'
  | 'synopsis'
  | 'action';

const FORCED_SCENE_RE = /^\s*\.[^.].*$/;
const PREFIXED_SCENE_RE =
  /^\s*(?:INT\.?\/EXT|INT\/EXT|EXT\.?\/INT|EXT\/INT|INT|EXT|EST|I\/E|ИНТ\.?\/НАТ|ИНТ\/НАТ|НАТ\.?\/ИНТ|НАТ\/ИНТ|ИНТ|НАТ|ПАВ|ЭКСТ)[. ].*$/i;
export const SCENE_RE = new RegExp(
  `(?:${FORCED_SCENE_RE.source})|(?:${PREFIXED_SCENE_RE.source})`,
  'i',
);
const TRANSITION_RE = /^\s*(>.*|.*(TO:|ПЕРЕХОД:|НАРЕЗКА:|CUT TO:))\s*$/;

/** Is this line all-caps (letters uppercase), i.e. a possible character cue? */
export function isUpperCue(line: string): boolean {
  const t = line.trim();
  if (!t || t.length > 60) return false;
  const letters = t.replace(/[^\p{L}]/gu, '');
  if (letters.length === 0) return false;
  return letters === letters.toUpperCase() && letters !== letters.toLowerCase();
}

/** Classify every line of the document, using the block context above. */
export function classifyLines(text: string): SpClass[] {
  const lines = text.split('\n');
  const out: SpClass[] = new Array(lines.length);
  // Are we inside a dialogue block (after a character/parenthetical line)?
  let inDialogue = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    const prevBlank = i === 0 || lines[i - 1]!.trim() === '';

    if (trimmed === '') {
      out[i] = 'action';
      inDialogue = false;
      continue;
    }
    if (trimmed.startsWith('#')) {
      out[i] = 'section';
      inDialogue = false;
      continue;
    }
    if (trimmed.startsWith('=')) {
      out[i] = 'synopsis';
      inDialogue = false;
      continue;
    }
    if (FORCED_SCENE_RE.test(line) || (prevBlank && PREFIXED_SCENE_RE.test(line))) {
      out[i] = 'scene';
      inDialogue = false;
      continue;
    }
    if (TRANSITION_RE.test(line) && (isUpperCue(line) || line.trim().startsWith('>'))) {
      out[i] = 'transition';
      inDialogue = false;
      continue;
    }
    if (inDialogue) {
      out[i] = /^\s*\(.*\)?\s*$/.test(line) ? 'paren' : 'dialogue';
      continue;
    }
    // A character cue: an all-caps line with a blank line above and a
    // non-blank line below (the dialogue).
    const nextNonBlank = i + 1 < lines.length && lines[i + 1]!.trim() !== '';
    if (prevBlank && nextNonBlank && (isUpperCue(line) || trimmed.startsWith('@'))) {
      out[i] = 'character';
      inDialogue = true;
      continue;
    }
    out[i] = 'action';
  }
  return out;
}

// ---- Tab element cycling (client mirror of @seed/screenplay element-cycle) ----
// Parser-guarded in the screenplay package (element-cycle.test.ts); any line
// this produces round-trips losslessly through the server parser.

/** The visible Tab cycle: действие → персонаж → реплика → ремарка → переход → сцена → … */
export const SP_CYCLE: SpClass[] = [
  'action',
  'character',
  'dialogue',
  'paren',
  'transition',
  'scene',
];

/** Short RU labels for the element ribbon chip. */
export const SP_LABEL_RU: Record<SpClass, string> = {
  scene: 'СЦЕНА',
  action: 'ДЕЙСТВИЕ',
  character: 'ПЕРСОНАЖ',
  dialogue: 'РЕПЛИКА',
  paren: 'РЕМАРКА',
  transition: 'ПЕРЕХОД',
  section: 'РАЗДЕЛ',
  synopsis: 'СИНОПСИС',
};

/** The element following `cls` in the Tab cycle (wraps; off-cycle → action). */
export function nextSpElement(cls: SpClass): SpClass {
  const i = SP_CYCLE.indexOf(cls);
  if (i === -1) return 'action';
  return SP_CYCLE[(i + 1) % SP_CYCLE.length]!;
}

/** Strip any forced marker / wrapper, leaving the bare semantic text. */
export function bareLineText(line: string): string {
  let t = line.trim();
  if (t.startsWith('(') && t.endsWith(')') && t.length >= 2) t = t.slice(1, -1).trim();
  if (t.startsWith('@')) t = t.slice(1);
  else if (t.startsWith('!')) t = t.slice(1);
  else if (t.startsWith('~')) t = t.slice(1);
  else if (t.startsWith('>')) t = t.replace(/^>\s?/, '').replace(/\s?<$/, '');
  else if (t.startsWith('.') && !t.startsWith('..')) t = t.slice(1);
  t = t.replace(/\s*\^$/, '');
  return t.trim();
}

function bareAutoClassifies(bare: string): boolean {
  if (bare === '') return false;
  if (/^[.!@~>#=([]/.test(bare)) return true;
  if (SCENE_RE.test(bare)) return true;
  if (isUpperCue(bare)) return true;
  if (/\bTO:$/.test(bare)) return true;
  return false;
}

/** Rewrite `line` so it classifies as `target`, keeping its bare text. */
export function setSpElement(line: string, target: SpClass): string {
  const bare = bareLineText(line);
  switch (target) {
    case 'scene':
      return `.${bare}`;
    case 'character':
      return `@${bare}`;
    case 'transition':
      return `> ${bare}`;
    case 'paren':
      return `(${bare})`;
    case 'dialogue':
      return bare;
    default:
      return bareAutoClassifies(bare) ? `!${bare}` : bare;
  }
}

/**
 * Character cues in the text (pure parser, zero cost) — for the suggestion
 * engine's «новое имя» trigger. Returns each unique cue name with the 1-based
 * scene it first appears in. Extensions like «(ЗК)» / «(V.O.)» are stripped.
 */
export function characterCues(text: string): { name: string; scene: number }[] {
  const lines = text.split('\n');
  const classes = classifyLines(text);
  const seen = new Map<string, number>();
  let scene = 0;
  for (let i = 0; i < lines.length; i++) {
    if (classes[i] === 'scene') scene += 1;
    if (classes[i] === 'character') {
      const name = bareLineText(lines[i]!)
        .replace(/\s*\([^)]*\)\s*$/, '')
        .trim()
        .toUpperCase();
      if (name && !seen.has(name)) seen.set(name, Math.max(1, scene));
    }
  }
  return [...seen].map(([name, s]) => ({ name, scene: s }));
}

/**
 * The cycle position a line is currently at. Forced markers name the element
 * unambiguously (a lone `@МАРК` IS a character even with no dialogue under it);
 * otherwise fall back to the contextual classifier.
 */
export function markerElement(lineText: string, contextual: SpClass): SpClass {
  const t = lineText.trim();
  if (t.startsWith('@')) return 'character';
  if (t.startsWith('>')) return 'transition';
  if (t.startsWith('.') && !t.startsWith('..')) return 'scene';
  if (t.startsWith('(') && t.endsWith(')')) return 'paren';
  return contextual;
}

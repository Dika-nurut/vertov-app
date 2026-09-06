import type { FountainElement, ScreenplayDoc, TitlePageEntry } from '../model.js';
import { SCENE_HEADING_RE, isAllUpper } from './rules.js';

/** Title-page keys that may START a document (Fountain + RU equivalents). */
const KNOWN_TITLE_KEYS = new Set(
  [
    'title',
    'credit',
    'author',
    'authors',
    'source',
    'contact',
    'draft date',
    'date',
    'notes',
    'copyright',
    'revision',
    'название',
    'автор',
    'авторы',
    'источник',
    'контакт',
    'дата',
    'черновик',
    'заметки',
    'версия',
  ].map((k) => k.toLowerCase()),
);

const TITLE_KEY_RE = /^([^:\t]+?):(.*)$/;
const SCENE_NUMBER_RE = /#([^#\s][^#]*)#\s*$/;

function clean(rawLine: string): string {
  return rawLine.replace(/\r$/, '');
}

function isBlank(rawLine: string): boolean {
  return clean(rawLine).trim() === '';
}

export function parseFountain(source: string): ScreenplayDoc {
  const lines = source.split('\n');
  const titlePage: TitlePageEntry[] = [];
  const elements: FountainElement[] = [];
  let i = 0;

  // ---- Title page: only if the very first line is a known key. ----
  const firstMatch = lines.length > 0 ? TITLE_KEY_RE.exec(clean(lines[0]!)) : null;
  if (firstMatch && KNOWN_TITLE_KEYS.has(firstMatch[1]!.trim().toLowerCase())) {
    while (i < lines.length && !isBlank(lines[i]!)) {
      const line = clean(lines[i]!);
      const keyMatch = /^\t|^ {3,}/.test(line) ? null : TITLE_KEY_RE.exec(line);
      if (keyMatch) {
        const inline = keyMatch[2]!.trim();
        titlePage.push({
          key: keyMatch[1]!.trim(),
          values: inline === '' ? [] : [inline],
          raw: [lines[i]!],
        });
      } else {
        const entry = titlePage[titlePage.length - 1];
        if (!entry) break; // continuation with no key — not a title page line
        entry.raw.push(lines[i]!);
        const value = line.trim();
        if (value !== '') entry.values.push(value);
      }
      i++;
    }
  }

  // ---- Body ----
  let prevBlank = true; // start of body behaves like "after a blank line"
  let inDialogue = false;

  const push = (el: FountainElement) => {
    elements.push(el);
    prevBlank = el.type === 'blank';
    if (el.type !== 'dialogue' && el.type !== 'parenthetical') {
      inDialogue = el.type === 'character';
    }
  };

  const nextIsBlank = (idx: number): boolean => idx + 1 >= lines.length || isBlank(lines[idx + 1]!);

  while (i < lines.length) {
    const raw = lines[i]!;
    const line = clean(raw);
    const t = line.trim();

    // Blank line — but a whitespace-only NON-empty line inside a dialogue
    // block is Fountain's "blank line within dialogue" idiom.
    if (t === '') {
      if (inDialogue && line.length > 0) {
        push({ type: 'dialogue', raw: [raw], text: '' });
        inDialogue = true;
      } else {
        push({ type: 'blank', raw: [raw], text: '' });
      }
      i++;
      continue;
    }

    // Boneyard block: /* … */ possibly spanning lines.
    if (t.startsWith('/*')) {
      const block: string[] = [];
      let j = i;
      let closed = false;
      while (j < lines.length) {
        block.push(lines[j]!);
        if (clean(lines[j]!).includes('*/')) {
          closed = true;
          break;
        }
        j++;
      }
      if (closed) {
        push({
          type: 'boneyard',
          raw: block,
          text: block.map(clean).join('\n'),
        });
        i = j + 1;
        continue;
      }
      // Unclosed boneyard: fall through, treat as text.
    }

    // Page break: a line of 3+ '='.
    if (/^={3,}\s*$/.test(t)) {
      push({ type: 'page_break', raw: [raw], text: '' });
      i++;
      continue;
    }

    // Section: leading '#'.
    if (t.startsWith('#')) {
      const depth = t.match(/^#+/)![0].length;
      push({
        type: 'section',
        raw: [raw],
        text: t.slice(depth).trim(),
        depth,
      });
      i++;
      continue;
    }

    // Synopsis: leading single '='.
    if (t.startsWith('=')) {
      push({ type: 'synopsis', raw: [raw], text: t.slice(1).trim() });
      i++;
      continue;
    }

    // Standalone note block: [[ … ]] (possibly multi-line, ends before blank).
    if (t.startsWith('[[')) {
      const block: string[] = [];
      let j = i;
      let closed = false;
      while (j < lines.length && !isBlank(lines[j]!)) {
        block.push(lines[j]!);
        if (clean(lines[j]!).trimEnd().endsWith(']]')) {
          closed = true;
          break;
        }
        j++;
      }
      if (closed) {
        const text = block.map((l) => clean(l).trim()).join('\n');
        push({
          type: 'note',
          raw: block,
          text: text.replace(/^\[\[/, '').replace(/\]\]$/, '').trim(),
        });
        i = j + 1;
        continue;
      }
      // Unclosed note: fall through, treat as text.
    }

    // Inside a dialogue block every non-blank line is dialogue/parenthetical.
    if (inDialogue) {
      if (t.startsWith('(') && t.endsWith(')')) {
        push({ type: 'parenthetical', raw: [raw], text: t });
      } else {
        push({ type: 'dialogue', raw: [raw], text: t });
      }
      i++;
      continue;
    }

    // Forced elements.
    if (t.startsWith('!')) {
      // Forced action owns its whole paragraph (until a blank line), like
      // unforced action — otherwise import round-trips split paragraphs.
      const block: string[] = [raw];
      let j = i + 1;
      while (j < lines.length) {
        const nt = clean(lines[j]!).trim();
        if (nt === '' || /^(\/\*|={3,}\s*$|#|=|\[\[)/.test(nt)) break;
        block.push(lines[j]!);
        j++;
      }
      const texts = block.map((l) => clean(l).trimEnd());
      texts[0] = texts[0]!.trimStart().slice(1);
      push({ type: 'action', raw: block, text: texts.join('\n'), forced: true });
      i = j;
      continue;
    }
    if (t.startsWith('@')) {
      const dual = t.endsWith('^');
      const name = t.slice(1, dual ? -1 : undefined).trim();
      push({
        type: 'character',
        raw: [raw],
        text: name,
        forced: true,
        ...(dual ? { dual: true } : {}),
      });
      i++;
      continue;
    }
    if (t.startsWith('~')) {
      push({ type: 'lyrics', raw: [raw], text: t.slice(1).trim(), forced: true });
      i++;
      continue;
    }
    if (t.startsWith('>') && t.endsWith('<') && t.length > 1) {
      push({
        type: 'centered',
        raw: [raw],
        text: t.slice(1, -1).trim(),
        forced: true,
      });
      i++;
      continue;
    }
    if (t.startsWith('>')) {
      push({
        type: 'transition',
        raw: [raw],
        text: t.slice(1).trim(),
        forced: true,
      });
      i++;
      continue;
    }
    if (t.startsWith('.') && !t.startsWith('..')) {
      const numMatch = SCENE_NUMBER_RE.exec(t);
      push({
        type: 'scene_heading',
        raw: [raw],
        text: (numMatch ? t.slice(0, numMatch.index) : t).slice(1).trim(),
        forced: true,
        ...(numMatch ? { sceneNumber: numMatch[1]! } : {}),
      });
      i++;
      continue;
    }

    // A prefixed scene heading starts a new block. The following action may
    // begin immediately on the next line, as it does while typing in Scenario.
    if (prevBlank && SCENE_HEADING_RE.test(t)) {
      const numMatch = SCENE_NUMBER_RE.exec(t);
      push({
        type: 'scene_heading',
        raw: [raw],
        text: (numMatch ? t.slice(0, numMatch.index) : t).trim(),
        ...(numMatch ? { sceneNumber: numMatch[1]! } : {}),
      });
      i++;
      continue;
    }

    // Transition: uppercase, ends with TO:, blank line before and after.
    if (prevBlank && nextIsBlank(i) && isAllUpper(t) && t.endsWith('TO:')) {
      push({ type: 'transition', raw: [raw], text: t });
      i++;
      continue;
    }

    // Character: uppercase, blank before, NON-blank after (else it's action).
    if (prevBlank && !nextIsBlank(i) && isAllUpper(t)) {
      const dual = t.endsWith('^');
      const name = dual ? t.slice(0, -1).trim() : t;
      push({
        type: 'character',
        raw: [raw],
        text: name,
        ...(dual ? { dual: true } : {}),
      });
      i++;
      continue;
    }

    // Action: merge consecutive non-blank lines that don't classify as
    // anything else into one paragraph element.
    const block: string[] = [raw];
    let j = i + 1;
    while (j < lines.length) {
      const nt = clean(lines[j]!).trim();
      if (nt === '') break;
      // stop before lines that open a new construct on their own
      if (/^(\/\*|={3,}\s*$|#|=|\[\[)/.test(nt)) break;
      block.push(lines[j]!);
      j++;
    }
    push({
      type: 'action',
      raw: block,
      text: block.map((l) => clean(l).trimEnd()).join('\n'),
    });
    i = j;
  }

  return { titlePage, elements };
}

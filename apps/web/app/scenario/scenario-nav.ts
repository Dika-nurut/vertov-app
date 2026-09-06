import { classifyLines, type SpClass } from './fountain-classify';

/**
 * Client-side СОДЕРЖАНИЕ model: scenes with char-offset ranges, synopsis
 * («=» line), and a running-time estimate. Recomputed live from the editor
 * text (no server round-trip per keystroke). A light mirror of the canonical
 * @seed/screenplay `estimate.ts`/`sceneList` — durations are estimates.
 */

const CPI = 10;
const LINES_PER_PAGE = 55;
const WRAP: Partial<Record<SpClass, number>> = {
  scene: 6 * CPI,
  action: 6 * CPI,
  transition: 6 * CPI,
  character: 3.3 * CPI,
  paren: 2.4 * CPI,
  dialogue: 3.5 * CPI,
};
const LEAD: Partial<Record<SpClass, number>> = {
  scene: 1,
  action: 1,
  character: 1,
  transition: 1,
};

function lineUnits(cls: SpClass, text: string): number {
  if (cls === 'section' || cls === 'synopsis') return 0;
  const len = text.trim().length;
  const wrap = WRAP[cls] ?? 6 * CPI;
  const wrapped = len === 0 ? 1 : Math.ceil(len / wrap);
  return wrapped + (LEAD[cls] ?? 0);
}

/** Format a page fraction as «M:SS» (one page ≈ one minute). */
export function formatTiming(pages: number): string {
  const seconds = Math.round(pages * 60);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export interface SceneNavItem {
  index: number;
  heading: string;
  /** Char offset of the scene heading line start. */
  from: number;
  /** Char offset at the end of the heading line (where a synopsis line inserts). */
  headingEnd: number;
  /** Char offset where the next scene starts (or end of doc). */
  to: number;
  synopsis: string | null;
  duration: string;
}

/** Build the scene navigator from the editor text. */
export function buildSceneNav(text: string): SceneNavItem[] {
  const lines = text.split('\n');
  const classes = classifyLines(text);
  const scenes: SceneNavItem[] = [];
  let offset = 0;
  let units = 0;
  const closeLast = (endOffset: number) => {
    const last = scenes[scenes.length - 1];
    if (last) {
      last.to = endOffset;
      last.duration = formatTiming(units / LINES_PER_PAGE);
    }
    units = 0;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const cls = classes[i] ?? 'action';
    if (cls === 'scene') {
      closeLast(offset);
      const raw = line.trim();
      const heading = (raw.startsWith('.') && !raw.startsWith('..') ? raw.slice(1) : raw).trim();
      scenes.push({
        index: scenes.length + 1,
        heading,
        from: offset,
        headingEnd: offset + line.length,
        to: offset,
        synopsis: null,
        duration: '0:00',
      });
    } else if (cls === 'synopsis' && scenes.length > 0) {
      const s = scenes[scenes.length - 1]!;
      if (s.synopsis === null) s.synopsis = line.trim().replace(/^=\s?/, '').trim();
    }
    if (scenes.length > 0) units += lineUnits(cls, line);
    offset += line.length + 1; // + newline
  }
  closeLast(offset);
  return scenes;
}

/**
 * Move the scene block at 1-based `fromIndex` to `toIndex`, restructuring the
 * text with clean scene separation. Returns the new text (apply it as an
 * undoable editor edit). No-op for invalid / equal indices.
 */
export function moveScene(text: string, fromIndex: number, toIndex: number): string {
  const scenes = buildSceneNav(text);
  const n = scenes.length;
  if (fromIndex < 1 || fromIndex > n || toIndex < 1 || toIndex > n || fromIndex === toIndex) {
    return text;
  }
  const preambleRaw = text.slice(0, scenes[0]!.from);
  const blocks = scenes.map((s) => text.slice(s.from, s.to).replace(/\n+$/, ''));
  const [moved] = blocks.splice(fromIndex - 1, 1);
  blocks.splice(toIndex - 1, 0, moved!);
  const preamble = preambleRaw.replace(/\n+$/, '');
  const body = blocks.join('\n\n');
  const trailing = /\n$/.test(text) ? '\n' : '';
  return (preamble ? `${preamble}\n\n` : '') + body + trailing;
}

/** Index (1-based) of the scene containing `caret`, or 0 if none. */
export function sceneAtOffset(scenes: SceneNavItem[], caret: number): number {
  for (const s of scenes) {
    if (caret >= s.from && caret < s.to) return s.index;
  }
  // Caret past the last scene → the last scene.
  return scenes.length > 0 && caret >= scenes[scenes.length - 1]!.from
    ? scenes[scenes.length - 1]!.index
    : 0;
}

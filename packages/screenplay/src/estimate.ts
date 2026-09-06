import { parseFountain } from './fountain/parse.js';
import { stripInline } from './fountain/inline.js';
import type { ElementType, ScreenplayDoc } from './model.js';

/**
 * Page / running-time estimation for the screenplay canvas.
 *
 * Mirrors the typeset PDF layout (`export/pdf.ts`): 12pt Courier at 10
 * characters-per-inch, element-specific column widths, ~55 typeset lines to
 * an A4 body page, and the screenwriting rule of thumb that one page ≈ one
 * minute of screen time. Deterministic and pure so the СОДЕРЖАНИЕ durations
 * `(1:10)` and the list-card `24 стр` are unit-testable without rendering a
 * PDF. It is an ESTIMATE — good enough to size scenes and pace a draft, not a
 * production page count.
 */

const CPI = 10; // characters per inch, 12pt Courier
const LINES_PER_PAGE = 55; // typeset body lines on an A4 page at 6 lines/inch

/** Column width (in characters) each element type wraps at — from the PDF layout. */
const WRAP_CHARS: Partial<Record<ElementType, number>> = {
  scene_heading: 6 * CPI,
  action: 6 * CPI,
  centered: 6 * CPI,
  transition: 6 * CPI,
  character: 3.3 * CPI,
  parenthetical: 2.4 * CPI,
  dialogue: 3.5 * CPI,
  lyrics: 3.5 * CPI,
};

/** Typeset lines a single element occupies (wrapped to its column + lead blank). */
function elementLines(type: ElementType, text: string): number {
  // Editorial-only elements are not typeset (see pdf.ts default branch).
  if (type === 'section' || type === 'synopsis' || type === 'note' || type === 'boneyard') return 0;
  if (type === 'blank') return 0; // spacing is added as a lead before blocks
  if (type === 'page_break') return LINES_PER_PAGE; // forces the rest to a new page
  const width = WRAP_CHARS[type] ?? 6 * CPI;
  const clean = stripInline(text);
  let lines = 0;
  for (const raw of clean.split('\n')) {
    const len = raw.trimEnd().length;
    lines += len === 0 ? 1 : Math.ceil(len / width);
  }
  // A one-line lead of whitespace precedes each block that opens after body
  // starts (scene headings, characters, action paragraphs, transitions).
  const leads: Partial<Record<ElementType, number>> = {
    scene_heading: 1,
    action: 1,
    character: 1,
    transition: 1,
    centered: 1,
  };
  return lines + (leads[type] ?? 0);
}

export interface SceneTiming {
  /** 1-based scene number in document order. */
  index: number;
  heading: string;
  /** Estimated page fraction the scene occupies. */
  pages: number;
  /** Human running time «M:SS» at one page ≈ one minute. */
  duration: string;
}

/** Format a page fraction as a running time «M:SS» (one page ≈ one minute). */
export function formatTiming(pages: number): string {
  const seconds = Math.round(pages * 60);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Per-scene page + running-time estimates, aligned to `sceneList` order. */
export function sceneTimings(fountainOrDoc: string | ScreenplayDoc): SceneTiming[] {
  const doc = typeof fountainOrDoc === 'string' ? parseFountain(fountainOrDoc) : fountainOrDoc;
  const scenes: SceneTiming[] = [];
  let currentLines = 0;
  const flush = () => {
    if (scenes.length === 0) return;
    const last = scenes[scenes.length - 1]!;
    last.pages = currentLines / LINES_PER_PAGE;
    last.duration = formatTiming(last.pages);
    currentLines = 0;
  };
  for (const el of doc.elements) {
    if (el.type === 'scene_heading') {
      flush();
      scenes.push({
        index: scenes.length + 1,
        heading: stripInline(el.text),
        pages: 0,
        duration: '0:00',
      });
    }
    if (scenes.length > 0) currentLines += elementLines(el.type, el.text);
  }
  flush();
  return scenes;
}

export interface ScriptStats {
  /** Whole-script page estimate (rounded up; 0 only for an empty script). */
  pages: number;
  /** Number of scene headings. */
  scenes: number;
  /** First scene heading in document order (drives the auto-title), or null. */
  firstScene: string | null;
  /** Last scene heading in document order, or null when there are none. */
  lastScene: string | null;
}

/** Whole-script summary for the list-card meta line («24 стр · сцена 12»). */
export function scriptStats(fountainOrDoc: string | ScreenplayDoc): ScriptStats {
  const doc = typeof fountainOrDoc === 'string' ? parseFountain(fountainOrDoc) : fountainOrDoc;
  let totalLines = 0;
  let scenes = 0;
  let firstScene: string | null = null;
  let lastScene: string | null = null;
  for (const el of doc.elements) {
    if (el.type === 'scene_heading') {
      scenes += 1;
      lastScene = stripInline(el.text);
      if (firstScene === null) firstScene = lastScene;
    }
    totalLines += elementLines(el.type, el.text);
  }
  const pages = totalLines === 0 ? 0 : Math.max(1, Math.ceil(totalLines / LINES_PER_PAGE));
  return { pages, scenes, firstScene, lastScene };
}

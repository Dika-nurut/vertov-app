import { parseFountain } from './fountain/parse.js';

/**
 * Token-budget-friendly context extraction for anchored assist calls:
 * the span + its enclosing scene(s) + a scene index — never the whole
 * script (whole-script commands are a separate, explicitly priced scope).
 */

export interface SceneRef {
  /** 1-based scene number in document order (not the #…# scene number). */
  index: number;
  heading: string;
  /** Character-offset range of the scene in the fountain text. */
  from: number;
  to: number;
}

export interface SpanContext {
  /** The selected text itself. */
  span: string;
  /** Full text of the scene(s) the span touches, clamped to `maxSceneChars`. */
  scene: string;
  /** Headings of the scenes the span touches. */
  sceneHeadings: string[];
  /** Compact scene index of the whole script: "1. ИНТ. КУХНЯ - НОЧЬ". */
  sceneIndex: string;
}

/** List scenes with their character-offset ranges. */
export function sceneList(fountain: string): SceneRef[] {
  const doc = parseFountain(fountain);
  const scenes: SceneRef[] = [];
  let offset = 0;
  // Title page lines precede elements in the offset space.
  for (const entry of doc.titlePage) {
    for (const line of entry.raw) offset += line.length + 1;
  }
  let current: SceneRef | null = null;
  for (const el of doc.elements) {
    const elLen = el.raw.reduce((n, l) => n + l.length + 1, 0);
    if (el.type === 'scene_heading') {
      if (current) {
        current.to = offset;
        scenes.push(current);
      }
      current = {
        index: scenes.length + 1,
        heading: el.text,
        from: offset,
        to: offset,
      };
    }
    offset += elLen;
  }
  if (current) {
    current.to = offset;
    scenes.push(current);
  }
  return scenes;
}

const MAX_SCENE_CHARS = 12_000; // ≈ 4–6k tokens for RU text, inside the span budget
/**
 * Hard cap on the selected fragment itself. A span call is priced as a cheap
 * "about this fragment" question, so the fragment can't be allowed to BE the
 * whole script — otherwise selecting everything and asking on the span tier
 * would send (and cost) a whole-script read at the fragment price. A fragment
 * this large is a whole-script question, which is the chat scope's job. Matches
 * the anchor `quote` cap in the assist schema, so it's a no-op for real spans.
 */
const MAX_SPAN_CHARS = 4_000;

/**
 * Hard cap on the scene index («ОГЛАВЛЕНИЕ СЦЕН»). The index lists every scene
 * heading in the WHOLE script and rides on EVERY assist call (span and chat),
 * but scripts are allowed up to 2 MB — a script with thousands of scenes would
 * blow the token budget the prices are set against and lose money on that call.
 * ~5k chars fits ~170 scenes in full (more than any feature); beyond that the
 * tail is replaced with a «… ещё N сцен» line. Matches the scene-index size the
 * assist price budget assumes, so the per-call cost never exceeds it.
 */
const MAX_SCENE_INDEX_CHARS = 5_000;

/** Compact, hard-bounded scene index for the assist prompt. */
export function sceneIndexText(fountain: string, maxChars = MAX_SCENE_INDEX_CHARS): string {
  return clampSceneIndex(sceneList(fountain), maxChars);
}

function clampSceneIndex(scenes: SceneRef[], maxChars = MAX_SCENE_INDEX_CHARS): string {
  const lines: string[] = [];
  let used = 0;
  for (let i = 0; i < scenes.length; i++) {
    const line = `${scenes[i]!.index}. ${scenes[i]!.heading}`;
    if (lines.length > 0 && used + line.length + 1 > maxChars) {
      lines.push(`… ещё ${scenes.length - i} сцен`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

/**
 * Build the context for an anchored call. When the span falls outside any
 * scene (e.g. title page or a script with no headings), the scene window
 * degrades to a text window around the span — still bounded.
 */
export function spanContext(fountain: string, from: number, to: number): SpanContext {
  const lo = Math.max(0, Math.min(from, fountain.length));
  const hi = Math.max(lo, Math.min(to, fountain.length));
  const scenes = sceneList(fountain);
  const touched = scenes.filter((s) => s.from < hi && s.to > lo);

  let sceneText: string;
  let headings: string[];
  if (touched.length > 0) {
    const start = touched[0]!.from;
    const end = touched[touched.length - 1]!.to;
    sceneText = fountain.slice(start, end);
    headings = touched.map((s) => s.heading);
  } else {
    const pad = 1_500;
    sceneText = fountain.slice(Math.max(0, lo - pad), Math.min(fountain.length, hi + pad));
    headings = [];
  }
  if (sceneText.length > MAX_SCENE_CHARS) {
    // Keep the window centred on the span.
    const spanMid = (lo + hi) / 2;
    const start = Math.max(
      0,
      Math.min(spanMid - MAX_SCENE_CHARS / 2, fountain.length - MAX_SCENE_CHARS),
    );
    sceneText = fountain.slice(start, start + MAX_SCENE_CHARS);
  }

  return {
    span: fountain.slice(lo, Math.min(hi, lo + MAX_SPAN_CHARS)),
    scene: sceneText,
    sceneHeadings: headings,
    sceneIndex: clampSceneIndex(scenes),
  };
}

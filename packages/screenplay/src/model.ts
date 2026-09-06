/**
 * Canonical screenplay model for Vertov «Сценарий».
 *
 * The canonical stored representation is Fountain TEXT (one DB column).
 * This model is the parsed, element-level view of that text. The parser is
 * line-lossless: every source line lands verbatim in exactly one element's
 * `raw`, in order, so `serializeFountain(parseFountain(x)) === x` for any
 * input — the semantic classification can be imperfect without ever eating
 * a writer's draft.
 */

export type ElementType =
  | 'scene_heading'
  | 'action'
  | 'character'
  | 'parenthetical'
  | 'dialogue'
  | 'lyrics'
  | 'transition'
  | 'centered'
  | 'section'
  | 'synopsis'
  | 'page_break'
  | 'note'
  | 'boneyard'
  | 'blank';

export interface FountainElement {
  type: ElementType;
  /** Verbatim source lines (no EOL chars, but any `\r` is preserved). */
  raw: string[];
  /**
   * Cleaned semantic text: forced markers / scene numbers / dual carets
   * stripped, lines joined with '\n'. Inline emphasis and notes are kept —
   * strip with `stripInline()` when exporting to plain surfaces.
   */
  text: string;
  /** scene_heading: `#…#` scene number, without the hashes. */
  sceneNumber?: string;
  /** character: dual-dialogue caret `^` was present. */
  dual?: boolean;
  /** section: number of leading `#`. */
  depth?: number;
  /** element came from a forced marker (`.` `!` `@` `>` `~`). */
  forced?: boolean;
}

export interface TitlePageEntry {
  /** Key as written (e.g. "Draft date", "Автор"). */
  key: string;
  /** Cleaned values: inline value (if any) + indented continuation lines. */
  values: string[];
  /** Verbatim source lines for this entry (key line + continuations). */
  raw: string[];
}

export interface ScreenplayDoc {
  titlePage: TitlePageEntry[];
  elements: FountainElement[];
}

/** How a lossy import degraded the source — never silently dropped. */
export interface FidelityIssue {
  code:
    | 'unsupported-element'
    | 'formatting-lost'
    | 'structure-guessed'
    | 'metadata-lost'
    | 'content-skipped';
  message: string;
  /** Optional short excerpt of the affected content. */
  detail?: string;
}

export interface FidelityReport {
  /** True when the import maps 1:1 with no guessing and no dropped content. */
  lossless: boolean;
  issues: FidelityIssue[];
}

export interface ImportResult {
  fountain: string;
  report: FidelityReport;
}

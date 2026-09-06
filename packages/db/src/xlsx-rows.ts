/**
 * The sheet-XML half of the cost-leg importer, split out so it can be tested.
 *
 * It lived inside `scripts/import-cost-legs.ts`, which has top-level side effects and
 * therefore cannot be imported by a test — so the one step that turns finance's workbook
 * into numbers we bill from had no coverage at all, and three silent misreads sat in it.
 * xlsx is a zip of XML; reading the zip stays in the script, parsing lives here.
 */

/** Excel column letters → zero-based index. Handles multi-letter columns (AA, BA…). */
export function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Shared strings are the only place cell TEXT lives; `t="s"` cells hold an index. */
export function parseSharedStrings(xml: string): string[] {
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((si) =>
    [...si[1]!.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeXml(t[1]!)).join(''),
  );
}

/**
 * Rows as dense arrays. Blank cells are '' and a cell's position in the array really is
 * its column, taken from the `r` attribute rather than from arrival order.
 *
 * Three legal cell shapes this used to get wrong, all of them silent:
 *
 * - `<c r="B2"/>` — Excel writes an empty-but-formatted cell self-closed. The old
 *   pattern required a `</c>`, so it matched the opening tag and then backtracked PAST
 *   the next real cell to find one, swallowing that cell's value and shifting every
 *   following column left by one. Nothing downstream could catch it: row count, credit
 *   sum and margin sum are all unchanged by a sideways shift, and the digest is computed
 *   over our own misread.
 * - `t="inlineStr"` — the text lives in `<is><t>`, not `<v>`. These parsed as ''.
 * - `t="str"` — a formula's cached string result is already literal text and must NOT be
 *   looked up in the shared-string table.
 */
export function parseSheetRows(xml: string, sharedStrings: readonly string[]): string[][] {
  const out: string[][] = [];
  for (const row of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const c of row[1]!.matchAll(
      /<c r="([A-Z]+)\d+"((?:[^>"]|"[^"]*")*?)(?:\/>|>([\s\S]*?)<\/c>)/g,
    )) {
      const index = columnIndex(c[1]!);
      const attrs = c[2]!;
      const body = c[3] ?? '';
      const type = /\st="([^"]*)"/.exec(attrs)?.[1] ?? 'n';
      const value = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '';
      const text =
        type === 's'
          ? (sharedStrings[Number(value)] ?? '')
          : type === 'inlineStr'
            ? [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeXml(t[1]!)).join('')
            : decodeXml(value);
      while (cells.length < index) cells.push('');
      cells[index] = text;
    }
    out.push(cells);
  }
  return out;
}

/**
 * Flatten a cell's internal line breaks to spaces.
 *
 * `parseCostLegs` splits the file on newlines BEFORE it tokenizes CSV, so a quoted field
 * containing a literal newline — which the writer happily produces — yields a file the
 * parser rejects outright ("expected 34 columns, got 22"). A finance note wrapped with
 * Alt+Enter is an ordinary edit, and it made the whole import impossible. The break
 * carries no meaning in a source citation, so it is normalised here rather than teaching
 * the seed parser multi-line records.
 */
export function flattenCell(value: string): string {
  return value.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

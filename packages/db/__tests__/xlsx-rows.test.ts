import { describe, expect, it } from 'vitest';
import { columnIndex, flattenCell, parseSharedStrings, parseSheetRows } from '../src/xlsx-rows';

/**
 * This reader turns finance's workbook into the numbers we bill from, and until
 * 2026-08-11 it had no test at all — it lived inside a script with top-level side
 * effects, so nothing could import it. Three legal cell shapes were misread silently.
 *
 * DAMP on purpose: each case spells out the XML it is about, because the whole point is
 * that these shapes look unremarkable until you see what the old pattern did with them.
 */
const strings = parseSharedStrings(
  '<sst><si><t>model_id</t></si><si><t>rung</t></si><si><t>kie</t></si></sst>',
);

describe('parseSheetRows: the shapes Excel really writes', () => {
  it('keeps columns aligned when a middle cell is SELF-CLOSING', () => {
    // Excel writes an empty-but-formatted cell as `<c r="B1"/>`. The old pattern needed
    // a closing tag, so it backtracked past C1 to find one — C1's value became B1's and
    // C1 vanished, shifting every later column left by one. Row count, credit sum and
    // margin sum all survive that shift unchanged, and the digest is taken over our own
    // misread, so no check downstream could ever have caught it.
    const xml =
      '<sheetData><row r="1">' +
      '<c r="A1" t="s"><v>0</v></c>' +
      '<c r="B1" s="3"/>' +
      '<c r="C1" t="s"><v>1</v></c>' +
      '</row></sheetData>';
    expect(parseSheetRows(xml, strings)).toEqual([['model_id', '', 'rung']]);
  });

  it('reads an INLINE string, which has no <v> at all', () => {
    // t="inlineStr" is spec-legal and produced by LibreOffice and several automation
    // libraries. It used to parse as '' — and `providerSku`, `channel`, `upstream` and
    // `source` have no non-empty validator, so a blanked one raised nothing anywhere.
    const xml =
      '<sheetData><row r="1">' +
      '<c r="A1" t="inlineStr"><is><t>gemini-3-pro-image</t></is></c>' +
      '</row></sheetData>';
    expect(parseSheetRows(xml, strings)).toEqual([['gemini-3-pro-image']]);
  });

  it('does NOT treat a formula’s cached string as a shared-string index', () => {
    // t="str" holds literal text. Looking it up in the shared-string table would have
    // returned an unrelated name — or nothing.
    const xml = '<sheetData><row r="1"><c r="A1" t="str"><v>laozhang</v></c></row></sheetData>';
    expect(parseSheetRows(xml, strings)).toEqual([['laozhang']]);
  });

  it('places cells by their column letter, not by arrival order', () => {
    const xml =
      '<sheetData><row r="1">' +
      '<c r="A1" t="s"><v>2</v></c>' +
      '<c r="D1" t="s"><v>1</v></c>' +
      '</row></sheetData>';
    expect(parseSheetRows(xml, strings)).toEqual([['kie', '', '', 'rung']]);
  });

  it('handles columns past Z', () => {
    expect(columnIndex('A')).toBe(0);
    expect(columnIndex('Z')).toBe(25);
    expect(columnIndex('AA')).toBe(26);
    expect(columnIndex('AH')).toBe(33); // the 34th column — `площадь_МП`
  });
});

describe('flattenCell: a wrapped note must not break the import', () => {
  it('collapses an Alt+Enter line break to a single space', () => {
    // `parseCostLegs` splits on newlines before it tokenizes CSV, so a quoted field
    // holding a real newline made the file unreadable: "expected 34 columns, got 22".
    // Finance wrapping a source citation is an ordinary edit.
    expect(flattenCell('Сетка FX\nстр.9')).toBe('Сетка FX стр.9');
    expect(flattenCell('a\r\n  b')).toBe('a b');
  });

  it('still trims, as the previous writer did', () => {
    expect(flattenCell('  kie  ')).toBe('kie');
  });
});

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { columnFingerprint, parseCostLegs } from '../src/cost-legs';
import { generateCostLegs } from './generate-cost-legs';
import { decodeXml, flattenCell, parseSharedStrings, parseSheetRows } from '../src/xlsx-rows';

/**
 * Read finance's workbook and regenerate `seed/cost-legs.csv` from it.
 *
 * This exists because the export was transcribed BY HAND for revisions 10 through 19,
 * five of them in one day. Every hand-carry is a chance to mistype a rate, and the
 * transcription is the one step in the whole pricing chain with no check on it — the
 * digest proves the file was not edited AFTER we wrote it, and says nothing about
 * whether we wrote what the sheet said.
 *
 * The workbook path is the owner's drop location; he replaces the file in place, so
 * there is nothing to move and no version to pick.
 *
 * Usage: pnpm --filter @seed/db exec tsx scripts/import-cost-legs.ts [path-to-xlsx]
 */

const here = dirname(fileURLToPath(import.meta.url));
/** The committed workbook is the default input; an external path is opt-in. */
const DEFAULT_WORKBOOK = resolve(
  join(here, '../../../docs/business/pricing-workbook/Vertov_Pricing_Model_v14_2026-07-28.xlsx'),
);
const LEGS_SHEET = 'НОГИ (экспорт)';
const GRID_SHEET = 'Сетка FX';

const CSV_PATH = resolve(join(here, '..', 'seed', 'cost-legs.csv'));

function fail(message: string): never {
  console.error(`import-cost-legs: ${message}`);
  process.exit(1);
}

/** xlsx is a zip of XML. `unzip` is a build-box tool, not a runtime dependency. */
function entry(workbook: string, path: string): string {
  try {
    return execFileSync('unzip', ['-p', workbook, path], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return fail(`could not read ${path} out of ${workbook} (is \`unzip\` installed?)`);
  }
}

/** Sheet name → the part path its rId points at. */
function sheetPath(workbook: string, name: string): string {
  const wb = entry(workbook, 'xl/workbook.xml');
  const sheet = [...wb.matchAll(/<sheet[^>]*name="([^"]*)"[^>]*r:id="(rId\d+)"[^>]*\/>/g)].find(
    (m) => decodeXml(m[1]!) === name,
  );
  if (!sheet) fail(`the workbook has no sheet named «${name}»`);
  const rels = entry(workbook, 'xl/_rels/workbook.xml.rels');
  const rel = [...rels.matchAll(/Id="([^"]*)"[^>]*Target="([^"]*)"/g)].find(
    (m) => m[1] === sheet![2],
  );
  if (!rel) fail(`sheet «${name}» has no relationship target`);
  return 'xl/' + rel![2]!.replace(/^\/?xl\//, '');
}

/** Read one sheet out of the workbook as dense rows. */
function rows(workbook: string, name: string): string[][] {
  return parseSheetRows(
    entry(workbook, sheetPath(workbook, name)),
    parseSharedStrings(entry(workbook, 'xl/sharedStrings.xml')),
  );
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

const workbook = resolve(process.argv[2] ?? DEFAULT_WORKBOOK);
if (!existsSync(workbook)) {
  fail(
    `workbook not found at ${workbook}. The committed ` +
      '`docs/business/pricing-workbook/Vertov_Pricing_Model_v14_2026-07-28.xlsx` is the SSOT; ' +
      'pass an explicit path only for a reviewed finance drop.',
  );
}
const sheet = rows(workbook, LEGS_SHEET);

const headerAt = sheet.findIndex((row) => row[0] === 'model_id');
if (headerAt < 0) fail(`«${LEGS_SHEET}» has no header row starting with model_id`);
const header = sheet[headerAt]!;

const data = sheet.slice(headerAt + 1).filter((row) => (row[0] ?? '').trim() !== '');

/** Finance states the three totals in prose above the table. They are the only
 *  independent check that we read the sheet the way they wrote it, so a mismatch is
 *  fatal rather than a warning — a silently short read looks exactly like a real change. */
const banner = sheet
  .slice(0, headerAt)
  .map((row) => row.join(' '))
  .join('\n');
const declared = {
  rows: Number(/СТРОК ДАННЫХ:\s*(\d+)/.exec(banner)?.[1] ?? NaN),
  credits: Number(/КОНТРОЛЬНАЯ СУММА КРЕДИТОВ:\s*([\d.]+)/.exec(banner)?.[1] ?? NaN),
  margin: Number(/КОНТРОЛЬНАЯ СУММА МАРЖИ:\s*([\d.]+)/.exec(banner)?.[1] ?? NaN),
};
/**
 * Finance's FOURTH checksum, added in their rev. 20 and the most important of the four.
 * The other three are sums, and addition is commutative — a sideways column shift leaves
 * every one of them intact while each value sits one field to the left. Their reading
 * rule, adopted verbatim: if this disagrees and the sums agree, the structure is wrong
 * and the numbers are meaningless. So it is checked BEFORE the sums are believed.
 */
const declaredColumns = /ОТПЕЧАТОК ПОРЯДКА КОЛОНОК:\s*([0-9a-f]{16})/.exec(banner)?.[1] ?? null;

const revision = /ВЕРСИЯ\s+([\d-]+)\s*·\s*РЕД\.\s*(\d+)/.exec(banner);
if (!revision) fail('could not find the «ВЕРСИЯ … РЕД. N» marker above the table');
if (!Number.isFinite(declared.rows)) fail('could not read СТРОК ДАННЫХ from the sheet');

const columns = columnFingerprint(header);
if (declaredColumns !== null && declaredColumns !== columns) {
  fail(
    `column-order fingerprint mismatch: the header hashes to ${columns}, the sheet declares ` +
      `${declaredColumns}. The three sums cannot see a sideways shift — read the structure, ` +
      'not the numbers.',
  );
}

const creditsAt = header.indexOf('Кредитов');
const marginAt = header.indexOf('Маржа ноги');
if (creditsAt < 0 || marginAt < 0) fail('the header is missing Кредитов or Маржа ноги');

const actual = {
  rows: data.length,
  credits: data.reduce((sum, row) => sum + Number(row[creditsAt] ?? 0), 0),
  margin: data.reduce((sum, row) => sum + Number(row[marginAt] ?? 0), 0),
};
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;
if (actual.rows !== declared.rows) {
  fail(`read ${actual.rows} data rows, the sheet declares ${declared.rows}`);
}
if (!near(actual.credits, declared.credits)) {
  fail(`credits summed to ${actual.credits}, the sheet declares ${declared.credits}`);
}
if (!near(actual.margin, declared.margin)) {
  fail(`margin summed to ${actual.margin}, the sheet declares ${declared.margin}`);
}

// Padded to the header width on purpose: a row whose LAST columns are empty — and
// `площадь_МП` is empty on every leg not billed by area — otherwise arrives short and
// the parser rejects the file for a shape the sheet never had.
const legsBlock = [header, ...data].map((row) =>
  Array.from({ length: header.length }, (_, index) => csvCell(flattenCell(row[index] ?? ''))).join(
    ',',
  ),
);
const digest = createHash('sha256').update(legsBlock.join('\n')).digest('hex').slice(0, 16);

/**
 * The EXCLUDED block is curated, not generated: it names positions we deliberately do
 * not sell. Carried forward from the file rather than re-derived, with the grid's
 * «НЕ ЗАВОДИЛАСЬ» rows folded in — those are the newer category, a priced row whose
 * route is not connected, and losing them would make the omission invisible again.
 */
const previous = readFileSync(CSV_PATH, 'utf8').split('\n');
const excludedAt = previous.findIndex((line) => line.trim() === '# EXCLUDED');
if (excludedAt < 0) fail('the existing cost-legs.csv has no # EXCLUDED block to carry forward');
const carried = previous
  .slice(excludedAt + 2)
  .map((line) => line.trim())
  .filter((line) => line !== '' && !line.startsWith('# '))
  // Rev. 22 signs these two Kie fallback rows explicitly. They must no longer
  // remain in EXCLUDED as "duplicate" positions, otherwise route guards would
  // report a fictitious reserve exemption after the cost row exists.
  .filter(
    (line) =>
      !new Set([
        'gpt-image-2 1K (low),резерв дублирует основную',
        'gpt-image-2 i2i (low),резерв дублирует основную',
      ]).has(line),
  );
const withdrawn = rows(workbook, GRID_SHEET)
  .map((row) => row.find((cell) => cell.includes('НЕ ЗАВОДИЛАСЬ')))
  .filter((cell): cell is string => Boolean(cell))
  .map(
    (cell) =>
      `${csvCell(cell.replace(/\s*—\s*НЕ ЗАВОДИЛАСЬ\s*$/, '').trim())},маршрут не подключён`,
  );
const excluded = [...new Set([...carried, ...withdrawn])];

// The DECLARED totals go in the meta line, not our re-summed ones: they are finance's
// signature, and floating-point accumulation over 130 rows lands on 32.879944999999985
// where they wrote 32.879945. We have already proven the two agree; recording our own
// sum instead would quietly make the file cite us as the source of its own checksum.
const meta =
  `# rows=${declared.rows} credits=${declared.credits} margin=${declared.margin} ` +
  `source=Vertov_Pricing_Model_v14 ${revision[1]} ред.${revision[2]} sha256_16=${digest} ` +
  `cols_sha16=${columns}`;

const text = [
  meta,
  '# LEGS',
  ...legsBlock,
  '',
  '# EXCLUDED',
  'position,reason',
  ...excluded,
  '',
].join('\n');

/** Round-trip before writing anything: the parser is the contract, so a file it cannot
 *  read is not an import, it is a broken seed nobody notices until the next test run. */
try {
  parseCostLegs(text);
} catch (error) {
  fail(`the generated file does not parse — ${(error as Error).message}`);
}

writeFileSync(CSV_PATH, text);
// The seed the app actually reads is the generated JSON, not the CSV. Regenerating it
// here makes the import ONE command: a stale JSON was a second step nobody remembers,
// and the identity test only fails afterwards, at the end of a suite run.
generateCostLegs(CSV_PATH, resolve(join(here, '..', 'seed', 'cost-legs.generated.json')));
console.log(
  `import-cost-legs: ред.${revision[2]} — ${actual.rows} rows, ${actual.credits} credits, ` +
    `margin ${actual.margin}, sha256_16=${digest}`,
);

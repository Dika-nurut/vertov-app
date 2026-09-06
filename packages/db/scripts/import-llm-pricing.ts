import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeXml, parseSharedStrings, parseSheetRows } from '../src/xlsx-rows';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKBOOK = resolve(
  join(here, '../../../docs/business/pricing-workbook/Vertov_Pricing_Model_v14_2026-07-28.xlsx'),
);
const OUTPUT = resolve(join(here, '..', 'seed', 'llm-pricing.generated.json'));
const SHEET = 'LLM ЦЕНЫ';

function fail(message: string): never {
  throw new Error(`import-llm-pricing: ${message}`);
}

function entry(workbook: string, path: string): string {
  return execFileSync('unzip', ['-p', workbook, path], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function sheetPath(workbook: string, name: string): string {
  const workbookXml = entry(workbook, 'xl/workbook.xml');
  const sheet = [
    ...workbookXml.matchAll(/<sheet[^>]*name="([^"]*)"[^>]*r:id="(rId\d+)"[^>]*\/>/g),
  ].find((match) => decodeXml(match[1]!) === name);
  if (!sheet) return fail(`workbook has no sheet «${name}»`);
  const relationships = entry(workbook, 'xl/_rels/workbook.xml.rels');
  const relationship = [...relationships.matchAll(/Id="([^"]*)"[^>]*Target="([^"]*)"/g)].find(
    (match) => match[1] === sheet[2],
  );
  if (!relationship) return fail(`sheet «${name}» has no relationship target`);
  return 'xl/' + relationship[2]!.replace(/^\/?xl\//, '');
}

function asNumber(value: string, field: string, row: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fail(`row ${row}: ${field} is not numeric`);
  return number;
}

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const workbookArgument = args.find((argument) => argument !== '--check');
const workbook = resolve(workbookArgument ?? DEFAULT_WORKBOOK);
if (!existsSync(workbook)) fail(`workbook not found at ${workbook}`);

const strings = parseSharedStrings(entry(workbook, 'xl/sharedStrings.xml'));
const sheetXml = entry(workbook, sheetPath(workbook, SHEET));
const rows = parseSheetRows(sheetXml, strings);
const rowNumbers = [...sheetXml.matchAll(/<row[^>]*\br="(\d+)"[^>]*>/g)].map((match) =>
  Number(match[1]),
);
const headerAt = rows.findIndex((row) => row[0] === 'surface');
if (headerAt < 0) fail('missing surface header');
const header = rows[headerAt]!;
const required = [
  'surface',
  'selector',
  'model_slug',
  'primary_provider',
  'fallback_provider',
  'primary_input_$/MTok',
  'primary_output_$/MTok',
  'fallback_input_$/MTok',
  'fallback_output_$/MTok',
  'primary_max_attempts',
  'fallback_max_attempts',
  'typical_input_tokens',
  'typical_output_tokens',
  'max_input_tokens',
  'max_output_tokens',
  'credits',
  'margin_at_floor',
  'brief_char_limit',
  'result_char_limit',
  'chars_per_token',
  'source/status',
  'cache_read_multiplier',
  'cache_write_multiplier',
  'cache_ttl',
  'cache_min_prefix_tokens',
  'cache_status',
  'cache_evidence',
] as const;
for (const name of required) if (!header.includes(name)) fail(`missing column ${name}`);
const at = (name: (typeof required)[number]) => header.indexOf(name);
const optionalNumber = (
  row: string[],
  name: (typeof required)[number],
  fallback: number,
  workbookRow: number,
) => {
  const value = row[at(name)];
  return value === undefined || value === '' ? fallback : asNumber(value, name, workbookRow);
};
const optionalText = (row: string[], name: (typeof required)[number], fallback: string) =>
  row[at(name)] === undefined || row[at(name)] === '' ? fallback : row[at(name)]!;

const valueAt = (row: number, column: number, label: string): number => {
  const denseAt = rowNumbers.indexOf(row);
  if (denseAt < 0) return fail(`missing settings row ${row}`);
  return asNumber(rows[denseAt]?.[column] ?? '', label, row);
};
const financial = {
  usdRub: valueAt(3, 1, 'USD/RUB'),
  landedRubPerUsdOpenRouter: valueAt(3, 4, 'OpenRouter landed FX'),
  landedRubPerUsdDirect: valueAt(3, 7, 'direct landed FX'),
  creditFloorRub: valueAt(4, 1, 'credit floor'),
  marginFloor: valueAt(4, 4, 'margin floor'),
  /** Temporary owner-approved Scenario policy; Boards/media keep marginFloor. */
  scenarioMarginFloor: valueAt(4, 13, 'Scenario temporary margin floor'),
  /** Active context-band policy; legacy flat rows keep the historical value above. */
  scenarioBandMarginFloor: valueAt(4, 16, 'Scenario active band margin floor'),
  scenarioConspectTokenBudget: {
    input: valueAt(3, 10, 'conspect input tokens'),
    output: valueAt(3, 13, 'conspect output tokens'),
  },
  scenarioConspectMaxAttempts: valueAt(3, 16, 'conspect max attempts'),
  structurizeMaxAttempts: valueAt(4, 10, 'structurize max attempts'),
};

const records = rows
  .slice(headerAt + 1)
  .map((row, offset) => ({ row, workbookRow: rowNumbers[headerAt + offset + 1]! }))
  .filter(({ row }) => (row[0] ?? '').trim() !== '')
  .map(({ row, workbookRow }) => ({
    surface: row[at('surface')]!,
    selector: row[at('selector')]!,
    model: row[at('model_slug')]!,
    primaryProvider: row[at('primary_provider')]!,
    fallbackProvider: row[at('fallback_provider')]!,
    primaryPriceUsdPerMTok: {
      input: asNumber(row[at('primary_input_$/MTok')]!, 'primary input', workbookRow),
      output: asNumber(row[at('primary_output_$/MTok')]!, 'primary output', workbookRow),
    },
    fallbackPriceUsdPerMTok: {
      input: asNumber(row[at('fallback_input_$/MTok')]!, 'fallback input', workbookRow),
      output: asNumber(row[at('fallback_output_$/MTok')]!, 'fallback output', workbookRow),
    },
    primaryMaxAttempts: asNumber(
      row[at('primary_max_attempts')]!,
      'primary max attempts',
      workbookRow,
    ),
    fallbackMaxAttempts: asNumber(
      row[at('fallback_max_attempts')]!,
      'fallback max attempts',
      workbookRow,
    ),
    typicalTokenBudget: {
      input: asNumber(row[at('typical_input_tokens')]!, 'typical input', workbookRow),
      output: asNumber(row[at('typical_output_tokens')]!, 'typical output', workbookRow),
    },
    maxTokenBudget: {
      input: asNumber(row[at('max_input_tokens')]!, 'max input', workbookRow),
      output: asNumber(row[at('max_output_tokens')]!, 'max output', workbookRow),
    },
    credits: asNumber(row[at('credits')] ?? '', 'credits', workbookRow),
    marginAtFloor: asNumber(row[at('margin_at_floor')] ?? '', 'margin at floor', workbookRow),
    briefCharLimit: asNumber(row[at('brief_char_limit')]!, 'brief char limit', workbookRow),
    resultCharLimit: asNumber(row[at('result_char_limit')]!, 'result char limit', workbookRow),
    charsPerToken: asNumber(row[at('chars_per_token')]!, 'chars per token', workbookRow),
    source: row[at('source/status')]!,
    sourceRef: `${SHEET}!A${workbookRow}:AE${workbookRow}`,
    cacheReadMultiplier: optionalNumber(row, 'cache_read_multiplier', 1, workbookRow),
    cacheWriteMultiplier: optionalNumber(row, 'cache_write_multiplier', 1, workbookRow),
    cacheTtl: optionalText(row, 'cache_ttl', 'not_applicable'),
    cacheMinPrefixTokens: optionalNumber(row, 'cache_min_prefix_tokens', 0, workbookRow),
    cacheStatus: optionalText(row, 'cache_status', 'not_applicable'),
    cacheEvidence: optionalText(row, 'cache_evidence', 'not_applicable'),
  }));

const keys = records.map((record) => `${record.surface}:${record.selector}`);
if (new Set(keys).size !== keys.length) fail('duplicate surface/selector key');
for (const selector of ['gemini', 'claude', 'gpt']) {
  if (
    !records.some(
      (record) => record.surface === 'boards_prompt_studio' && record.selector === selector,
    )
  ) {
    fail(`missing Boards selector ${selector}`);
  }
}
for (const record of records.filter((row) => row.credits > 0)) {
  const primaryUsd =
    (record.primaryMaxAttempts *
      (record.maxTokenBudget.input * record.primaryPriceUsdPerMTok.input +
        record.maxTokenBudget.output * record.primaryPriceUsdPerMTok.output)) /
    1_000_000;
  const fallbackUsd =
    (record.fallbackMaxAttempts *
      (record.maxTokenBudget.input * record.fallbackPriceUsdPerMTok.input +
        record.maxTokenBudget.output * record.fallbackPriceUsdPerMTok.output)) /
    1_000_000;
  const conspect = records.find(
    (candidate) =>
      candidate.surface === 'scenario_assist_price' && candidate.selector === 'economy/project',
  );
  const conspectUsd =
    (record.surface === 'scenario_assist_price' ||
      (record.surface === 'scenario_assist_band' && record.selector.endsWith('/conspect'))) &&
    conspect
      ? (financial.scenarioConspectMaxAttempts *
          (financial.scenarioConspectTokenBudget.input * conspect.primaryPriceUsdPerMTok.input +
            financial.scenarioConspectTokenBudget.output *
              conspect.primaryPriceUsdPerMTok.output)) /
        1_000_000
      : 0;
  const costRub =
    primaryUsd *
      (record.primaryProvider === 'OpenRouter'
        ? financial.landedRubPerUsdOpenRouter
        : financial.landedRubPerUsdDirect) +
    fallbackUsd *
      (record.fallbackProvider === 'OpenRouter'
        ? financial.landedRubPerUsdOpenRouter
        : financial.landedRubPerUsdDirect) +
    conspectUsd * financial.landedRubPerUsdOpenRouter;
  const marginFloor =
    record.surface === 'scenario_assist_band' || record.surface === 'scenario_structurize_active'
      ? financial.scenarioBandMarginFloor
      : record.surface === 'scenario_assist_price' || record.surface === 'scenario_structurize'
        ? financial.scenarioMarginFloor
        : financial.marginFloor;
  const expectedCredits = Math.ceil(costRub / (financial.creditFloorRub * (1 - marginFloor)));
  const expectedMargin = 1 - costRub / (expectedCredits * financial.creditFloorRub);
  if (record.credits !== expectedCredits) {
    fail(
      `${record.sourceRef}: cached credits ${record.credits} do not match formula ${expectedCredits}; recalculate the workbook`,
    );
  }
  if (Math.abs(record.marginAtFloor - expectedMargin) > 1e-12) {
    fail(
      `${record.sourceRef}: cached margin ${record.marginAtFloor} does not match formula ${expectedMargin}; recalculate the workbook`,
    );
  }
}
for (const record of records.filter(
  (row) => row.surface === 'scenario_assist_band' || row.surface === 'scenario_structurize_active',
)) {
  if (
    !Number.isFinite(record.cacheReadMultiplier) ||
    !Number.isFinite(record.cacheWriteMultiplier) ||
    record.cacheReadMultiplier <= 0 ||
    record.cacheWriteMultiplier <= 0 ||
    !record.cacheStatus ||
    !record.cacheEvidence
  ) {
    fail(`${record.sourceRef}: active Scenario row is missing explicit cache economics/status`);
  }
}

const workbookSha256 = createHash('sha256').update(readFileSync(workbook)).digest('hex');
const payload = {
  workbook: {
    path: 'docs/business/pricing-workbook/Vertov_Pricing_Model_v14_2026-07-28.xlsx',
    sheet: SHEET,
    capturedOn: rows[3]?.[7] ?? '',
    sha256: workbookSha256,
  },
  financial,
  records,
};
const serialized = `${JSON.stringify(payload, null, 2)}\n`;
if (checkOnly) {
  if (!existsSync(OUTPUT) || readFileSync(OUTPUT, 'utf8') !== serialized) {
    fail(`generated export is stale; run pnpm --filter @seed/db import:llm-pricing`);
  }
  console.log(
    `import-llm-pricing: generated export matches ${records.length} rows from «${SHEET}», sha256=${workbookSha256}`,
  );
} else {
  writeFileSync(OUTPUT, serialized, 'utf8');
  console.log(
    `import-llm-pricing: ${records.length} rows from «${SHEET}», sha256=${workbookSha256}`,
  );
}

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { seedModels } from '../seed/models';
import { PRICE_POINT_SEED } from '../seed/price-points';

/**
 * Production receives the v14 catalog through 0055, not through `pnpm seed`.
 * The migration's conflict path must therefore produce the same model row as
 * the seed. This catches a seed-only routing/configuration change before it
 * ships (including top-level fields such as fallback_gateway).
 */
const migrationSql = readFileSync(
  new URL('../migrations/0060_pricing_v14_catalogue.sql', import.meta.url),
  'utf8',
);
const omniReferenceMigrationSql = readFileSync(
  new URL('../migrations/0061_gemini_omni_reference_channel.sql', import.meta.url),
  'utf8',
);
const veoFlatRateRepairMigrationSql = readFileSync(
  new URL('../migrations/0103_repair_veo_flat_rate.sql', import.meta.url),
  'utf8',
);
const migrationsDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../migrations',
);

const modelRowsMatch = migrationSql.match(
  /WITH model_rows\(id, data\) AS \(\s*VALUES([\s\S]*?)\n\)\nINSERT INTO "models"/,
);
if (!modelRowsMatch) throw new Error('0055 model_rows CTE not found');

const migrationModels = new Map(
  [...(modelRowsMatch[1] ?? '').matchAll(/\('([^']+)', '((?:[^']|'')*)'::jsonb\)/g)].map(
    (match) => [
      match[1] ?? '',
      JSON.parse((match[2] ?? '').replaceAll("''", "'")) as Record<string, unknown>,
    ],
  ),
);

const seedModelById = new Map(seedModels.map((model) => [model.id, model]));

const priceRowsMatch = migrationSql.match(
  /WITH price_rows\(\s*id, model_id, resolution, video_input, audio, unit_kind, base_credits, base_units, source_ref, is_active\s*\) AS \(\s*VALUES([\s\S]*?)\n\)\nINSERT INTO "model_price_points"/,
);
if (!priceRowsMatch) throw new Error('0055 price_rows CTE not found');

type MigrationPriceRow = {
  modelId: string;
  resolution: string;
  videoInput: boolean;
  audio: boolean;
  unitKind: string;
  baseCredits: number;
  baseUnits: number;
  flatRate: boolean;
  mode: string;
  refsMin: number;
  refsMax: number | null;
  sourceRef: string;
  isActive: boolean;
};

// THREE shapes, one pattern, because the row literal has grown twice: 0060 pre-dates
// `flat_rate`, 0066–0077 carry it, and 0078 onward also carry the mode and reference
// band. Both later additions are optional GROUPS rather than separate patterns —
// but they are anchored between fixed neighbours (`base_units` before, `source_ref`
// after), so an optional group cannot swallow a row that merely lost a column: the
// literal still has to end with a quoted source_ref and a boolean.
//
// Historical migrations are NOT rewritten to the new shape. They ran before 0077
// existed, and a migration is a record of what happened, not a mirror of the current
// schema.
const PRICE_ROW_RE =
  /\('[^']+', '([^']+)', '([^']+)', (true|false), (true|false), '([^']+)', (\d+), (\d+), (?:(true|false), )?(?:'([^']*)', (\d+), (NULL::integer|\d+), )?'((?:[^']|'')*)', (true|false)\)/g;

const parsePriceRow = (match: RegExpMatchArray): MigrationPriceRow => ({
  modelId: match[1] ?? '',
  resolution: match[2] ?? '',
  videoInput: match[3] === 'true',
  audio: match[4] === 'true',
  unitKind: match[5] ?? '',
  baseCredits: Number(match[6]),
  baseUnits: Number(match[7]),
  flatRate: match[8] === 'true',
  // Absent on every pre-0078 row, and the defaults are what those rows MEAN: a row
  // written before the axes existed prices any mode and any reference count.
  mode: match[9] ?? 'any',
  refsMin: Number(match[10] ?? 0),
  refsMax: match[11] === undefined || match[11] === 'NULL::integer' ? null : Number(match[11]),
  sourceRef: (match[12] ?? '').replaceAll("''", "'"),
  isActive: match[13] === 'true',
});

const migrationPriceRows = [...(priceRowsMatch[1] ?? '').matchAll(PRICE_ROW_RE)].map(parsePriceRow);

const priceKey = (
  row: Pick<
    MigrationPriceRow,
    'modelId' | 'resolution' | 'videoInput' | 'audio' | 'mode' | 'refsMin'
  >,
) => [row.modelId, row.resolution, row.videoInput, row.audio, row.mode, row.refsMin].join('\u0000');

/**
 * Price rows a migration AFTER 0060 inserts or corrects. Models already had this
 * overlay; price points did not, so a rung added by a forward migration read as a
 * seed-only row that production would never receive — the exact class of gap the
 * flux routing fix was. Rev. 6's five rungs arrive this way in 0066.
 */
const forwardPriceRows: MigrationPriceRow[] = readdirSync(migrationsDir)
  .filter((file) => /^(\d+)_.*\.sql$/.test(file))
  .filter((file) => Number(/^(\d+)_/.exec(file)?.[1]) > 60)
  .sort()
  .flatMap((file) => {
    const sql = readFileSync(path.join(migrationsDir, file), 'utf8');
    const block =
      /WITH price_rows\([\s\S]*?\) AS \(\s*VALUES([\s\S]*?)\n\)\nINSERT INTO "model_price_points"/.exec(
        sql,
      );
    if (!block) return [];
    return [...(block[1] ?? '').matchAll(PRICE_ROW_RE)].map(parsePriceRow);
  });

const migrationPriceByKey = new Map(
  [...migrationPriceRows, ...forwardPriceRows].map((row) => [priceKey(row), row]),
);

// A retirement can be a narrow UPDATE rather than a replacement VALUES row: it
// changes one field on an existing selector and leaves every signed price field
// untouched. Overlay those statements too, otherwise a seed-side deactivation has no
// production counterpart and the parity check reports a false drift.
for (const file of readdirSync(migrationsDir)
  .filter((name) => /^(\d+)_.*\.sql$/.test(name))
  .filter((name) => Number(/^(\d+)_/.exec(name)?.[1]) > 60)
  .sort()) {
  const sql = readFileSync(path.join(migrationsDir, file), 'utf8');
  for (const statementMatch of sql.matchAll(/UPDATE\s+"model_price_points"\s+SET[\s\S]*?;/g)) {
    const statement = statementMatch[0] ?? '';
    const modelId = /"model_id"\s*=\s*'([^']+)'/.exec(statement)?.[1];
    const resolution = /"resolution"\s*=\s*'([^']+)'/.exec(statement)?.[1];
    const activeValue = /"is_active"\s*=\s*(true|false)/.exec(statement)?.[1];
    if (!modelId || !resolution || !activeValue) continue;

    const videoInput = /"video_input"\s*=\s*(true|false)/.exec(statement)?.[1] === 'true';
    const audio = /"audio"\s*=\s*(true|false)/.exec(statement)?.[1] === 'true';
    const mode = /"mode"\s*=\s*'([^']+)'/.exec(statement)?.[1] ?? 'any';
    const refsMin = Number(/"refs_min"\s*=\s*(\d+)/.exec(statement)?.[1] ?? 0);
    const key = priceKey({
      modelId,
      resolution,
      videoInput,
      audio,
      mode,
      refsMin,
    });
    // Only an exact selector can be attributed to exactly one seed row. A broad
    // retirement may use OR groups or IN lists; those are skipped because they cannot
    // prove which seed key they name.
    if (!statement.includes('OR') && !statement.includes('IN') && migrationPriceByKey.has(key)) {
      const prior = migrationPriceByKey.get(key)!;
      migrationPriceByKey.set(key, { ...prior, isActive: activeValue === 'true' });
    }
  }
}

const MODEL_COLUMNS = [
  'id',
  'provider',
  'family',
  'variant',
  'displayName',
  'kind',
  'isActive',
  'tierMin',
  'unitKind',
  'expectedLatencyMsP50',
  'expectedLatencyMsP95',
  'maxDurationSeconds',
  'maxResolution',
  'providerModelId',
  'providerEndpoint',
  'capabilities',
  'gatewayOverride',
  'fallbackGateway',
  'rightsModerationProvider',
] as const;

type ModelColumn = (typeof MODEL_COLUMNS)[number];

const SQL_COLUMN_BY_FIELD: Partial<Record<ModelColumn, string>> = {
  displayName: 'display_name',
  isActive: 'is_active',
  tierMin: 'tier_min',
  unitKind: 'unit_kind',
  expectedLatencyMsP50: 'expected_latency_ms_p50',
  expectedLatencyMsP95: 'expected_latency_ms_p95',
  maxDurationSeconds: 'max_duration_seconds',
  maxResolution: 'max_resolution',
  providerModelId: 'provider_model_id',
  providerEndpoint: 'provider_endpoint',
  gatewayOverride: 'gateway_override',
  fallbackGateway: 'fallback_gateway',
  rightsModerationProvider: 'rights_moderation_provider',
};

const sqlColumnFor = (field: ModelColumn): string => SQL_COLUMN_BY_FIELD[field] ?? field;

const MODEL_FIELD_BY_SQL_COLUMN: Partial<Record<string, ModelColumn>> = Object.fromEntries(
  MODEL_COLUMNS.map((field) => [sqlColumnFor(field), field]),
);

const forwardModelMigrationSql = readdirSync(migrationsDir)
  .filter((file) => /^(\d+)_.*\.sql$/.test(file))
  .filter((file) => Number(/^(\d+)_/.exec(file)?.[1]) > 60)
  .sort()
  .map((file) => readFileSync(path.join(migrationsDir, file), 'utf8'));

function modelAfterForwardMigrations(
  id: string,
  model: Record<string, unknown>,
): Record<string, unknown> {
  return forwardModelMigrationSql.reduce((current, sql) => {
    // The WHERE tail may carry AND-guards (e.g. 0108 flips a pin only when it still
    // holds the 0107 default). A guard only NARROWS which rows the update touches;
    // the parity model reconstructs a fresh-from-0060 row that the guard admits, so
    // modeling the update as applied is correct.
    const updates = sql.matchAll(
      /UPDATE\s+"models"\s+SET\s+([\s\S]*?)\s+WHERE\s+"id"\s*=\s*'([^']+)'[\s\S]*?;/g,
    );
    let next = current;
    for (const update of updates) {
      if (update[2] !== id) continue;
      const set = update[1] ?? '';
      next = { ...next };
      for (const [sqlColumn, field] of Object.entries(MODEL_FIELD_BY_SQL_COLUMN)) {
        if (!field || field === 'id' || field === 'capabilities') continue;
        // Quoted values AND bare numerics: an integer column like
        // `expected_latency_ms_p50` is written `= 5000`, not `= '5000'`. A
        // quoted-only pattern skipped it silently and the parity check then
        // compared prod against a value no migration had ever set.
        // Quoted strings, bare integers AND bare booleans.
        // was skipped silently by a quoted-only pattern; `is_active = false` would be
        // skipped the same way, so a withdrawal migration would read as never applied.
        const match = new RegExp(
          // COALESCE("col", 'lit') models the seed's conflict doctrine verbatim
          // (fill a NULL from the seed default, keep an existing admin pin —
          // the O-1 routing pins, migration 0107).
          `"${sqlColumn}"\\s*=\\s*(?:COALESCE\\("${sqlColumn}",\\s*'((?:[^']|'')*)'\\)|'((?:[^']|'')*)'|(-?\\d+)|(true|false))`,
        ).exec(set);
        if (match) {
          if (match[1] !== undefined) next[field] = match[1].replaceAll("''", "'");
          else if (match[2] !== undefined) next[field] = match[2].replaceAll("''", "'");
          else if (match[3] !== undefined) next[field] = Number(match[3]);
          else next[field] = match[4] === 'true';
        }
      }
      if (set.includes('"capabilities"')) {
        const capabilities = {
          ...((next['capabilities'] ?? {}) as Record<string, unknown>),
        };
        for (const removed of set.matchAll(/"capabilities"\s*-\s*'([^']+)'/g)) {
          delete capabilities[removed[1]!];
        }
        for (const merged of set.matchAll(/\|\|\s*'({[^']*})'::jsonb/g)) {
          Object.assign(capabilities, JSON.parse(merged[1]!));
        }
        next['capabilities'] = capabilities;
      }
    }
    return next;
  }, model);
}

const rowShape = (row: Record<string, unknown>) =>
  Object.fromEntries(
    MODEL_COLUMNS.map((field) => [
      field,
      field === 'rightsModerationProvider' ? (row[field] ?? 'internal') : (row[field] ?? null),
    ]),
  );

describe('v14 model migration parity', () => {
  it('produces each touched model field-for-field from the seed, including top-level routing', () => {
    expect(migrationModels.size).toBe(24);

    for (const [id, migrationModel] of migrationModels) {
      const seedModel = seedModelById.get(id);
      expect(seedModel, `0055 references unknown seed model '${id}'`).toBeTruthy();
      expect(
        rowShape(modelAfterForwardMigrations(id, migrationModel)),
        `0060/0061 drift for '${id}'`,
      ).toEqual(rowShape(seedModel as unknown as Record<string, unknown>));
    }
  });

  it('uses a forward-only migration to correct Gemini Omni capabilities in production', () => {
    expect(omniReferenceMigrationSql).toContain('UPDATE "models"');
    expect(omniReferenceMigrationSql).toContain('"capabilities" - \'frames\'');
    expect(omniReferenceMigrationSql).toContain('"maxVideoRefs":0');
    expect(omniReferenceMigrationSql).toContain('"maxAudioRefs":0');
  });

  it('repairs the historical Veo INSERT omission that defaulted flat_rate to false', () => {
    expect(veoFlatRateRepairMigrationSql).toContain('SET "flat_rate" = true');
    expect(veoFlatRateRepairMigrationSql).toContain("\"resolution\" IN ('720p', '1080p', '4K')");
    expect(veoFlatRateRepairMigrationSql).toContain('"audio" = true');
    expect(veoFlatRateRepairMigrationSql).toContain('veo_rows <> 9');
    expect(veoFlatRateRepairMigrationSql).toContain('"flat_rate" IS NOT TRUE');
  });

  it('produces each price point field-for-field from PRICE_POINT_SEED', () => {
    // Forward migrations now CORRECT existing v14 keys, so counting every VALUES row
    // would count historical and replacement versions as if they were distinct price
    // configurations. Overlay in journal order (the map above), then check the latest
    // production value for every seed key. Old audio=false Veo/Kling/Omni identities
    // deliberately remain as inactive additive history and are not seed rows.
    expect(new Set(PRICE_POINT_SEED.map(priceKey)).size).toBe(PRICE_POINT_SEED.length);

    for (const seedPoint of PRICE_POINT_SEED) {
      const migrationPoint = migrationPriceByKey.get(priceKey(seedPoint));
      expect(
        migrationPoint,
        `no migration has a price row for ${seedPoint.modelId} @ ${seedPoint.resolution}`,
      ).toEqual({
        modelId: seedPoint.modelId,
        resolution: seedPoint.resolution,
        videoInput: seedPoint.videoInput,
        audio: seedPoint.audio,
        unitKind: seedPoint.unitKind,
        baseCredits: seedPoint.baseCredits,
        baseUnits: seedPoint.baseUnits,
        flatRate: seedPoint.flatRate,
        mode: seedPoint.mode,
        refsMin: seedPoint.refsMin,
        refsMax: seedPoint.refsMax,
        sourceRef: seedPoint.sourceRef,
        isActive: seedPoint.isActive,
      });
    }
  });

  it('updates every mutable price field on conflict, rather than leaving prod on its old row', () => {
    const conflictUpdate = migrationSql.match(
      /ON CONFLICT \("model_id", "resolution", "video_input", "audio"\) DO UPDATE\s+SET([\s\S]*?);/,
    );
    expect(conflictUpdate, '0055 must update an existing price point').toBeTruthy();
    const conflictUpdateSql = conflictUpdate?.[1];
    if (!conflictUpdateSql) throw new Error('0055 price conflict update body not found');

    for (const column of ['unit_kind', 'base_credits', 'base_units', 'source_ref', 'is_active']) {
      expect(conflictUpdateSql, `0055 conflict path forgets '${column}'`).toContain(
        `"${column}" = EXCLUDED."${column}"`,
      );
    }
  });

  it('applies every non-id model column on conflict, rather than leaving prod on its old row', () => {
    const conflictUpdate = migrationSql.match(/ON CONFLICT \("id"\) DO UPDATE SET([\s\S]*?);/);
    expect(conflictUpdate, '0055 must update an existing model row').toBeTruthy();
    const conflictUpdateSql = conflictUpdate?.[1];
    if (!conflictUpdateSql) throw new Error('0055 conflict update body not found');

    for (const field of MODEL_COLUMNS.filter(
      // display_name did not exist when 0060's INSERT ... ON CONFLICT was
      // authored; its own forward migration is applied by the reconstruction.
      (field) => field !== 'id' && field !== 'capabilities' && field !== 'displayName',
    )) {
      const column = sqlColumnFor(field);
      expect(
        conflictUpdateSql,
        `0055 conflict path forgets top-level '${field}' (${column})`,
      ).toContain(`"${column}" = EXCLUDED."${column}"`);
    }
    expect(conflictUpdateSql).toContain(
      '"capabilities" = "models"."capabilities" || EXCLUDED."capabilities"',
    );
  });
});

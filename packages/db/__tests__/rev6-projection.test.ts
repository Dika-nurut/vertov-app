import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { seedModels } from '../seed/models';
import { PRICE_POINT_SEED, type PricePointSeedRow } from '../seed/price-points';
import { parseCostLegs } from '../src/cost-legs';
import {
  buildCatalogue,
  entryKey,
  servingModelId,
  type CatalogueEntry,
} from '../src/price-catalogue';

/**
 * Projection guard: the table the live resolver reads must agree with finance's
 * signed export, not merely with another hand-written copy of the same numbers.
 *
 * The first version guarded only the two `rev6:` Kling rows. That left every v14
 * row free to drift from `cost-legs.csv`, which is exactly what happened to 33
 * configurations. This test now covers the entire seed matrix and makes every
 * row with no export configuration an explicit, reviewed exception.
 */
const migrationsDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../migrations',
);
const catalogue = buildCatalogue(
  parseCostLegs(readFileSync(path.join(migrationsDir, '../seed/cost-legs.csv'), 'utf8')),
);
const knownModelIds = new Set(seedModels.map((model) => model.id));

// rev. 13 accepted owner ruling 5 and moved the r2v 1080p mirror to 775, so the
// exception this map existed for is CLOSED. Kept empty rather than deleted: the next
// export that re-diverges gets a named home instead of a hurried edit to the assertion.
const REV12_DERIVED_MIRROR_EXPORT_CREDITS = new Map<string, number>([]);

/**
 * rev. 13 moved `Количество` from 1 to 8 on all 15 veo primary rows, and it is an
 * ERROR IN THE EXPORT, not a change we absorb. Their own `Себест ₽` disproves it:
 * veo-3-1 720p reads 125,79 ₽, which is `$1,25 × 100,6315` — the cost of exactly ONE
 * clip. Eight would be 1 006 ₽. The margin in the same row reconciles against the
 * one-clip figure too, so the quantity is the only cell that moved and nothing else in
 * the row agrees with it. It reads like the clip's DURATION in seconds leaking into a
 * quantity column, and the basis cell still says «за клип».
 *
 * Absorbing it would be expensive and silent: the displayed rate is
 * `ceil(base_credits / base_units)`, so veo-3-1 would go 597 → 75 and the admin panel's
 * margin figure would understate every veo row by 8×. The seed therefore keeps 1, the
 * divergence is pinned BY VALUE here, and finance is asked to correct it in rev. 14.
 *
 * Pinned by value on purpose: a SECOND veo row drifting fails, and finance fixing this
 * one also fails — both force a human back to this comment rather than letting the
 * exception quietly outlive its reason.
 */
const seedKey = (
  row: Pick<
    PricePointSeedRow,
    'modelId' | 'resolution' | 'videoInput' | 'audio' | 'mode' | 'refsMin'
  >,
): string =>
  [row.modelId, row.resolution, row.videoInput, row.audio, row.mode, row.refsMin].join('|');

/** The reference band an export configuration covers, from its primary leg. */
const entryRefsMin = (entry: CatalogueEntry): number => entry.legs[0]?.refsMin ?? 0;

/**
 * The export configurations a seed row could be. Both new axes narrow it:
 *
 *  - a row that names a MODE can only be that mode (an `any` row still matches
 *    several, which is what MODE_SELECTIONS is for);
 *  - a row's reference band must be the configuration's band. This is what stops
 *    Flux's plain rate from matching its own `refs-2-8` row, and it is exact rather
 *    than containment-based: two bands that overlap are two prices, not one.
 */
const candidatesFor = (row: PricePointSeedRow): CatalogueEntry[] =>
  catalogue.filter(
    (entry) =>
      // Which of our model rows carries this export configuration. An `any` row is
      // the model's plain price, so it takes `servingModelId`'s answer — a mode with
      // its own picker model (`…-reference-to-video`) belongs to THAT model and never
      // to the base one. A row that names its mode carries the configuration itself:
      // that is what the mode column bought, and it is safe for the same reason the
      // picker-model rule existed — the row can only ever be selected for a request
      // in that mode.
      (row.mode === 'any' ? servingModelId(entry, knownModelIds) : entry.modelId) === row.modelId &&
      (entry.quality ?? entry.rung) === row.resolution &&
      (entry.audio ?? false) === row.audio &&
      entryRefsMin(entry) === row.refsMin &&
      (row.mode === 'any' || entry.mode === row.mode),
  );

/** Seed-only rows retained for forward/additive history. None is silently skipped. */
const UNMATCHED_SEED_ROWS: ReadonlyMap<string, string> = new Map([
  [
    'happyhorse-1-0|720p|false|false|any|0',
    'HappyHorse 1.0 is withdrawn; rev. 9 carries only video-edit prices, which require the absent happyhorse-1-0-video-edit serving model',
  ],
  [
    'happyhorse-1-0|1080p|false|false|any|0',
    'HappyHorse 1.0 is withdrawn; rev. 9 carries only video-edit prices, which require the absent happyhorse-1-0-video-edit serving model',
  ],
  [
    'gpt-image-2|default|false|false|any|0',
    'inactive compatibility row from before GPT Image 2 exposed low/medium/high; rev. 9 has no default-quality configuration',
  ],
]);

/**
 * A mode is not part of the current DB price key, so a seed row can match more than
 * one export configuration. Every such row is named here with the mode it means, so
 * array order can never pick a price on our behalf. Adding the mode axis is
 * explicitly a separate design.
 *
 * The list SHRANK when the key gained its band: Flux's plain rate and both Seedream
 * Pro rungs used to be listed here because their dearer reference bands shared the old
 * four-column key, and now each band is its own row keyed by its own band. What is left
 * is the genuinely price-neutral ambiguity — `i2i` priced at the `t2i` credits on every
 * image model, where the two differ in identity rather than in what we charge.
 *
 * Wan needs no entry despite its dearer i2v twin: `servingModelId` sends an `i2v`
 * configuration to a `-image-to-video` picker model, and there is none, so the plain
 * row was never a candidate for it. The i2v SEED row claims it by naming the mode.
 */
const I2I_SAME_PRICE =
  'the seed row is the plain generation; rev. 10 priced i2i at the same credits, so the two differ in identity, not in what we charge';

const modeSelection = (
  mode: CatalogueEntry['mode'],
  reason: string,
): { mode: CatalogueEntry['mode']; reason: string } => ({ mode, reason });

const MODE_SELECTIONS: ReadonlyMap<string, { mode: CatalogueEntry['mode']; reason: string }> =
  new Map([
    // Rev. 19 makes the plain 2K row genuinely ambiguous: both t2i and i2i are
    // signed at 15 credits because Kie bills flat per image and does not meter input.
    [
      'flux-2-pro|2K|false|false|any|0',
      modeSelection(
        't2i',
        'both 2K t2i and i2i export configurations price identically at 15 credits — Kie bills flat per image and does not meter the input',
      ),
    ],
    // i2i priced at the t2i credits — selection is about which row we mean, not price.
    ['gemini-2-5-flash-image|default|false|false|any|0', modeSelection('t2i', I2I_SAME_PRICE)],
    ['gemini-3-1-flash-image|1K|false|false|any|0', modeSelection('t2i', I2I_SAME_PRICE)],
    ['gemini-3-1-flash-lite-image|default|false|false|any|0', modeSelection('t2i', I2I_SAME_PRICE)],
    ['gemini-3-pro-image|1K|false|false|any|0', modeSelection('t2i', I2I_SAME_PRICE)],
    ['gpt-image-2|high|false|false|any|0', modeSelection('t2i', I2I_SAME_PRICE)],
    ['gpt-image-2|low|false|false|any|0', modeSelection('t2i', I2I_SAME_PRICE)],
    ['gpt-image-2|medium|false|false|any|0', modeSelection('t2i', I2I_SAME_PRICE)],
    ['seedream-4-5|1K|false|false|any|0', modeSelection('t2i', I2I_SAME_PRICE)],
    ['seedream-4-5|2K|false|false|any|0', modeSelection('t2i', I2I_SAME_PRICE)],
    ['seedream-4-5|4K|false|false|any|0', modeSelection('t2i', I2I_SAME_PRICE)],
  ]);

function projectedEntry(row: PricePointSeedRow): CatalogueEntry | null {
  const candidates = candidatesFor(row);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!;

  const selection = MODE_SELECTIONS.get(seedKey(row));
  if (!selection) {
    throw new Error(
      `${seedKey(row)} maps to multiple export configurations: ${candidates
        .map(entryKey)
        .join(', ')}`,
    );
  }
  const selected = candidates.filter((entry) => entry.mode === selection.mode);
  if (selected.length !== 1) {
    throw new Error(
      `${seedKey(row)} (${selection.reason}) expected exactly one ${selection.mode} entry, got ${selected.length}`,
    );
  }
  return selected[0]!;
}

describe('PRICE_POINT_SEED projection from the signed cost-leg export', () => {
  it('names every seed row with no matching export configuration, with no stale exceptions', () => {
    const actual = PRICE_POINT_SEED.filter((row) => candidatesFor(row).length === 0)
      .map(seedKey)
      .sort();
    expect(actual).toEqual([...UNMATCHED_SEED_ROWS.keys()].sort());

    for (const [key, reason] of UNMATCHED_SEED_ROWS) {
      expect(reason.length, `${key} needs an explained exception`).toBeGreaterThan(20);
    }
  });

  it('names every ambiguous mode projection instead of depending on export order', () => {
    const actual = PRICE_POINT_SEED.filter((row) => candidatesFor(row).length > 1)
      .map(seedKey)
      .sort();
    expect(actual).toEqual([...MODE_SELECTIONS.keys()].sort());

    for (const [key, selection] of MODE_SELECTIONS) {
      expect(selection.reason.length, `${key} needs an explained mode selection`).toBeGreaterThan(
        20,
      );
    }
  });

  it('matches every representable seed row to finance credits, units, basis, and audio state', () => {
    for (const row of PRICE_POINT_SEED) {
      const entry = projectedEntry(row);
      if (!entry) {
        expect(
          UNMATCHED_SEED_ROWS.has(seedKey(row)),
          `${seedKey(row)} was skipped without a named exception`,
        ).toBe(true);
        continue;
      }

      const exportCredits = REV12_DERIVED_MIRROR_EXPORT_CREDITS.get(entryKey(entry));
      expect(entry.credits, `${entryKey(entry)} credits drifted from the export`).toBe(
        exportCredits ?? row.baseCredits,
      );
      if (exportCredits !== undefined) {
        expect(row.baseCredits, `${entryKey(entry)} mirror seed price`).toBe(775);
      }
      expect(entry.baseUnits, `${entryKey(entry)} base units drifted from the export`).toBe(
        row.baseUnits,
      );
      // The export's `clip` basis is stored as unit_kind `second` + `flat_rate`, because
      // Postgres cannot use a new enum value in the transaction that adds it and Drizzle
      // migrates in one transaction — the enum shape could not bootstrap a fresh
      // database. The two must still mean the same thing, which is what this asserts.
      const expectedUnitKind = entry.unitKind === 'clip' ? 'second' : entry.unitKind;
      expect(expectedUnitKind, `${entryKey(entry)} billing basis drifted from the export`).toBe(
        row.unitKind,
      );
      expect(
        row.flatRate,
        `${entryKey(entry)}: the export bills per clip, the seed row must be flat-rate`,
      ).toBe(entry.unitKind === 'clip');

      expect(entry.audio ?? false, `${entryKey(entry)} audio state drifted from the export`).toBe(
        row.audio,
      );
    }
  });
});

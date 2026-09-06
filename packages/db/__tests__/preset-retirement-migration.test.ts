import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPresetPackRows } from '../seed/preset-packs';

/**
 * The seed's preset upsert rewrites `model_id` AND `params_json` from the definition,
 * so a migration that moves only the model is not "the same change offline" — it is
 * worse than none. Seedream 4.5 sold 4K; 5.0 Pro declares only 1K and 2K, and the price
 * key reads the DECLARED list, so a repointed-but-unclamped row prices nothing and the
 * charge is refused outright.
 *
 * This binds the migration to the seed rather than to its own prose: if someone changes
 * what a preset asks for, the migration that carries it to live rows has to follow.
 */
describe('Seedream 4.5 preset retirement migration', () => {
  const sql = readFileSync(
    join(__dirname, '../migrations/0089_repoint_retired_seedream_presets.sql'),
    'utf8',
  );
  const seeded = buildPresetPackRows();
  const rungOf = (slug: string): string => {
    const row = seeded.find((candidate) => candidate.slug === slug);
    expect(row, `${slug}: no seeded preset to bind against`).toBeTruthy();
    return String((row!.paramsJson as Record<string, unknown>)['resolution']);
  };

  it('repoints every retired row to the model the seed now names', () => {
    expect(sql).toMatch(/"model_id"\s*=\s*'seedream-5-0-pro'/);
    expect(sql).toMatch(/WHERE\s+"model_id"\s*=\s*'seedream-4-5'/i);
  });

  it('carries the rung the seed corrected, not just the model', () => {
    // The figurine demo is the row that breaks: it asked for 4K as a 4.5 preset.
    expect(rungOf('demo-seedream-4-0-figurine')).toBe('2K');
    expect(sql).toMatch(/jsonb_set\("params_json",\s*'\{resolution\}',\s*'"2K"'\)/);
    expect(sql).toMatch(/'resolution'\s*=\s*'4K'/);
  });

  it('carries the gpt-image-2 quality tier the seed corrected in the same audit', () => {
    // Same class, different cause: a raw pixel size where the vendor sells tiers.
    expect(rungOf('demo-gpt-image-2-film-poster')).toBe('high');
    expect(sql).toMatch(/jsonb_set\("params_json",\s*'\{resolution\}',\s*'"high"'\)/);
    expect(sql).toMatch(/'resolution'\s*=\s*'1536x1024'/);
  });

  it('is forward-only and additive — it rewrites rows, it does not drop anything', () => {
    expect(sql).not.toMatch(/\bDROP\b|\bDELETE\b|\bTRUNCATE\b/i);
  });
});

describe('HappyHorse 1.0 preset delist migration', () => {
  const sql = readFileSync(
    join(__dirname, '../migrations/0094_delist_happyhorse_1_0.sql'),
    'utf8',
  );
  const seeded = buildPresetPackRows();
  const legacySlugs = [
    'demo-happyhorse-1-0-inflate-kie',
    'demo-happyhorse-1-0-inflate-atlas',
  ];

  it('keeps both legacy slugs pointed at the replacement model in the seed', () => {
    for (const slug of legacySlugs) {
      const rows = seeded.filter((row) => row.slug === slug);
      expect(rows.length, `${slug}: expected seeded locales`).toBeGreaterThan(0);
      expect(new Set(rows.map((row) => row.modelId))).toEqual(new Set(['happyhorse-1-1']));
    }
  });

  it('repoints existing production rows because deploy does not rerun the seed', () => {
    expect(sql).toMatch(/UPDATE\s+"preset_packs"[\s\S]*?SET\s+"model_id"\s*=\s*'happyhorse-1-1'/i);
    for (const slug of legacySlugs) expect(sql).toContain(`'${slug}'`);
  });
});

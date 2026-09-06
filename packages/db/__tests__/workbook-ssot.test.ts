import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { seedModels } from '../seed/models';
import { PRICE_POINT_SEED } from '../seed/price-points';
import { costLegFile } from '../src/cost-legs-data';
import {
  WORKBOOK_SSOT,
  workbookCostForPoint,
  workbookEntryForPoint,
} from '../src/workbook-cost-model';
import { realGateway } from '../src/price-breakeven';
import llmPricing from '../seed/llm-pricing.generated.json';
import existingSheetHashes from '../seed/workbook-existing-sheet-sha256.json';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const workbookPath = resolve(
  here,
  '../../../docs/business/pricing-workbook/Vertov_Pricing_Model_v14_2026-07-28.xlsx',
);

describe('pricing workbook is the media pricing SSOT', () => {
  it('pins the committed workbook bytes to the generated export provenance', () => {
    const digest = createHash('sha256').update(readFileSync(workbookPath)).digest('hex');
    expect(digest).toBe(WORKBOOK_SSOT.sha256);
    expect(costLegFile.declared.source).toContain('Vertov_Pricing_Model_v14');
    expect(costLegFile.declared.rows).toBe(140);
    expect(costLegFile.declared.credits).toBe(26729);
    expect(costLegFile.declared.margin).toBeCloseTo(35.241635, 6);
    expect(costLegFile.declared.hash).toBe(WORKBOOK_SSOT.exportHash16);
    expect(costLegFile.declared.columns).toBe(WORKBOOK_SSOT.exportColumnsHash16);
  });

  it('matches every non-derived price point to workbook credits and quantity', () => {
    const explicitExceptions = new Set([
      // The delisted 1.0 rows are retained for historical reconciliation; the
      // current workbook carries only video-edit rows, not a sellable t2v rung.
      'happyhorse-1-0|720p',
      'happyhorse-1-0|1080p',
    ]);

    for (const point of PRICE_POINT_SEED) {
      const entry = workbookEntryForPoint(point);
      const key = `${point.modelId}|${point.resolution}`;
      if (point.sourceRef.startsWith('derived:') || explicitExceptions.has(key)) {
        expect(entry, `${key} is an intentional non-workbook exception`).toBeNull();
        continue;
      }
      expect(entry, `${key} has no signed workbook configuration`).not.toBeNull();
      expect(entry!.credits, `${key} credit price drifted from workbook`).toBe(point.baseCredits);
      expect(entry!.baseUnits, `${key} quantity drifted from workbook`).toBe(point.baseUnits);
    }
  });

  it('has an exact signed COGS leg for every active row at its actual route', () => {
    for (const point of PRICE_POINT_SEED.filter((row) => row.isActive)) {
      const model = seedModels.find((candidate) => candidate.id === point.modelId);
      if (!model) throw new Error(`missing seed model ${point.modelId}`);
      const cost = workbookCostForPoint(point, realGateway(model as never));
      expect(
        cost,
        `${point.modelId}/${point.resolution} has no routed workbook leg`,
      ).not.toBeNull();
      expect(cost!.entry.credits).toBe(point.baseCredits);
      expect(cost!.entry.baseUnits).toBe(point.baseUnits);
    }
  });

  it('keeps reference picker faces distinct from their priced request modes', () => {
    const imageMirror = PRICE_POINT_SEED.find(
      (point) =>
        point.modelId === 'seedance-2-0-reference-to-video' &&
        point.resolution === '720p' &&
        point.videoInput === false,
    );
    const videoReference = PRICE_POINT_SEED.find(
      (point) =>
        point.modelId === 'seedance-2-0-reference-to-video' &&
        point.resolution === '720p' &&
        point.videoInput === true,
    );
    expect(imageMirror).toBeDefined();
    expect(videoReference).toBeDefined();
    expect(workbookEntryForPoint(imageMirror!)?.mode).toBe('t2v');
    expect(workbookEntryForPoint(videoReference!)?.mode).toBe('r2v');
  });
});

describe('pricing workbook is the LLM pricing SSOT', () => {
  it(
    'keeps the committed runtime export identical to a fresh workbook import',
    () => {
      execFileSync('pnpm', ['run', 'check:llm-pricing'], {
        cwd: resolve(here, '..'),
        stdio: 'pipe',
      });
    },
    // Spawns `pnpm → tsx → xlsx-parse` as a fresh process. In isolation that is
    // ~3s, but the prepush pyramid runs every package's suite concurrently and
    // the spawn competes for CPU with ~10 other vitest workers — 16s+ observed
    // (2026-09-04), tripping the 15s package default on a green repo.
    { timeout: 60_000 },
  );

  it('preserves every pre-existing worksheet part byte-for-byte', () => {
    for (const [part, expected] of Object.entries(existingSheetHashes.sheets)) {
      const bytes = execFileSync('unzip', ['-p', workbookPath, part]);
      expect(createHash('sha256').update(bytes).digest('hex'), part).toBe(expected);
    }
  });

  it('pins the generated LLM export to the same committed workbook bytes', () => {
    const digest = createHash('sha256').update(readFileSync(workbookPath)).digest('hex');
    expect(llmPricing.workbook.sha256).toBe(digest);
    expect(llmPricing.workbook.sha256).toBe(WORKBOOK_SSOT.sha256);
    expect(llmPricing.workbook.sheet).toBe('LLM ЦЕНЫ');
    expect(llmPricing.workbook.capturedOn).toBe('2026-08-13');
  });

  it('exports all paid text models, providers, rates and bounded product envelopes', () => {
    const boards = llmPricing.records.filter((row) => row.surface === 'boards_prompt_studio');
    expect(boards.map((row) => row.selector)).toEqual(['gemini', 'claude', 'gpt']);
    expect(boards.map((row) => row.model)).toEqual([
      'google/gemini-3-flash-preview',
      'anthropic/claude-sonnet-5',
      'openai/gpt-5.6-terra',
    ]);
    for (const row of boards) {
      expect(row.primaryProvider).toBe('Kie');
      expect(row.fallbackProvider).toBe('OpenRouter');
      expect(row.maxTokenBudget).toEqual({ input: 2400, output: 400 });
      expect(row.briefCharLimit).toBe(1000);
      expect(row.resultCharLimit).toBe(1000);
      expect(row.charsPerToken).toBe(1.5);
    }
    expect(llmPricing.records.some((row) => row.model === 'qwen/qwen3.5-plus-02-15')).toBe(true);
    expect(llmPricing.records.some((row) => row.model === 'deepseek/deepseek-v4-flash')).toBe(true);

    const scenario = llmPricing.records.filter((row) => row.surface === 'scenario_assist_price');
    expect(scenario).toHaveLength(12);
    expect(scenario.every((row) => row.credits > 0 && row.marginAtFloor >= 0.07)).toBe(true);
    expect(llmPricing.financial.marginFloor).toBe(0.25);
    expect(llmPricing.financial.scenarioMarginFloor).toBe(0.07);
    expect(
      llmPricing.records
        .filter(
          (row) => row.surface === 'boards_prompt_studio' || row.surface === 'boards_shot_plan',
        )
        .every((row) => row.marginAtFloor >= llmPricing.financial.marginFloor),
    ).toBe(true);
    expect(
      scenario
        .filter((row) => row.selector.startsWith('economy/'))
        .every((row) => row.primaryMaxAttempts === 2),
    ).toBe(true);
    expect(
      scenario
        .filter((row) => !row.selector.startsWith('economy/'))
        .every((row) => row.primaryMaxAttempts === 1 && row.fallbackMaxAttempts === 2),
    ).toBe(true);

    for (const key of [
      'scenario_structurize:economy',
      'scenario_structurize_active:economy/active',
      'boards_shot_plan:default',
      'boards_scene_objects:default',
      'scenario_material_compaction:background',
      'disabled_prompt_enhancer:generate',
    ]) {
      expect(
        llmPricing.records.some((row) => `${row.surface}:${row.selector}` === key),
        `missing workbook LLM surface ${key}`,
      ).toBe(true);
    }
  });
});

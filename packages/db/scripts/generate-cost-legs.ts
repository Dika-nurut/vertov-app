import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { parseCostLegs, type CostLeg, type CostLegFile } from '../src/cost-legs';

/**
 * Render the parsed export with a stable object shape. The field order is
 * deliberately written out instead of relying on interface order or a JSON
 * serializer's treatment of an object assembled somewhere else.
 */
export function renderCostLegFile(file: CostLegFile): string {
  const leg = (value: CostLeg): CostLeg => ({
    modelId: value.modelId,
    rung: value.rung,
    mode: value.mode,
    audio: value.audio,
    quality: value.quality,
    leg: value.leg,
    role: value.role,
    relay: value.relay,
    upstream: value.upstream,
    providerSku: value.providerSku,
    channel: value.channel,
    fxMultiplier: value.fxMultiplier,
    basis: value.basis,
    usdPerUnit: value.usdPerUnit,
    landedRubPerUnit: value.landedRubPerUnit,
    costRubDisplay: value.costRubDisplay,
    costKnown: value.costKnown,
    confidence: value.confidence,
    credits: value.credits,
    margin: value.margin,
    ladderDepth: value.ladderDepth,
    source: value.source,
    capturedOn: value.capturedOn,
    aspect: value.aspect,
    refsMin: value.refsMin,
    refsMax: value.refsMax,
    bandPricing: value.bandPricing,
    perImageSurchargeUsd: value.perImageSurchargeUsd,
    rowKey: value.rowKey,
    quantity: value.quantity,
    routeRisk: value.routeRisk,
    defaultRung: value.defaultRung,
    areaMp: value.areaMp,
  });

  const canonical = {
    legs: file.legs.map(leg),
    excluded: file.excluded.map((row) => ({ position: row.position, reason: row.reason })),
    declared: {
      rows: file.declared.rows,
      credits: file.declared.credits,
      margin: file.declared.margin,
      source: file.declared.source,
      hash: file.declared.hash,
      columns: file.declared.columns,
    },
  };
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

export function generateCostLegs(csvPath: string, outputPath: string): void {
  const file = parseCostLegs(readFileSync(csvPath, 'utf8'));
  writeFileSync(outputPath, renderCostLegFile(file), 'utf8');
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const packageRoot = dirname(dirname(scriptPath));
  generateCostLegs(
    join(packageRoot, 'seed/cost-legs.csv'),
    join(packageRoot, 'seed/cost-legs.generated.json'),
  );
}

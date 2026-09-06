import { describe, expect, it } from 'vitest';
import { costLegFile } from '@seed/db';
import { SIGNED_CHAIN_LEG_ORDER } from './relay-gateway';

/**
 * The hardcoded per-rung leg order must quote the export it claims to come from.
 *
 * `SIGNED_CHAIN_LEG_ORDER` carries the ORDER and the SIGNED MARGINS as one hand-written
 * literal, so checking one against the other proves only that whoever typed it was
 * internally consistent — a row whose order and margins drift together passes. Both have
 * to be checked against the thing they are copied FROM, which is the finance export.
 *
 * This lives in `shared` rather than beside the other cost-leg tests because `db` cannot
 * import `shared`: the dependency runs the other way.
 */
describe('the signed chain leg order quotes the export', () => {
  const relayToGateway: Record<string, string> = {
    Kie: 'kie',
    LaoZhang: 'laozhang',
    OpenRouter: 'openrouter',
    AtlasCloud: 'atlascloud',
  };

  it('runs each rung in the export’s leg order, at the export’s margins', () => {
    expect(SIGNED_CHAIN_LEG_ORDER.length).toBeGreaterThan(0);
    for (const row of SIGNED_CHAIN_LEG_ORDER) {
      // t2i is the mode the table was written against; i2i mirrors it leg for leg.
      const exported = costLegFile.legs
        .filter((leg) => leg.modelId === row.modelId && leg.rung === row.rung && leg.mode === 't2i')
        .sort((a, b) => a.leg - b.leg);
      const label = `${row.modelId}|${row.rung}`;
      expect(exported.length, `${label}: no exported legs to quote`).toBeGreaterThan(0);

      expect(
        exported.map((leg) => relayToGateway[leg.relay] ?? leg.relay),
        `${label}: order must be the export's own leg order`,
      ).toEqual([...row.order]);

      for (const leg of exported) {
        const gateway = relayToGateway[leg.relay] ?? leg.relay;
        expect(
          row.signedMargin[gateway as keyof typeof row.signedMargin],
          `${label}|${gateway}: margin must be the export's`,
        ).toBeCloseTo(leg.margin, 4);
      }
    }
  });
});

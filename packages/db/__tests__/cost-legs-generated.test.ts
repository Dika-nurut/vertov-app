import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCostLegs } from '../src/cost-legs';
import { renderCostLegFile } from '../scripts/generate-cost-legs';

const CSV_PATH = join(__dirname, '../seed/cost-legs.csv');
const JSON_PATH = join(__dirname, '../seed/cost-legs.generated.json');

describe('generated cost-leg data', () => {
  it('is byte-identical to a fresh canonical render of the CSV', () => {
    const csv = parseCostLegs(readFileSync(CSV_PATH, 'utf8'));
    const committed = readFileSync(JSON_PATH, 'utf8');
    expect(renderCostLegFile(csv)).toBe(committed);
  });

  /**
   * The renderer writes its field list out by hand, so a column the parser gains is
   * dropped here unless someone remembers to add it — and the identity test above cannot
   * see that, because the fresh render and the committed file drop it identically.
   *
   * rev. 15 is the case that forced this: `РИСК МАРШРУТА` and `ступень_по_умолчанию`
   * parsed correctly and reached nothing, because `costLegFile` is this generated JSON and
   * not the parser. `tsc` did flag it; a suite that stays green while a signed column
   * silently disappears should not have.
   */
  it('renders every field the parser produces, so a new column cannot vanish here', () => {
    const csv = parseCostLegs(readFileSync(CSV_PATH, 'utf8'));
    const rendered = JSON.parse(renderCostLegFile(csv)) as { legs: Record<string, unknown>[] };
    expect(Object.keys(rendered.legs[0]!).sort()).toEqual(Object.keys(csv.legs[0]!).sort());
  });
});

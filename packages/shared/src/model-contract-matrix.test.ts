import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { byteplusRouteContracts } from './model-contract-byteplus';
import { renderContractMatrix } from './model-contract-matrix';

const DOC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../docs/platform/model-gateway-contract-matrix.md',
);

/**
 * Sync guard (execution plan DoD 10): the committed matrix doc must equal what the
 * registry generates. If a contract changes and the doc is not regenerated, CI
 * fails here. Regenerate with:
 *   pnpm --filter @seed/shared exec tsx -e "import {renderContractMatrix} from
 *   './src/model-contract-matrix'; import {byteplusRouteContracts} from
 *   './src/model-contract-byteplus'; import {writeFileSync} from 'node:fs';
 *   writeFileSync('../../docs/platform/model-gateway-contract-matrix.md',
 *   renderContractMatrix(byteplusRouteContracts));"
 */
describe('model-gateway contract matrix', () => {
  it('committed doc matches the registry-generated matrix', () => {
    const committed = readFileSync(DOC, 'utf8');
    expect(committed).toBe(renderContractMatrix(byteplusRouteContracts));
  });

  it('renders one data row per contract', () => {
    const rows = renderContractMatrix(byteplusRouteContracts)
      .split('\n')
      .filter((l) => l.startsWith('| ') && !l.includes('---') && !l.startsWith('| Model'));
    const total = Object.values(byteplusRouteContracts).reduce((n, r) => n + r.length, 0);
    expect(rows).toHaveLength(total);
  });

  it('routes Seedream 4.5 through kie first for both text and reference/edit input', () => {
    const routes = byteplusRouteContracts['seedream-4-5']!;
    expect(routes).toMatchObject([
      {
        gateway: 'kie',
        role: 'primary',
        slug: 'seedream/4.5-text-to-image',
        reference: { imageRole: 'reference' },
      },
      {
        gateway: 'openrouter',
        role: 'fallback',
        slug: 'bytedance-seed/seedream-4.5',
      },
    ]);
  });
});

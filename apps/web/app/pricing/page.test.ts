import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('pricing subscription-state wiring', () => {
  it('fails closed only for authenticated users when the subscription fetch is non-2xx', () => {
    const page = readFileSync(join(__dirname, 'page.tsx'), 'utf8');
    expect(page).toContain(
      'const planStateUnknown = !guest && (sub.status < 200 || sub.status >= 300);',
    );
    expect(page).toContain('planStateUnknown={planStateUnknown}');
  });
});

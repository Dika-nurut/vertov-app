import { describe, expect, it } from 'vitest';
import { normalizeVideoParams, byteplusRouteContracts } from '@seed/shared';

// Smoke: the byteplus package can resolve the registry from @seed/shared. This is
// the dependency the adapter-wiring step (Phase 2) relies on.
describe('registry import from @seed/shared', () => {
  it('resolves the registry + normalizer across the package boundary', () => {
    const c = byteplusRouteContracts['seedance-2-0']!.find((r) => r.role === 'primary')!;
    const r = normalizeVideoParams(c, { resolution: '1080p', duration_seconds: 5 });
    expect(r.ok).toBe(true);
  });
});

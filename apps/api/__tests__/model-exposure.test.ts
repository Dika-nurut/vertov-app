import { describe, expect, it } from 'vitest';
import { modelExposureBlockReason } from '../src/model-exposure';

const complete = {
  kind: 'image' as const,
  providerModelId: 'vendor/model',
  providerEndpoint: '/v1/generate',
  capabilities: { resolutions: ['1K'] },
};

describe('modelExposureBlockReason', () => {
  it('allows an active model only when route, capabilities, and price proof exist', () => {
    expect(modelExposureBlockReason(complete, true)).toBeNull();
  });

  it.each([
    ['missing route', { ...complete, providerModelId: '' }, 'missing_route'],
    ['missing endpoint', { ...complete, providerEndpoint: '' }, 'missing_route'],
    ['missing capabilities', { ...complete, capabilities: {} }, 'missing_capabilities'],
  ] as const)('%s is hidden fail-closed', (_label, model, expected) => {
    expect(modelExposureBlockReason(model, true)).toBe(expected);
  });

  it('hides an otherwise complete row when no active workbook price exists', () => {
    expect(modelExposureBlockReason(complete, false)).toBe('missing_active_price');
  });

  it('hides parked voice rows before they become a paid public affordance', () => {
    expect(modelExposureBlockReason({ ...complete, kind: 'voice' }, true)).toBe('unsupported_kind');
  });
});

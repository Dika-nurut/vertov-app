import { describe, expect, it } from 'vitest';
import {
  AtlasCloudAdapter,
  MockGatewayAdapter,
  MockProviderForbiddenError,
  StubBytePlusAdapter,
  StubProviderForbiddenError,
  getAdapter,
  isMockProviderAllowed,
} from '../src/index';

/**
 * BL-11 — `AI_PROVIDER=mock` is an unguarded production backdoor.
 *
 * The mock gateway returns FREE, fake assets with zero provider spend. That is
 * exactly what we want in dev/CI (and what the whole zero-spend verification
 * story leans on), but if `mock` leaks into a production NODE_ENV every user
 * silently gets free assets and revenue/credits break. The guard fails closed:
 * mock is refused in production unless the operator arms ALLOW_MOCK_IN_PROD.
 *
 * Each assertion below would FAIL on the pre-fix code, where `getAdapter('mock')`
 * unconditionally returned a `MockGatewayAdapter`.
 */
describe('BL-11: mock gateway is fail-closed in production', () => {
  it('refuses the mock gateway when NODE_ENV=production (no escape hatch)', () => {
    expect(() => getAdapter('mock', { NODE_ENV: 'production' })).toThrow(
      MockProviderForbiddenError,
    );
  });

  it('refuses mock when explicitly selected in prod', () => {
    expect(() => getAdapter('mock', { NODE_ENV: 'production' })).toThrow(
      MockProviderForbiddenError,
    );
  });

  it('permits mock in production ONLY with the explicit ALLOW_MOCK_IN_PROD hatch', () => {
    expect(getAdapter('mock', { NODE_ENV: 'production', ALLOW_MOCK_IN_PROD: '1' })).toBeInstanceOf(
      MockGatewayAdapter,
    );
    expect(
      getAdapter('mock', { NODE_ENV: 'production', ALLOW_MOCK_IN_PROD: 'true' }),
    ).toBeInstanceOf(MockGatewayAdapter);
  });

  it('still allows mock freely outside production (dev/CI/zero-spend verify)', () => {
    expect(getAdapter('mock', { NODE_ENV: 'development' })).toBeInstanceOf(MockGatewayAdapter);
    expect(getAdapter('mock', { NODE_ENV: 'test' })).toBeInstanceOf(MockGatewayAdapter);
    expect(getAdapter('mock', {})).toBeInstanceOf(MockGatewayAdapter);
  });

  it('fails closed in production when a real gateway is not live-armed', () => {
    // An unarmed gateway in prod must NOT silently serve stub fake assets for a
    // paid job — it throws so the job fails loudly (BL-11 extended to stubs).
    expect(() =>
      getAdapter('atlascloud', { NODE_ENV: 'production', ATLASCLOUD_MODE: 'stub' }),
    ).toThrow(StubProviderForbiddenError);
    // Armed gateways in prod are unaffected and return the real adapter.
    expect(
      getAdapter('atlascloud', {
        NODE_ENV: 'production',
        ATLASCLOUD_MODE: 'live',
        ATLASCLOUD_API_KEY: 'test-key',
      }),
    ).toBeInstanceOf(AtlasCloudAdapter);
    // Outside production the zero-spend stub is still the default.
    expect(
      getAdapter('atlascloud', { NODE_ENV: 'development', ATLASCLOUD_MODE: 'stub' }),
    ).toBeInstanceOf(StubBytePlusAdapter);
  });

  it('isMockProviderAllowed encodes the policy', () => {
    expect(isMockProviderAllowed({ NODE_ENV: 'production' })).toBe(false);
    expect(isMockProviderAllowed({ NODE_ENV: 'production', ALLOW_MOCK_IN_PROD: '1' })).toBe(true);
    expect(isMockProviderAllowed({ NODE_ENV: 'production', ALLOW_MOCK_IN_PROD: 'nope' })).toBe(
      false,
    );
    expect(isMockProviderAllowed({ NODE_ENV: 'development' })).toBe(true);
    expect(isMockProviderAllowed({})).toBe(true);
  });
});

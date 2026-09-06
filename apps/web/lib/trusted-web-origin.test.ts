import { describe, expect, it } from 'vitest';
import { resolveTrustedWebOrigin } from './trusted-web-origin';

describe('trusted web origin', () => {
  it('normalizes a configured public URL to its origin', () => {
    expect(
      resolveTrustedWebOrigin({
        nodeEnv: 'production',
        configuredOrigin: 'https://vertov.space/app?from=env',
        requestOrigin: 'https://attacker.example',
      }),
    ).toBe('https://vertov.space');
  });

  it('fails closed in production when the public origin is absent or invalid', () => {
    expect(
      resolveTrustedWebOrigin({ nodeEnv: 'production', requestOrigin: 'https://attacker.example' }),
    ).toBeNull();
    expect(
      resolveTrustedWebOrigin({
        nodeEnv: 'production',
        configuredOrigin: 'javascript:alert(1)',
        requestOrigin: 'https://attacker.example',
      }),
    ).toBeNull();
  });

  it('permits a local request-origin fallback outside production', () => {
    expect(
      resolveTrustedWebOrigin({ nodeEnv: 'development', requestOrigin: 'http://127.0.0.1:3000' }),
    ).toBe('http://127.0.0.1:3000');
  });
});

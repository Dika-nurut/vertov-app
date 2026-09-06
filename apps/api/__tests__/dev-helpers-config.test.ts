import { describe, expect, it } from 'vitest';
import { resolveDevHelpersEnabled } from '../src/dev-helpers-config';

describe('production dev-helper mount gate', () => {
  it('keeps helpers available outside production', () => {
    expect(resolveDevHelpersEnabled({ nodeEnv: 'development' })).toBe(true);
    expect(resolveDevHelpersEnabled({ nodeEnv: 'test' })).toBe(true);
  });

  it('does not expose helpers merely because a production secret exists', () => {
    expect(resolveDevHelpersEnabled({ nodeEnv: 'production', devAccessSecret: 'present' })).toBe(
      false,
    );
    expect(
      resolveDevHelpersEnabled({
        nodeEnv: 'production',
        devAccessSecret: 'present',
        allowProdDevHelpers: '0',
      }),
    ).toBe(false);
  });

  it('requires both an explicit opt-in and a non-empty secret for production', () => {
    expect(resolveDevHelpersEnabled({ nodeEnv: 'production', allowProdDevHelpers: '1' })).toBe(
      false,
    );
    expect(
      resolveDevHelpersEnabled({
        nodeEnv: 'production',
        devAccessSecret: '   ',
        allowProdDevHelpers: '1',
      }),
    ).toBe(false);
    expect(
      resolveDevHelpersEnabled({
        nodeEnv: 'production',
        devAccessSecret: 'present',
        allowProdDevHelpers: '1',
      }),
    ).toBe(true);
  });
});

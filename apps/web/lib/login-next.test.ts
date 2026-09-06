import { describe, expect, it } from 'vitest';
import { loginNextTarget } from './login-next';

describe('loginNextTarget', () => {
  it('honors a same-origin relative path with query', () => {
    const next = encodeURIComponent('/generate?prompt=неоновый детектив&preset=neon-rain');
    expect(loginNextTarget(`?next=${next}`)).toBe(
      '/generate?prompt=неоновый детектив&preset=neon-rain',
    );
  });

  it('falls back to /generate?onboarding=1 when next is absent or empty', () => {
    expect(loginNextTarget('')).toBe('/generate?onboarding=1');
    expect(loginNextTarget('?flash=account_deleted')).toBe('/generate?onboarding=1');
    expect(loginNextTarget('?next=')).toBe('/generate?onboarding=1');
  });

  it('rejects open-redirect shapes (absolute, protocol-relative, backslash)', () => {
    expect(loginNextTarget(`?next=${encodeURIComponent('https://evil.example/phish')}`)).toBe(
      '/generate?onboarding=1',
    );
    expect(loginNextTarget(`?next=${encodeURIComponent('//evil.example/phish')}`)).toBe(
      '/generate?onboarding=1',
    );
    expect(loginNextTarget(`?next=${encodeURIComponent('/\\evil.example')}`)).toBe(
      '/generate?onboarding=1',
    );
    expect(loginNextTarget('?next=javascript:alert(1)')).toBe('/generate?onboarding=1');
  });
});

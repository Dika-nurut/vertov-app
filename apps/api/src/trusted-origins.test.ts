import { describe, expect, it } from 'vitest';
import { isLoopbackOrigin } from '@seed/auth/trusted-origins';

/**
 * BETTER_AUTH_TRUSTED_ORIGINS is the CSRF/redirect allow-list, and `@seed/auth`
 * refuses to boot in production when it contains a loopback entry. Dev boxes
 * legitimately list 127.0.0.1/::1 next to the real origin (local e2e would
 * otherwise 403), so the guard must classify by host — not by looking for the
 * literal substring "localhost", which both misses 127.0.0.1 and would flag a
 * hostile host that merely contains the word.
 */
describe('isLoopbackOrigin', () => {
  it('accepts every loopback form the dev stack actually uses', () => {
    expect(isLoopbackOrigin('http://localhost:3000')).toBe(true);
    expect(isLoopbackOrigin('http://127.0.0.1:3000')).toBe(true);
    expect(isLoopbackOrigin('http://127.0.0.1:4310')).toBe(true);
    expect(isLoopbackOrigin('http://[::1]:3000')).toBe(true);
    expect(isLoopbackOrigin('http://0.0.0.0:8080')).toBe(true);
    expect(isLoopbackOrigin('https://LOCALHOST:3000')).toBe(true);
  });

  it('does not flag real origins', () => {
    expect(isLoopbackOrigin('https://vertov.space')).toBe(false);
    expect(isLoopbackOrigin('https://defend-notifications.trycloudflare.com')).toBe(false);
    expect(isLoopbackOrigin('https://api.vertov.space:443')).toBe(false);
  });

  it('classifies by host, so a hostile lookalike is not treated as loopback', () => {
    // The old substring check called these loopback and would have let a
    // production boot through while silently trusting an attacker's domain.
    expect(isLoopbackOrigin('https://localhost.evil.com')).toBe(false);
    expect(isLoopbackOrigin('https://127.0.0.1.evil.com')).toBe(false);
    expect(isLoopbackOrigin('https://evil.com/?next=http://localhost')).toBe(false);
  });

  it('fails closed on unparseable values', () => {
    expect(isLoopbackOrigin('localhost:3000')).toBe(true);
    expect(isLoopbackOrigin('127.0.0.1')).toBe(true);
    expect(isLoopbackOrigin('not a url')).toBe(false);
  });
});
